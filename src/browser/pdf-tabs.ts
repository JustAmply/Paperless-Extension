import { UserError, type Source } from '../shared/model.js';
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

export async function windowPdfs(windowId: number): Promise<Source[]> {
  const sources = await windowSources(windowId);
  const origins = [
    ...new Set(sources.map((source) => sourcePermission(source.url))),
  ];
  if (origins.length && !(await chrome.permissions.contains({ origins }))) {
    throw new UserError(
      'Die Tabs haben sich geändert oder der Zugriff fehlt. Bitte klicke erneut auf „PDF-Tabs hochladen“.',
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
    try {
      // The top-level PDF embedder exposes its MIME type; the viewer's own
      // protected extension frames are neither inspected nor modified.
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: source.tabId },
        func: () => ({ type: document.contentType, url: document.URL }),
      });
      if (
        result?.result?.type === 'application/pdf' &&
        readableSource(result.result.url) === source.url
      ) {
        pdfs.set(source.url, source);
      }
    } catch {
      // Tabs can close or navigate into a protected page during the scan.
    }
  }
  return [...pdfs.values()];
}
