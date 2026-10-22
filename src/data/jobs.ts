import {
  isActive,
  sourceKey,
  MAX_BATCH_FILES,
  UserError,
  type Job,
  type Source,
} from '../shared/model.js';
import { pdfName, validatePdf } from '../shared/pdf.js';
import { openDatabase as open } from './database.js';
import type { CapturedPdf } from './sources.js';

async function transaction<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('jobs', mode);
    const request = run(tx.objectStore('jobs'));
    tx.oncomplete = () => resolve(request.result);
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
  });
}

export async function getJobs(): Promise<Job[]> {
  const jobs = await transaction<Job[]>('readonly', (store) => store.getAll());
  return jobs.sort((a, b) => a.createdAt - b.createdAt);
}

export async function getFile(id: string): Promise<Blob | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const request = db.transaction('files').objectStore('files').get(id);
    request.onsuccess = () => resolve(request.result as Blob | undefined);
    request.onerror = () => reject(request.error);
  });
}

export async function deleteFile(id: string): Promise<void> {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('files', 'readwrite');
    tx.objectStore('files').delete(id);
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
}

export async function putJob(job: Job): Promise<void> {
  await transaction('readwrite', (store) => store.put(job));
}

export async function enqueue(input: File[] | Source): Promise<void> {
  if (Array.isArray(input)) {
    if (!input.length || input.length > MAX_BATCH_FILES) {
      throw new UserError('Bitte wähle 1 bis 10 PDF-Dateien aus.');
    }
    for (const file of input) await validatePdf(file);
  }
  await stage(Array.isArray(input) ? input : [input], false);
}

export async function enqueueWindow(sources: Source[]): Promise<void> {
  await stage(sources, true);
}

async function stage(
  entries: (File | Source)[],
  preserveUploads: boolean,
): Promise<void> {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['jobs', 'files', 'sources'], 'readwrite');
    const store = tx.objectStore('jobs');
    const current = store.getAll();
    let busy = false;
    current.onsuccess = () => {
      const jobs: Job[] = current.result;
      if (jobs.some(isActive)) {
        busy = true;
        tx.abort();
        return;
      }
      const completed = new Map(
        jobs.flatMap((job) =>
          job.source && ['accepted', 'uncertain'].includes(job.status)
            ? [[sourceKey(job.source), job] as const]
            : [],
        ),
      );
      store.clear();
      tx.objectStore('files').clear();
      entries.forEach((item, index) => {
        const isFile = item instanceof File;
        const kept =
          !isFile && preserveUploads
            ? completed.get(sourceKey(item))
            : undefined;
        const job: Job =
          !isFile && kept
            ? { ...kept, source: item }
            : {
                id: crypto.randomUUID(),
                name: isFile ? item.name : pdfName(item.url),
                status: 'queued',
                message: 'Wartet auf Übertragung',
                createdAt: Date.now() + index,
                ...(!isFile ? { source: item } : {}),
              };
        store.add(job);
        if (isFile) tx.objectStore('files').put(item, job.id);
        else if (!kept) {
          const captured = tx.objectStore('sources').get(item.tabId);
          captured.onsuccess = () => {
            const pdf = captured.result as CapturedPdf | undefined;
            if (
              item.fingerprint &&
              (!pdf ||
                pdf.url !== item.url ||
                pdf.fingerprint !== item.fingerprint)
            ) {
              job.status = 'failed';
              job.message =
                'Die PDF im Tab hat sich geändert oder wurde geschlossen. Bitte öffne die Erweiterung erneut.';
              store.put(job);
              return;
            }
            if (!pdf || pdf.url !== item.url) return;
            job.name = pdf.name;
            job.source = { ...item, fingerprint: pdf.fingerprint };
            if (pdf.file) tx.objectStore('files').put(pdf.file, job.id);
            else {
              job.status = 'failed';
              job.message =
                pdf.error ??
                'Die PDF wird noch geladen. Bitte warte kurz und versuche es erneut.';
            }
            store.put(job);
          };
        }
      });
    };
    tx.oncomplete = () => resolve();
    tx.onabort = () =>
      reject(
        busy
          ? new UserError(
              'Bitte warte, bis die laufende Übertragung abgeschlossen ist.',
            )
          : tx.error,
      );
    tx.onerror = () => reject(tx.error);
  });
}
