import { sourceKey, UserError, type Source } from '../shared/model.js';
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
    const url = documentSource(tab.url);
    return tab.id !== undefined && url ? [{ url, tabId: tab.id }] : [];
  });
}

export async function isPdfTab(source: Source): Promise<boolean> {
  if (!readableSource(source.url)) return false;
  try {
    // Inspect the top-level document, not the viewer's protected frames.
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: source.tabId },
      func: () => ({ type: document.contentType, url: document.URL }),
    });
    return (
      result?.result?.type === 'application/pdf' &&
      readableSource(result.result.url) === source.url
    );
  } catch {
    // The tab can be inaccessible, close, or navigate into a protected page.
    return false;
  }
}

export async function windowPdfs(
  windowId: number,
  captured: Source[] = [],
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
    throw new UserError(
      'Der Webseitenzugriff fehlt. Bitte klicke erneut auf „Alle PDF-Tabs hochladen“ und erlaube den Zugriff in Chrome.',
    );
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
      batch.map(async (source) => {
        const cached = capturesByTab.get(source.tabId);
        if (cached?.url === source.url) return cached;
        return (await isPdfTab(source)) ? source : undefined;
      }),
    );
    for (const pdf of results) {
      if (pdf) pdfs.set(sourceKey(pdf), pdf);
    }
  }
  return { sources: [...pdfs.values()], skippedLocalTabs };
}
