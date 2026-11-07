import { dismissResults, enqueueWindow, getJobs } from './data/jobs.js';
import { capturedSources, clearCapturedPdf } from './data/sources.js';
import { windowPdfs } from './browser/pdf-tabs.js';
import {
  errorMessage,
  isActive,
  UserError,
  type BackgroundRequest,
  type BackgroundResponse,
  type Settings,
  type State,
} from './shared/model.js';
import { hostPermission, validateSettings } from './shared/settings.js';
import { verifyConnection } from './services/paperless.js';
import { hasImportWork } from './shared/job-state.js';

const initialized = chrome.storage.local.setAccessLevel({
  accessLevel: 'TRUSTED_CONTEXTS',
});
let lifecycle: Promise<unknown> = Promise.resolve();

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
      } else if (
        contexts.length &&
        !(await getJobs()).some((job) => isActive(job) || hasImportWork(job))
      ) {
        await chrome.offscreen.closeDocument();
      }
    });
  lifecycle = operation;
  await operation;
}

async function badge(): Promise<void> {
  const jobs = await getJobs();
  const busy = jobs.some(isActive);
  const failed = jobs.some(
    (job) =>
      !job.dismissed &&
      (['failed', 'uncertain'].includes(job.status) ||
        job.importTask?.result?.status === 'failure'),
  );
  await chrome.action.setBadgeText({
    text: busy ? '…' : failed ? '!' : '',
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
    case 'dismiss-results':
      if (sender.url !== chrome.runtime.getURL('popup.html'))
        throw new UserError('Zugriff verweigert.');
      await dismissResults();
      await badge();
      return { ok: true, state: await state() };
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
      const next = validateSettings(message.url, message.token, previous);
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
        hostPermission(previous.url) !== hostPermission(next.url) &&
        !(await chrome.permissions.contains({
          origins: [`${new URL(previous.url).protocol}//*/*`],
        }))
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
    case 'upload-window': {
      if (sender.url !== chrome.runtime.getURL('popup.html'))
        throw new UserError('Zugriff verweigert.');
      if (!(await settings()))
        throw new UserError('Bitte richte zuerst deinen Paperless-Server ein.');
      if ((await getJobs()).some(isActive))
        throw new UserError(
          'Bitte warte, bis die laufende Übertragung abgeschlossen ist.',
        );
      const { sources, skippedLocalTabs } = await windowPdfs(
        message.windowId,
        await capturedSources(),
      );
      const localNotice = skippedLocalTabs
        ? 'Lokale Tabs wurden übersprungen. Erlaube den Zugriff auf lokale PDFs, um sie einzubeziehen.'
        : '';
      if (!sources.length)
        return {
          ok: true,
          message: localNotice || 'Keine PDF-Tabs in diesem Fenster gefunden.',
          state: await state(),
        };
      await enqueueWindow(sources);
      await offscreen(true);
      await badge();
      return { ok: true, message: localNotice, state: await state() };
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
    if (jobs.some((job) => isActive(job) || hasImportWork(job)))
      await offscreen(true);
    await badge();
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void clearCapturedPdf(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading') void clearCapturedPdf(tabId);
});
