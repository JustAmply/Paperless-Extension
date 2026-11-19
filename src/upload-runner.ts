import {
  errorMessage,
  UserError,
  type Job,
  type Settings,
  type ImportResult,
} from './shared/model.js';
import {
  hasImportWork,
  importDeadline,
  nextImportCheck,
} from './shared/job-state.js';

const uncertain =
  'Keine Bestätigung erhalten. Prüfe zuerst den Paperless-Posteingang, bevor du die Datei erneut sendest.';

export function createUploadRunner(effects: {
  getJobs(): Promise<Job[]>;
  getFile(id: string): Promise<Blob | undefined>;
  putJob(job: Job): Promise<void>;
  finishJob(job: Job): Promise<void>;
  updateImportResult(job: Job, result: ImportResult): Promise<void>;
  getSettings(): Promise<Settings | undefined>;
  validatePdf(file: Blob): Promise<void>;
  downloadPdf(url: string): Promise<{ file: Blob; name: string } | undefined>;
  uploadPdf(
    settings: Settings,
    file: Blob,
    name: string,
  ): Promise<{ status: 'accepted'; taskId: string } | { status: 'uncertain' }>;
  checkImport(settings: Settings, taskId: string): Promise<ImportResult>;
  changed(): Promise<unknown>;
}): { run(): Promise<void> } {
  const {
    getJobs,
    getFile,
    putJob,
    finishJob,
    updateImportResult,
    getSettings,
    validatePdf,
    downloadPdf,
    uploadPdf,
    checkImport,
  } = effects;

  async function notify(): Promise<void> {
    // The toolbar is advisory; durable job state drives the queue.
    await effects.changed().catch(() => undefined);
  }

  async function update(job: Job): Promise<void> {
    await putJob(job);
    await notify();
  }

  async function recover(): Promise<void> {
    for (const job of await getJobs()) {
      if (job.status !== 'uploading' && job.status !== 'downloading') continue;
      const uploading = job.status === 'uploading';
      await finishJob({
        ...job,
        status: uploading ? 'uncertain' : 'failed',
        message: uploading
          ? uncertain
          : 'Der Abruf wurde unterbrochen. Bitte versuche es erneut.',
      });
    }
    await notify();
  }

  async function transfer(job: Job): Promise<Job> {
    const settings = await getSettings();
    if (!settings)
      throw new UserError('Bitte richte deinen Paperless-Server ein.');
    if (job.serverUrl !== settings.url)
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
    const outcome = await uploadPdf(settings, file, job.name);
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
              serverUrl: settings.url,
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
      await finishJob(result);
    } catch {
      // Retry only the atomic state write, never the upload POST.
      await finishJob(result);
    }
    await notify();
  }

  let running: Promise<void> | undefined;
  let wake: (() => void) | undefined;
  let requested = false;

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
      const settings = await getSettings();
      if (!settings || settings.url !== job.importTask.serverUrl) {
        await updateImportResult(job, {
          status: 'unavailable',
          message: 'Dieser Upload gehört zu einem anderen Paperless-Server.',
        });
      } else {
        await updateImportResult(
          job,
          await checkImport(settings, job.importTask.taskId),
        );
      }
    }
    await notify();
  }

  async function drain(): Promise<void> {
    await recover();
    while (true) {
      requested = false;
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
      if (requested) continue;
      if (!pending) return;
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

  return {
    run() {
      requested = true;
      wake?.();
      running ??= (async () => {
        try {
          do {
            await drain();
          } while (requested);
        } finally {
          running = undefined;
        }
      })();
      return running;
    },
  };
}
