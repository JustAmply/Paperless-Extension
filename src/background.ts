import {
  dismissFailures,
  enqueueWindow,
  getJobs,
  updateImportResult,
} from './data/jobs.js';
import { capturedSources, clearCapturedPdf } from './data/sources.js';
import { windowPdfs } from './browser/pdf-tabs.js';
import {
  errorMessage,
  isActive,
  sourceKey,
  UserError,
  type BackgroundRequest,
  type BackgroundResponse,
  type Settings,
  type State,
} from './shared/model.js';
import { hostPermission, validateSettings } from './shared/settings.js';
import { verifyConnection } from './services/paperless.js';
import { pdfName } from './shared/pdf.js';
import { checkImport } from './services/import-task.js';

const initialized = chrome.storage.local.setAccessLevel({
  accessLevel: 'TRUSTED_CONTEXTS',
});
let lifecycle: Promise<unknown> = Promise.resolve();
const importChecks = new Map<string, Promise<void>>();

async function refreshImport(jobId: string): Promise<void> {
  const config = await settings();
  const job = (await getJobs()).find((item) => item.id === jobId);
  if (!config || job?.status !== 'accepted' || !job.importTask) return;
  if (config.url !== job.importTask.serverUrl)
    throw new UserError(
      'Dieser Upload gehört zu einem anderen Paperless-Server.',
    );
  if (
    job.importTask.result &&
    ['success', 'failure', 'duplicate'].includes(job.importTask.result.status)
  )
    return;
  const result = await checkImport(config, job.importTask.taskId);
  await updateImportResult(job, result);
}

async function settings(): Promise<Settings | undefined> {
  await initialized;
  const stored = await chrome.storage.local.get('settings');
  return stored['settings'] as Settings | undefined;
}

async function state(): Promise<State> {
  const config = await settings();
  return {
    settings: { url: config?.url ?? '', configured: Boolean(config) },
    jobs: await getJobs(),
    sources: await capturedSources(),
  };
}

async function offscreen(start: boolean): Promise<void> {
  const operation = lifecycle
    .catch(() => undefined)
    .then(async () => {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
      });
      if (start) {
        if (!contexts.length) {
          await chrome.offscreen.createDocument({
            url: 'offscreen.html',
            reasons: [chrome.offscreen.Reason.BLOBS],
            justification:
              'Read staged PDF blobs and send multipart uploads independently of the popup lifetime.',
          });
        }
        await chrome.runtime.sendMessage({
          target: 'offscreen',
          type: 'process',
        });
      } else if (contexts.length && !(await getJobs()).some(isActive)) {
        await chrome.offscreen.closeDocument();
      }
    });
  lifecycle = operation;
  await operation;
}

async function badge(): Promise<void> {
  const jobs = await getJobs();
  const busy = jobs.some(isActive);
  const failed = jobs.some((job) =>
    ['failed', 'uncertain'].includes(job.status),
  );
  await chrome.action.setBadgeText({
    text: busy
      ? '…'
      : failed
        ? '!'
        : jobs.some((job) => job.status === 'accepted')
          ? '✓'
          : '',
  });
  await chrome.action.setBadgeBackgroundColor({
    color: failed ? '#9c452d' : '#005616',
  });
}

