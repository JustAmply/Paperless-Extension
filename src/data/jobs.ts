import {
  isActive,
  sourceKey,
  MAX_BATCH_BYTES,
  UserError,
  type Job,
  type Source,
  type ImportResult,
} from '../shared/model.js';
import { pdfName, validatePdf } from '../shared/pdf.js';
import { openDatabase as open } from './database.js';
import { captureKey, type CapturedPdf } from './sources.js';
import {
  canDismissJob,
  canRetryImport,
  hasImportWork,
  isPreviousUpload,
} from '../shared/job-state.js';

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

export async function finishJob(job: Job): Promise<void> {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['jobs', 'files'], 'readwrite');
    tx.objectStore('jobs').put(job);
    tx.objectStore('files').delete(job.id);
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
}

export async function putJob(job: Job): Promise<void> {
  await transaction('readwrite', (store) => store.put(job));
}

export async function updateImportResult(
  job: Job,
  result: ImportResult,
): Promise<void> {
  await transaction('readwrite', (store) => {
    const request = store.get(job.id);
    request.onsuccess = () => {
      const current = request.result as Job | undefined;
      // A new upload batch may have replaced this job while the GET was in flight.
      if (
        current?.status === 'accepted' &&
        current.importTask &&
        current.importTask.taskId === job.importTask?.taskId &&
        current.importTask.serverUrl === job.importTask.serverUrl
      ) {
        store.put({
          ...current,
          importTask: { ...current.importTask, result, checkedAt: Date.now() },
        });
      }
    };
    return request;
  });
}

export async function retryImport(
  id: string,
  serverUrl: string,
): Promise<void> {
  let scheduled = false;
  await transaction('readwrite', (store) => {
    const request = store.get(id);
    request.onsuccess = () => {
      const job = request.result as Job | undefined;
      if (!job?.importTask || !canRetryImport(job, serverUrl)) return;
      store.put({
        ...job,
        importTask: {
          taskId: job.importTask.taskId,
          serverUrl,
          startedAt: Date.now(),
        },
      });
      scheduled = true;
    };
    return request;
  });
  if (!scheduled)
    throw new UserError(
      'Dieser Importstatus kann nicht erneut geprüft werden.',
    );
}

export async function dismissResults(): Promise<void> {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['jobs', 'files'], 'readwrite');
    const store = tx.objectStore('jobs');
    const request = store.getAll();
    request.onsuccess = () => {
      const jobs: Job[] = request.result;
      // Check and remove in one transaction so a new batch cannot race this action.
      if (jobs.some(isActive)) return;
      for (const job of jobs) {
        if (!canDismissJob(job)) continue;
        if (job.status === 'accepted') store.put({ ...job, dismissed: true });
        else store.delete(job.id);
        tx.objectStore('files').delete(job.id);
      }
    };
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
}

export async function enqueue(
  input: File[] | Source,
  serverUrl: string,
): Promise<void> {
  if (Array.isArray(input)) {
    if (!input.length)
      throw new UserError('Bitte wähle mindestens eine PDF aus.');
    if (input.reduce((bytes, file) => bytes + file.size, 0) > MAX_BATCH_BYTES)
      throw new UserError(
        `Die ausgewählten PDFs dürfen zusammen höchstens ${MAX_BATCH_BYTES / 1024 ** 2} MiB groß sein.`,
      );
    for (const file of input) {
      try {
        await validatePdf(file);
      } catch (error) {
        if (!(error instanceof UserError)) throw error;
        throw new UserError(`„${file.name}“: ${error.message}`);
      }
    }
  }
  await stage(Array.isArray(input) ? input : [input], serverUrl, false);
}

export async function enqueueWindow(
  sources: Source[],
  serverUrl: string,
): Promise<void> {
  await stage(sources, serverUrl, true);
}

async function stage(
  entries: (File | Source)[],
  serverUrl: string,
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
          job.source && isPreviousUpload(job, serverUrl)
            ? [[sourceKey(job.source), job] as const]
            : [],
        ),
      );
      store.clear();
      tx.objectStore('files').clear();
      for (const job of jobs.filter(hasImportWork)) store.put(job);
      if (preserveUploads) {
        for (const job of completed.values()) store.put(job);
      }
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
                serverUrl,
                ...(!isFile ? { source: item } : {}),
              };
        store.put(job);
        if (isFile) tx.objectStore('files').put(item, job.id);
        else if (!kept) {
          const captured = tx.objectStore('sources').get(captureKey(item));
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
