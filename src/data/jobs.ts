import {
  isActive,
  MAX_BATCH_FILES,
  UserError,
  type Job,
  type Source,
} from '../shared/model.js';
import { pdfName, validatePdf } from '../shared/pdf.js';

let database: Promise<IDBDatabase> | undefined;

function open(): Promise<IDBDatabase> {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('paperless-upload', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('jobs', { keyPath: 'id' });
      request.result.createObjectStore('files');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return database;
}

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
  const files = Array.isArray(input) ? input : undefined;
  if (files) {
    if (!files.length || files.length > MAX_BATCH_FILES) {
      throw new UserError('Bitte wähle 1 bis 10 PDF-Dateien aus.');
    }
    for (const file of files) await validatePdf(file);
  }
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['jobs', 'files'], 'readwrite');
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
      store.clear();
      tx.objectStore('files').clear();
      const sources = Array.isArray(input) ? input : [input];
      sources.forEach((item, index) => {
        const isFile = item instanceof File;
        const job: Job = {
          id: crypto.randomUUID(),
          name: isFile ? item.name : pdfName(item.url),
          status: 'queued',
          message: 'Wartet auf Übertragung',
          createdAt: Date.now() + index,
          ...(!isFile ? { source: item } : {}),
        };
        store.add(job);
        if (isFile) tx.objectStore('files').put(item, job.id);
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