async function handle(
  message: BackgroundRequest,
  sender: chrome.runtime.MessageSender,
): Promise<BackgroundResponse> {
  switch (message.type) {
    case 'state':
      return { ok: true, state: await state() };
    case 'dismiss-failures':
      if (sender.url !== chrome.runtime.getURL('popup.html'))
        throw new UserError('Zugriff verweigert.');
      await dismissFailures();
      await badge();
      return { ok: true, state: await state() };
    case 'check-import': {
      if (sender.url !== chrome.runtime.getURL('popup.html'))
        throw new UserError('Zugriff verweigert.');
      let check = importChecks.get(message.jobId);
      if (!check) {
        check = refreshImport(message.jobId).finally(() => {
          importChecks.delete(message.jobId);
        });
        importChecks.set(message.jobId, check);
      }
      await check;
      return { ok: true, state: await state() };
    }
    case 'settings': {
      if (sender.url !== chrome.runtime.getURL('offscreen.html'))
        throw new UserError('Zugriff verweigert.');
      const config = await settings();
      if (!config)
        throw new UserError('Bitte richte zuerst deinen Paperless-Server ein.');
      return { ok: true, settings: config };
    }
    case 'save': {
      if (sender.url !== chrome.runtime.getURL('popup.html'))
        throw new UserError('Zugriff verweigert.');
      if ((await getJobs()).some(isActive))
        throw new UserError(
          'Bitte warte, bis die Übertragung abgeschlossen ist.',
        );
      const previous = await settings();
      const next = validateSettings(
        message.url,
        message.token || previous?.token || '',
      );
      if (
        !(await chrome.permissions.contains({
          origins: [hostPermission(next.url)],
        }))
      ) {
        throw new UserError(
          'Bitte erlaube den Zugriff auf deinen Paperless-Server.',
        );
      }
      await verifyConnection(next);
      await chrome.storage.local.set({ settings: next });
      if (
        previous &&
        hostPermission(previous.url) !== hostPermission(next.url)
      ) {
        await chrome.permissions.remove({
          origins: [hostPermission(previous.url)],
        });
      }
      return { ok: true, state: await state() };
    }
    case 'process':
      await offscreen(true);
      await badge();
      return { ok: true };
    case 'scan-window': {
      if (sender.url !== chrome.runtime.getURL('popup.html'))
        throw new UserError('Zugriff verweigert.');
      const captured = await capturedSources();
      const sources = await windowPdfs(message.windowId, captured);
      return {
        ok: true,
        sources: sources.map(
          (source) =>
            captured.find(
              (pdf) =>
                pdf.tabId === source.tabId &&
                sourceKey(pdf) === sourceKey(source),
            ) ?? {
              ...source,
              name: pdfName(source.url),
              availability: 'unchecked' as const,
            },
        ),
      };
    }
    case 'upload-window': {
      if (sender.url !== chrome.runtime.getURL('popup.html'))
        throw new UserError('Zugriff verweigert.');
      if (!(await settings()))
        throw new UserError('Bitte richte zuerst deinen Paperless-Server ein.');
      if ((await getJobs()).some(isActive))
        throw new UserError(
          'Bitte warte, bis die laufende Übertragung abgeschlossen ist.',
        );
      const sources = await windowPdfs(
        message.windowId,
        await capturedSources(),
      );
      if (
        !message.sources.length ||
        message.sources.some(
          (selected) =>
            !sources.some(
              (source) =>
                source.tabId === selected.tabId &&
                sourceKey(source) === sourceKey(selected),
            ),
        )
      )
        throw new UserError(
          'Die ausgewählten PDF-Tabs haben sich geändert. Bitte öffne die Tab-Auswahl erneut.',
        );
      const selected = sources.filter((source) =>
        message.sources.some(
          (item) =>
            item.tabId === source.tabId &&
            sourceKey(item) === sourceKey(source),
        ),
      );
      await enqueueWindow(selected);
      await offscreen(true);
      await badge();
      return { ok: true, state: await state() };
    }
    case 'changed':
      await badge();
      return { ok: true };
    case 'idle':
      await badge();
      await offscreen(false);
      return { ok: true };
  }
}

chrome.runtime.onMessage.addListener(
  (message: BackgroundRequest, sender, sendResponse) => {
    if (
      sender.id !== chrome.runtime.id ||
      message?.target !== 'background' ||
      !sender.url?.startsWith(chrome.runtime.getURL(''))
    )
      return false;
    void handle(message, sender).then(sendResponse, (error: unknown) =>
      sendResponse({ ok: false, error: errorMessage(error) }),
    );
    return true;
  },
);

chrome.runtime.onStartup.addListener(() => {
  void clearCapturedPdf();
  void getJobs().then(async (jobs) => {
    if (jobs.some(isActive)) await offscreen(true);
    await badge();
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void clearCapturedPdf(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading') void clearCapturedPdf(tabId);
});
