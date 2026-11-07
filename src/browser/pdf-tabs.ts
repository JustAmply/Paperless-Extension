import { sourceKey, UserError, type Source } from '../shared/model.js';
import { readableSource } from '../shared/pdf.js';
import { hostPermission } from '../shared/settings.js';

export function sourcePermission(url: string): string {
  return url.startsWith('file:') ? 'file:///*' : hostPermission(url);
}

export async function windowSources(windowId: number): Promise<Source[]> {
  const tabs = await chrome.tabs.query({ windowId });
  return tabs.flatMap((tab) => {
    const url = readableSource(tab.url);
    return tab.id !== undefined && url ? [{ url, tabId: tab.id }] : [];
  });
}

export async function isPdfTab(source: Source): Promise<boolean> {
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
): Promise<Source[]> {
  const sources = await windowSources(windowId);
  const origins = [
    ...new Set(sources.map((source) => sourcePermission(source.url))),
  ];
  if (origins.length && !(await chrome.permissions.contains({ origins }))) {
    throw new UserError(
      'Der Webseitenzugriff fehlt. Bitte klicke erneut auf „Alle PDF-Tabs hochladen“ und erlaube den Zugriff in Chrome.',
    );
  }
  if (
    sources.some((source) => source.url.startsWith('file:')) &&
    !(await chrome.extension.isAllowedFileSchemeAccess())
  ) {
    throw new UserError(
      'Aktiviere unter chrome://extensions → Paperless Upload → Details den „Zugriff auf Datei-URLs“, um lokale PDF-Tabs hochzuladen.',
    );
  }
  const pdfs = new Map<string, Source>();
  for (const source of sources) {
    const cached = captured.find(
      (pdf) => pdf.tabId === source.tabId && pdf.url === source.url,
    );
    if (cached) {
      pdfs.set(sourceKey(cached), cached);
      continue;
    }
    if (await isPdfTab(source)) pdfs.set(sourceKey(source), source);
  }
  return [...pdfs.values()];
}
