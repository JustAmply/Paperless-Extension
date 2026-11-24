import { message, type LocalizedMessage } from '../shared/i18n.js';
import { UserError, type Source, type SourceInfo } from '../shared/model.js';
import {
  deleteLocalPdf,
  localPdfUrl,
  writeLocalPdf,
} from '../browser/local-pdf.js';
import { openDatabase } from './database.js';

const MAX_CACHE_BYTES = 512 * 1024 * 1024;
const MAX_CACHE_FILES = 25;

export interface CapturedPdf extends Source {
  viewerUrl?: string;
  embedded?: boolean;
  fingerprint: string;
  name: string;
  createdAt: number;
  file?: Blob;
  error?: LocalizedMessage | string;
}

export function captureKey(source: Source): string | number {
  return source.documentId ?? source.tabId;
}

function matchesCapturedFile(
  pdf: CapturedPdf | undefined,
  source: SourceInfo,
): pdf is CapturedPdf & { file: Blob } {
  // A standalone tab can share the original viewer's document ID.
  return Boolean(
    pdf?.file &&
    captureKey(pdf) === captureKey(source) &&
    pdf.url === source.url &&
    pdf.fingerprint === source.fingerprint,
  );
}

export async function getCapturedFile(
  source: SourceInfo,
): Promise<{ file: Blob; name: string } | undefined> {
  const pdf = await readCapture(captureKey(source));
  if (matchesCapturedFile(pdf, source))
    return { file: pdf.file, name: pdf.name };
  return undefined;
}

export async function prepareEmbeddedPdfTab(
  source: SourceInfo,
): Promise<string> {
  const id = source.documentId;
  if (!id || !source.embedded) throw new UserError(message('tabPdfChanged'));
  return navigator.locks.request(`paperless-pdf-${id}`, async () => {
    const pdf = await readCapture(id);
    if (!matchesCapturedFile(pdf, source) || !pdf.embedded)
      throw new UserError(message('tabPdfChanged'));
    const url = localPdfUrl(id, pdf.name);
    if (pdf.viewerUrl === url) return url;
    try {
      await writeLocalPdf(id, pdf.name, pdf.file);
      const db = await openDatabase();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('sources', 'readwrite');
        const store = tx.objectStore('sources');
        const read = store.get(id);
        let linked = false;
        read.onsuccess = () => {
          const current = read.result as CapturedPdf | undefined;
          if (matchesCapturedFile(current, source) && current.embedded) {
            store.put({ ...current, viewerUrl: url }, id);
            linked = true;
          }
        };
        tx.oncomplete = () =>
          linked ? resolve() : reject(new UserError(message('tabPdfChanged')));
        tx.onabort = () => reject(tx.error);
      });
    } catch (error) {
      await deleteLocalPdf(id);
      throw error;
    }
    return url;
  });
}

async function readCapture(
  key: string | number,
): Promise<CapturedPdf | undefined> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction('sources').objectStore('sources').get(key);
    request.onsuccess = () =>
      resolve(request.result as CapturedPdf | undefined);
    request.onerror = () => reject(request.error);
  });
}

const unavailable = message('cacheUnavailable');

export function capturePdf(pdf: CapturedPdf): Promise<boolean> {
  return writeCapture(pdf);
}

export function finishPdfCapture(
  pdf: CapturedPdf,
  loadingFingerprint: string,
): Promise<boolean> {
  return writeCapture(pdf, loadingFingerprint);
}

async function writeCapture(
  pdf: CapturedPdf,
  loadingFingerprint?: string,
): Promise<boolean> {
  const db = await openDatabase();
  return new Promise<boolean>((resolve, reject) => {
    let written = false;
    const tx = db.transaction('sources', 'readwrite');
    const store = tx.objectStore('sources');
    // The first write from a new viewer supersedes its version 2 tab entry.
    if (pdf.documentId && loadingFingerprint === undefined)
      store.delete(pdf.tabId);
    const request = store.getAll();
    request.onsuccess = () => {
      const records = request.result as CapturedPdf[];
      const key = captureKey(pdf);
      if (loadingFingerprint !== undefined) {
        const current = records.find((item) => captureKey(item) === key);
        // Navigation or a newer capture may have invalidated the loading record.
        if (
          current?.fingerprint !== loadingFingerprint ||
          current.file ||
          current.error
        )
          return;
      }
      const previous = records
        .filter(
          (item): item is CapturedPdf & { file: Blob } =>
            captureKey(item) !== key && item.file !== undefined,
        )
        .sort((a, b) => a.createdAt - b.createdAt);
      let bytes = previous.reduce(
        (sum, item) => sum + item.file.size,
        pdf.file?.size ?? 0,
      );
      let files = previous.length + (pdf.file ? 1 : 0);
      for (const item of previous) {
        if (bytes <= MAX_CACHE_BYTES && files <= MAX_CACHE_FILES) break;
        bytes -= item.file.size;
        files--;
        const { file: _file, ...metadata } = item;
        store.put({ ...metadata, error: unavailable }, captureKey(item));
      }
      store.put(pdf, key);
      written = true;
    };
    tx.oncomplete = () => resolve(written);
    tx.onabort = () => reject(tx.error);
  });
}

export async function clearCapturedPdf(tabId?: number): Promise<void> {
  await deleteCaptures(await capturedSources(tabId));
}

export async function capturedSources(tabId?: number): Promise<SourceInfo[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const store = db.transaction('sources').objectStore('sources');
    const request =
      tabId === undefined ? store.getAll() : store.index('tabId').getAll(tabId);
    request.onsuccess = () =>
      resolve(
        (request.result as CapturedPdf[]).map(
          ({
            tabId,
            url,
            fingerprint,
            file,
            error,
            embedded,
            documentId,
            viewerUrl,
          }) => ({
            tabId,
            url,
            fingerprint,
            ...(documentId ? { documentId } : {}),
            ...(viewerUrl ? { viewerUrl } : {}),
            ...(embedded ? { embedded } : {}),
            availability: file ? 'ready' : error ? 'unavailable' : 'loading',
            ...(error ? { error } : {}),
          }),
        ),
      );
    request.onerror = () => reject(request.error);
  });
}

export async function deleteCaptures(sources: SourceInfo[]): Promise<void> {
  if (!sources.length) return;
  // Remove viewer files before their metadata so an interrupted cleanup can
  // be resumed on the next sweep.
  await Promise.all(
    sources.map((source) =>
      source.viewerUrl && source.documentId
        ? deleteLocalPdf(source.documentId)
        : undefined,
    ),
  );
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('sources', 'readwrite');
    const store = tx.objectStore('sources');
    for (const source of sources) store.delete(captureKey(source));
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
}
