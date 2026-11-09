import type { Source, SourceInfo } from '../shared/model.js';
import { openDatabase } from './database.js';

const MAX_CACHE_BYTES = 512 * 1024 * 1024;
const MAX_CACHE_FILES = 25;

export interface CapturedPdf extends Source {
  fingerprint: string;
  name: string;
  createdAt: number;
  file?: Blob;
  error?: string;
}

const unavailable =
  'Die zwischengespeicherte PDF ist nicht mehr verfügbar. Speichere sie im PDF-Viewer und ziehe sie hier hinein.';

export function capturePdf(pdf: CapturedPdf): Promise<void> {
  return writeCapture(pdf);
}

export function finishPdfCapture(
  pdf: CapturedPdf,
  loadingFingerprint: string,
): Promise<void> {
  return writeCapture(pdf, loadingFingerprint);
}

async function writeCapture(
  pdf: CapturedPdf,
  loadingFingerprint?: string,
): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('sources', 'readwrite');
    const store = tx.objectStore('sources');
    const request = store.getAll();
    request.onsuccess = () => {
      const records = request.result as CapturedPdf[];
      if (loadingFingerprint !== undefined) {
        const current = records.find((item) => item.tabId === pdf.tabId);
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
            item.tabId !== pdf.tabId && item.file !== undefined,
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
        store.put({ ...metadata, error: unavailable });
      }
      store.put(pdf);
    };
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
}

export async function clearCapturedPdf(tabId?: number): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('sources', 'readwrite');
    const store = tx.objectStore('sources');
    if (tabId === undefined) store.clear();
    else store.delete(tabId);
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
}

export async function capturedSources(): Promise<SourceInfo[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction('sources').objectStore('sources').getAll();
    request.onsuccess = () =>
      resolve(
        (request.result as CapturedPdf[]).map(
          ({ tabId, url, fingerprint, file, error }) => ({
            tabId,
            url,
            fingerprint,
            availability: file ? 'ready' : error ? 'unavailable' : 'loading',
            ...(error ? { error } : {}),
          }),
        ),
      );
    request.onerror = () => reject(request.error);
  });
}
