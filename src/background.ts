import { message, t } from './shared/i18n.js';
import {
  dismissResults,
  enqueueWindow,
  getJobs,
  retryImport,
} from './data/jobs.js';
import {
  forgetPdfViewers,
  listenForPdfViewers,
  liveCaptures,
} from './browser/pdf-viewer-lifecycle.js';
import { configureNativePdfHandling } from './browser/native-fallback.js';
import { listLocalPdfIds, deleteLocalPdf } from './browser/local-pdf.js';
import { capturedSources } from './data/sources.js';
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
import { readableSource } from './shared/pdf.js';

const initialized = chrome.storage.local.setAccessLevel({
  accessLevel: 'TRUSTED_CONTEXTS',
});
let lifecycle: Promise<unknown> = Promise.resolve();
const pdfDispositions = new Map<number, { url: string; disposition: string }>();

// The MIME handler can receive the PDF body without its Content-Disposition.
// Remember just that header from the matching document response.
function rememberPdfDisposition({
  tabId,
  url,
  type,
  statusCode,
  responseHeaders,
}: chrome.webRequest.OnHeadersReceivedDetails): undefined {
  if (tabId < 0) return;
  if (type === 'main_frame') pdfDispositions.delete(tabId);
  if (statusCode < 200 || statusCode >= 300) return;
  const header = (name: string) =>
    responseHeaders?.find((item) => item.name.toLowerCase() === name)?.value;
  if (
    header('content-type')?.split(';')[0]?.trim().toLowerCase() !==
    'application/pdf'
  )
    return;
  const disposition = header('content-disposition');
  const source = readableSource(url);
  if (source && disposition)
    pdfDispositions.set(tabId, { url: source, disposition });
}

function listenForPdfNames(): void {
  const event = chrome.webRequest.onHeadersReceived;
  event.removeListener(rememberPdfDisposition);
  event.addListener(
    rememberPdfDisposition,
    {
      urls: ['http://*/*', 'https://*/*'],
      types: ['main_frame', 'sub_frame', 'object'],
    },
    ['responseHeaders'],
  );
}

listenForPdfViewers();
listenForPdfNames();
// Chrome rejects webRequest registration until the first host grant.
chrome.permissions.onAdded.addListener(({ origins }) => {
  if (origins?.length) listenForPdfNames();
});

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
    sources: await liveCaptures(),
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
    text: busy ? '…' : failed ? '×' : '',
  });
  await chrome.action.setTitle({
    title: busy ? t('badgeBusy') : failed ? t('badgeCheck') : t('sendPdf'),
  });
  await chrome.action.setBadgeBackgroundColor({
    color: failed ? '#9c452d' : '#005616',
  });
}

async function handle(
  request: BackgroundRequest,
  sender: chrome.runtime.MessageSender,
): Promise<BackgroundResponse> {
  switch (request.type) {
    case 'state':
      return { ok: true, state: await state() };
    case 'capture-context': {
      const tabId = sender.tab?.id;
      if (
        sender.url !== chrome.runtime.getURL('capture.html') ||
        tabId === undefined ||
        !sender.documentId
      )
        throw new UserError(message('accessDenied'));
      const match = pdfDispositions.get(tabId);
      if (match?.url !== request.url)
        return { ok: true, documentId: sender.documentId };
      pdfDispositions.delete(tabId);
      return {
        ok: true,
        documentId: sender.documentId,
        disposition: match.disposition,
      };
    }
    case 'dismiss-results':
      if (sender.url !== chrome.runtime.getURL('popup.html'))
        throw new UserError(message('accessDenied'));
      await dismissResults();
      await badge();
      return { ok: true, state: await state() };
    case 'retry-import': {
      if (sender.url !== chrome.runtime.getURL('popup.html'))
        throw new UserError(message('accessDenied'));
      const config = await settings();
      if (!config) throw new UserError(message('setupServer'));
      await retryImport(request.jobId, config.url);
      await offscreen(true);
      return { ok: true };
    }
    case 'settings': {
      if (sender.url !== chrome.runtime.getURL('offscreen.html'))
        throw new UserError(message('accessDenied'));
      const config = await settings();
      if (!config) throw new UserError(message('setupServer'));
      return { ok: true, settings: config };
    }
    case 'save': {
      if (sender.url !== chrome.runtime.getURL('popup.html'))
        throw new UserError(message('accessDenied'));
      if ((await getJobs()).some(isActive))
        throw new UserError(message('waitForTransfer'));
      const previous = await settings();
      const next = validateSettings(request.url, request.token, previous);
      if (
        !(await chrome.permissions.contains({
          origins: [hostPermission(next.url)],
        }))
      ) {
        throw new UserError(message('allowServer'));
      }
      await verifyConnection(next);
      if ((await getJobs()).some(isActive))
        throw new UserError(message('waitForTransfer'));
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
      await badge().catch(() => undefined);
      return { ok: true };
    case 'upload-window': {
      if (sender.url !== chrome.runtime.getURL('popup.html'))
        throw new UserError(message('accessDenied'));
      const config = await settings();
      if (!config) throw new UserError(message('setupServer'));
      if (request.serverUrl !== config.url)
        throw new UserError(message('restartUpload'));
      if ((await getJobs()).some(isActive))
        throw new UserError(message('waitForTransfer'));
      const { sources, skippedLocalTabs } = await windowPdfs(
        request.windowId,
        await liveCaptures(),
      );
      const localNotice = skippedLocalTabs ? message('localTabsSkipped') : '';
      if (!sources.length)
        return {
          ok: true,
          message: localNotice || message('noPdfTabs'),
          state: await state(),
        };
      await enqueueWindow(sources, config.url);
      await offscreen(true);
      await badge().catch(() => undefined);
      return { ok: true, message: localNotice, state: await state() };
    }
    case 'changed':
      await badge();
      return { ok: true };
    case 'idle':
      await offscreen(false);
      await badge();
      return { ok: true };
    case 'runner-stopped':
      if (sender.url !== chrome.runtime.getURL('offscreen.html'))
        throw new UserError(message('accessDenied'));
      await chrome.action.setBadgeText({ text: '×' });
      await chrome.action.setBadgeBackgroundColor({ color: '#9c452d' });
      await chrome.action.setTitle({
        title: t('badgeStopped'),
      });
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

chrome.runtime.onInstalled.addListener(() => {
  void configureNativePdfHandling();
});

async function cleanViewerFiles(): Promise<void> {
  // Snapshot files before reading live records: every new writer registers
  // its document in IndexedDB before creating its private viewer file.
  const files = await listLocalPdfIds();
  await liveCaptures();
  if (!files.length) return;
  const registered = new Set(
    (await capturedSources()).map((source) => source.documentId),
  );
  await Promise.all(
    files.filter((id) => !registered.has(id)).map(deleteLocalPdf),
  );
}

chrome.runtime.onStartup.addListener(() => {
  void configureNativePdfHandling();
  void cleanViewerFiles();
  void getJobs().then(async (jobs) => {
    if (jobs.some((job) => isActive(job) || hasImportWork(job)))
      await offscreen(true);
    await badge();
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  pdfDispositions.delete(tabId);
  void forgetPdfViewers(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, change) => {
  // Chrome also reports a load for a #page or #zoom change.
  if (change.status === 'complete') void liveCaptures(tabId);
});
