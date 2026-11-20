import { message } from '../shared/i18n.js';
import {
  sourceKey,
  UserError,
  type Source,
  type SourceInfo,
} from '../shared/model.js';
import { documentSource, readableSource } from '../shared/pdf.js';
import { hostPermission } from '../shared/settings.js';

const TAB_INSPECTION_BATCH_SIZE = 8;

export async function canAccessFileTabs(): Promise<boolean> {
  return (
    (await chrome.extension.isAllowedFileSchemeAccess()) &&
    (await chrome.permissions.contains({ origins: ['file:///*'] }))
  );
}

export async function windowSources(windowId: number): Promise<Source[]> {
  const tabs = await chrome.tabs.query({ windowId });
  return tabs.flatMap((tab) => {
    const source = tabSource(tab);
    return source ? [source] : [];
  });
}

function tabUrl(url: string | undefined): string | undefined {
  // A portal can open a blank tab and add its PDF viewer to that document.
  return url?.split('#')[0] === 'about:blank'
    ? 'about:blank'
    : documentSource(url);
}

export function tabSource(
  tab: chrome.tabs.Tab | undefined,
): Source | undefined {
  const url = tabUrl(tab?.url);
  return tab?.id !== undefined && url ? { tabId: tab.id, url } : undefined;
}

// Runs in the isolated world of the tab's top document.
function inspectDocument(
  embeddedUrl: string | null,
  saveChannel: string | null,
) {
  const viewers = () =>
    Array.from(document.querySelectorAll('iframe, embed, object'));
  const matches = (element: Element) => {
    let url: string;
    // A redirected frame can show a different URL from its src attribute.
    if (element instanceof HTMLIFrameElement)
      url = element.contentDocument?.URL ?? element.src;
    else if (element instanceof HTMLObjectElement)
      url = element.contentDocument?.URL ?? element.data;
    else if (element instanceof HTMLEmbedElement) url = element.src;
    else return false;
    return url.split('#')[0] === embeddedUrl;
  };
  const visible = (element: Element) => {
    const { width, height } = element.getBoundingClientRect();
    return (
      width > 0 &&
      height > 0 &&
      element.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })
    );
  };
  const viewer =
    embeddedUrl === null
      ? undefined
      : viewers().find((element) => matches(element) && visible(element));
  const result = {
    type: document.contentType,
    url: document.URL,
    embedded: Boolean(viewer),
    acceptsSaveShortcut: false,
  };
  if (!viewer || !saveChannel) return result;

  const isFullPageViewer = () => {
    const bounds = viewer.getBoundingClientRect();
    // Another visible frame or a second capture at the same URL is ambiguous.
    const anotherViewer = viewers().some(
      (element) => element !== viewer && (matches(element) || visible(element)),
    );
    return (
      !anotherViewer &&
      matches(viewer) &&
      visible(viewer) &&
      bounds.left <= 0 &&
      bounds.top <= 0 &&
      bounds.right >= innerWidth &&
      bounds.bottom >= innerHeight &&
      document.elementFromPoint(innerWidth / 2, innerHeight / 2) === viewer
    );
  };
  if (!isFullPageViewer()) return result;

  const connect = (port: chrome.runtime.Port) => {
    if (port.name !== saveChannel) return;
    chrome.runtime.onConnect.removeListener(connect);
    const save = (event: KeyboardEvent) => {
      if (
        !event.isTrusted ||
        event.defaultPrevented ||
        event.key.toLowerCase() !== 's' ||
        event.ctrlKey === event.metaKey ||
        event.altKey ||
        event.shiftKey ||
        document.activeElement !== document.body ||
        document.body.isContentEditable ||
        !isFullPageViewer()
      )
        return;
      event.preventDefault();
      if (!event.repeat) port.postMessage('save');
    };
    window.addEventListener('keydown', save);
    port.onDisconnect.addListener(() =>
      window.removeEventListener('keydown', save),
    );
  };
  chrome.runtime.onConnect.addListener(connect);
  result.acceptsSaveShortcut = true;
  return result;
}

export async function inspectPdfTab(
  tabId: number,
  embeddedUrl: string | null,
  saveChannel: string | null = null,
) {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: inspectDocument,
      args: [embeddedUrl, saveChannel],
    });
    return (
      result?.result && { ...result.result, documentId: result.documentId }
    );
  } catch {
    // The tab can be inaccessible, close, or navigate into a protected page.
    return undefined;
  }
}

export async function detectTabPdf(
  tab: Source,
  capture?: SourceInfo,
): Promise<Source | SourceInfo | undefined> {
  if (capture && !capture.embedded && capture.url === tab.url) return capture;
  if (!capture?.embedded && !readableSource(tab.url)) return undefined;
  const inspected = await inspectPdfTab(
    tab.tabId,
    capture?.embedded ? capture.url : null,
  );
  if (!inspected || tabUrl(inspected.url) !== tab.url) return undefined;
  if (capture?.embedded) return inspected.embedded ? capture : undefined;
  if (inspected.type !== 'application/pdf') return undefined;
  // The MIME handler may be reading the original response before its cache
  // record is visible. A GET here could consume or replay a protected link.
  const handlers = await chrome.runtime.getContexts({
    tabIds: [tab.tabId],
    documentUrls: [chrome.runtime.getURL('capture.html')],
  });
  return handlers.length ? undefined : tab;
}

export async function windowPdfs(
  windowId: number,
  captured: SourceInfo[] = [],
): Promise<{ sources: Source[]; skippedLocalTabs: boolean }> {
  const sources = await windowSources(windowId);
  const skippedLocalTabs =
    sources.some((source) => source.url.startsWith('file:')) &&
    !(await canAccessFileTabs());
  const origins = [
    ...new Set(
      sources
        .filter((source) => /^https?:/.test(source.url))
        .map((source) => hostPermission(source.url)),
    ),
  ];
  if (origins.length && !(await chrome.permissions.contains({ origins }))) {
    throw new UserError(message('allowWebsites'));
  }
  const pdfs = new Map<string, Source>();
  const capturesByTab = new Map(captured.map((pdf) => [pdf.tabId, pdf]));
  const candidates = sources.filter(
    (source) => !skippedLocalTabs || !source.url.startsWith('file:'),
  );
  for (
    let offset = 0;
    offset < candidates.length;
    offset += TAB_INSPECTION_BATCH_SIZE
  ) {
    const batch = candidates.slice(offset, offset + TAB_INSPECTION_BATCH_SIZE);
    const results = await Promise.all(
      batch.map((source) =>
        detectTabPdf(source, capturesByTab.get(source.tabId)),
      ),
    );
    for (const pdf of results) {
      if (pdf) pdfs.set(sourceKey(pdf), pdf);
    }
  }
  return { sources: [...pdfs.values()], skippedLocalTabs };
}
