import { message } from '../shared/i18n.js';
import {
  sourceKey,
  UserError,
  type Source,
  type SourceInfo,
} from '../shared/model.js';
import { documentSource, readableSource } from '../shared/pdf.js';
import { hostPermission } from '../shared/settings.js';
import { isLocalPdfViewer } from './local-pdf.js';

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
  const base = url?.split('#')[0];
  if (base === 'about:blank' || (base && isLocalPdfViewer(base))) return base;
  return documentSource(url);
}

export function tabSource(
  tab: chrome.tabs.Tab | undefined,
): Source | undefined {
  const url = tabUrl(tab?.url);
  return tab?.id !== undefined && url ? { tabId: tab.id, url } : undefined;
}

// Runs in the isolated world of the tab's top document.
function inspectDocument(embeddedUrl: string | null) {
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
  return {
    type: document.contentType,
    url: document.URL,
    embedded:
      embeddedUrl !== null &&
      Array.from(document.querySelectorAll('iframe, embed, object')).some(
        (element) => matches(element) && visible(element),
      ),
  };
}

async function inspectPdfTab(tabId: number, embeddedUrl: string | null) {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: inspectDocument,
      args: [embeddedUrl],
    });
    return result?.result;
  } catch {
    // The tab can be inaccessible, close, or navigate into a protected page.
    return undefined;
  }
}

export async function detectTabPdf(
  tab: Source,
  capture?: SourceInfo,
): Promise<Source | SourceInfo | undefined> {
  if (isLocalPdfViewer(tab.url))
    return capture?.tabId === tab.tabId &&
      !capture.embedded &&
      capture.viewerUrl === tab.url
      ? capture
      : undefined;
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
      if (pdf && !('availability' in pdf && pdf.availability === 'loading'))
        pdfs.set(sourceKey(pdf), pdf);
    }
  }
  return { sources: [...pdfs.values()], skippedLocalTabs };
}
