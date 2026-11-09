import {
  deleteFile,
  getFile,
  getJobs,
  putJob,
  updateImportResult,
} from './data/jobs.js';
import { request } from './shared/messaging.js';
import { errorMessage, UserError, type Job } from './shared/model.js';
import { validatePdf } from './shared/pdf.js';
import { uploadPdf } from './services/paperless.js';
import { downloadPdf } from './services/source.js';
import { checkImport } from './services/import-task.js';
import {
  hasImportWork,
  importDeadline,
  nextImportCheck,
} from './shared/job-state.js';

const uncertain =
  'Keine Bestätigung erhalten. Prüfe zuerst den Paperless-Posteingang, bevor du die Datei erneut sendest.';

async function update(job: Job): Promise<void> {
  await putJob(job);
  await request({ target: 'background', type: 'changed' });
}

// A new offscreen document means an earlier in-flight request lost its owner.
const recovered = (async () => {
  for (const job of await getJobs()) {
    if (job.status === 'uploading' || job.status === 'downloading') {
      const uploading = job.status === 'uploading';
      await putJob({
        ...job,
        status: uploading ? 'uncertain' : 'failed',
        message: uploading
          ? uncertain
          : 'Der Abruf wurde unterbrochen. Bitte versuche es erneut.',
      });
      await deleteFile(job.id);
    } else if (job.status !== 'queued') {
      await deleteFile(job.id);
    }
  }
})();

async function transfer(job: Job): Promise<Job> {
  const response = await request({ target: 'background', type: 'settings' });
  if (!response.settings)
    throw new UserError('Bitte richte deinen Paperless-Server ein.');
  if (job.serverUrl !== response.settings.url)
    throw new UserError(
      'Das Upload-Ziel hat sich geändert oder fehlt. Wähle die PDF erneut aus.',
    );
  let file = await getFile(job.id);
  if (!file && job.source) {
    await update({
      ...job,
      status: 'downloading',
      message: 'Geöffnete PDF wird abgerufen …',
    });
    const pdf = await downloadPdf(job.source.url);
    if (!pdf) {
      return {
        ...job,
        status: 'skipped',
        message:
          'Keine PDF erhalten. Die Website liefert möglicherweise eine Anmeldeseite. Speichere die PDF im Viewer und wähle sie hier aus.',
      };
    }
    file = pdf.file;
    job.name = pdf.name;
  }
  if (!file)
    throw new UserError(
      'Die Datei ist nicht mehr verfügbar. Bitte wähle sie erneut aus.',
    );
  await validatePdf(file);
  await update({
    ...job,
    status: 'uploading',
    message: 'Wird an Paperless übertragen …',
  });
  const outcome = await uploadPdf(response.settings, file, job.name);
  return {
    ...job,
    status: outcome.status,
    completedAt: Date.now(),
    message:
      outcome.status === 'accepted' ? 'An Paperless übertragen' : uncertain,
    ...(outcome.status === 'accepted'
      ? {
          importTask: {
            taskId: outcome.taskId,
            serverUrl: response.settings.url,
            startedAt: Date.now(),
          },
        }
      : {}),
  };
}

async function processJob(job: Job): Promise<void> {
  let result: Job;
  try {
    result = await transfer(job);
  } catch (error) {
    result = { ...job, status: 'failed', message: errorMessage(error) };
  }
  try {
    // A failed status write or badge notification must not turn a completed
    // POST into a retryable failure. Interrupted uploads recover as uncertain.
    await update(result);
  } finally {
    await deleteFile(job.id);
  }
}

let running: Promise<void> | undefined;
let wake: (() => void) | undefined;

async function processImport(job: Job): Promise<void> {
  if (!job.importTask) return;
  // A long upload queue can use the time window before the first lookup.
  // Still check once; completed imports should not be reported as unknown.
  if (
    job.importTask.checkedAt !== undefined &&
    Date.now() >= importDeadline(job)
  ) {
    await updateImportResult(job, {
      status: 'unavailable',
      message:
        'Die PDF wurde übertragen. Der Import dauert länger; prüfe den Status in Paperless.',
    });
  } else {
    const response = await request({ target: 'background', type: 'settings' });
    if (
      !response.settings ||
      response.settings.url !== job.importTask.serverUrl
    ) {
      await updateImportResult(job, {
        status: 'unavailable',
        message: 'Dieser Upload gehört zu einem anderen Paperless-Server.',
      });
    } else {
      await updateImportResult(
        job,
        await checkImport(response.settings, job.importTask.taskId),
      );
    }
  }
  await request({ target: 'background', type: 'changed' });
}

async function drain(): Promise<void> {
  await recovered;
  while (true) {
    const jobs = await getJobs();
    const next = jobs.find((job) => job.status === 'queued');
    if (next) {
      await processJob(next);
      continue;
    }
    const imports = jobs
      .filter(hasImportWork)
      .sort((a, b) => nextImportCheck(a) - nextImportCheck(b));
    const pending = imports[0];
    if (!pending) break;
    const delay = nextImportCheck(pending) - Date.now();
    if (delay <= 0) await processImport(pending);
    else
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          wake = undefined;
          resolve();
        }, delay);
        wake = () => {
          clearTimeout(timer);
          wake = undefined;
          resolve();
        };
      });
  }
}

chrome.runtime.onMessage.addListener(
  (message: { target?: string; type?: string }, sender, sendResponse) => {
    if (
      sender.id !== chrome.runtime.id ||
      message?.target !== 'offscreen' ||
      message.type !== 'process'
    )
      return false;
    wake?.();
    running ??= drain().finally(() => {
      running = undefined;
      void request({ target: 'background', type: 'idle' });
    });
    sendResponse({ ok: true });
    return false;
  },
);
