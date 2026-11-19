import {
  finishJob,
  getFile,
  getJobs,
  putJob,
  updateImportResult,
} from './data/jobs.js';
import { request } from './shared/messaging.js';
import { validatePdf } from './shared/pdf.js';
import { uploadPdf } from './services/paperless.js';
import { downloadPdf } from './services/source.js';
import { checkImport } from './services/import-task.js';
import { createUploadRunner } from './upload-runner.js';

const runner = createUploadRunner({
  getJobs,
  getFile,
  putJob,
  finishJob,
  updateImportResult,
  getSettings: async () =>
    (await request({ target: 'background', type: 'settings' })).settings,
  validatePdf,
  uploadPdf,
  downloadPdf,
  checkImport,
  changed: () => request({ target: 'background', type: 'changed' }),
});
let reportedRun: Promise<void> | undefined;

chrome.runtime.onMessage.addListener(
  (message: { target?: string; type?: string }, sender, sendResponse) => {
    if (
      sender.id !== chrome.runtime.id ||
      message?.target !== 'offscreen' ||
      message.type !== 'process'
    )
      return false;
    const run = runner.run();
    if (reportedRun !== run) {
      reportedRun = run;
      void run
        .then(
          () => request({ target: 'background', type: 'idle' }),
          () => request({ target: 'background', type: 'runner-stopped' }),
        )
        .catch(() => undefined);
    }
    sendResponse({ ok: true });
    return false;
  },
);
