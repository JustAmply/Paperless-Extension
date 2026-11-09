import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { errorMessage, UserError } from '../../dist/shared/model.js';
import {
  hasImportWork,
  importDeadline,
  nextImportCheck,
} from '../../dist/shared/job-state.js';

const source = (
  await readFile(new URL('../../dist/offscreen.js', import.meta.url), 'utf8')
).replace(/^import .*;\r?\n/gm, '');

async function runner({
  outcome = 'accepted',
  failNotification,
  failWrite,
} = {}) {
  let stored = {
    id: 'fixture',
    name: 'fixture.pdf',
    status: 'queued',
    message: '',
    createdAt: 0,
    serverUrl: 'https://fixture.invalid/',
  };
  let deleted = false;
  let uploads = 0;
  let importRequests = 0;
  let serverUrl = 'https://fixture.invalid/';
  const effects = {
    getJobs: async () => [stored],
    getFile: async () => new Blob(['%PDF-1.7']),
    deleteFile: async () => {
      deleted = true;
    },
    putJob: async (job) => {
      if (failWrite && job.status === outcome) throw new Error('Write failed');
      stored = job;
    },
    request: async (message) => {
      if (message.type === 'settings')
        return {
          settings: { url: serverUrl, token: 'fixture' },
        };
      if (failNotification && stored.status === outcome)
        throw new Error('Notification failed');
      return { ok: true };
    },
    errorMessage,
    UserError,
    validatePdf: async () => {},
    uploadPdf: async () => {
      uploads++;
      if (outcome instanceof Error) throw outcome;
      return outcome === 'accepted'
        ? { status: outcome, taskId: 'fixture-task' }
        : { status: outcome };
    },
    downloadPdf: async () => {},
    hasImportWork,
    importDeadline,
    nextImportCheck,
    checkImport: async () => {
      importRequests++;
      return { status: 'success', message: 'Imported', documentId: 42 };
    },
    updateImportResult: async (job, result) => {
      if (stored.id === job.id)
        stored = {
          ...stored,
          importTask: { ...stored.importTask, result, checkedAt: Date.now() },
        };
    },
    chrome: { runtime: { onMessage: { addListener() {} } } },
  };
  // Exercise the built runner with deterministic storage/network failures,
  // without creating an extension context or making a real upload request.
  const { processJob, processImport, drain, recovered } = new Function(
    ...Object.keys(effects),
    `${source}\nreturn { processJob, processImport, drain, recovered };`,
  )(...Object.values(effects));
  await recovered;
  return {
    run: () => processJob(stored),
    drain,
    check: () => processImport(stored),
    expire: () => {
      stored.importTask.startedAt = 0;
      stored.importTask.checkedAt = 1;
      stored.importTask.result = { status: 'pending', message: 'Processing' };
    },
    setServer: (url) => {
      serverUrl = url;
    },
    state: () => ({ stored, deleted, uploads, importRequests }),
  };
}

for (const outcome of ['accepted', 'uncertain']) {
  test(`${outcome} survives a failed badge notification without becoming retryable`, async () => {
    const job = await runner({ outcome, failNotification: true });
    await assert.rejects(job.run(), /Notification failed/);
    assert.equal(job.state().stored.status, outcome);
    assert.equal(job.state().uploads, 1);
    assert.equal(job.state().deleted, true);
  });
}

test('a failed terminal write leaves an interrupted upload for uncertain recovery', async () => {
  const job = await runner({ failWrite: true });
  await assert.rejects(job.run(), /Write failed/);
  assert.equal(job.state().stored.status, 'uploading');
  assert.equal(job.state().uploads, 1);
  assert.equal(job.state().deleted, true);
});

test('an explicit API rejection remains a failed upload with its explanation', async () => {
  const job = await runner({ outcome: new UserError('Keine Berechtigung.') });
  await job.run();
  assert.equal(job.state().stored.status, 'failed');
  assert.equal(job.state().stored.message, 'Keine Berechtigung.');
  assert.equal(job.state().uploads, 1);
  assert.equal(job.state().deleted, true);
});

test('queued files cannot be sent to a different Paperless server', async () => {
  const job = await runner();
  job.setServer('https://other-fixture.invalid/');
  await job.run();
  assert.equal(job.state().uploads, 0);
  assert.equal(job.state().stored.status, 'failed');
  assert.match(job.state().stored.message, /Upload-Ziel/);
});

test('the runner automatically confirms an accepted upload without a popup command', async () => {
  const job = await runner();
  await job.drain();
  assert.equal(job.state().uploads, 1);
  assert.equal(job.state().importRequests, 1);
  assert.equal(job.state().stored.importTask.result.status, 'success');
  assert.equal(job.state().stored.status, 'accepted');
});

test('expired automatic checks terminate without a GET or duplicate POST', async () => {
  const job = await runner();
  await job.run();
  job.expire();
  await job.drain();
  assert.equal(job.state().uploads, 1);
  assert.equal(job.state().importRequests, 0);
  assert.equal(job.state().stored.importTask.result.status, 'unavailable');
  assert.equal(hasImportWork(job.state().stored), false);
});

test('automatic checks never use a changed server to look up an older upload', async () => {
  const job = await runner();
  await job.run();
  job.setServer('https://other-fixture.invalid/');
  await job.drain();
  assert.equal(job.state().uploads, 1);
  assert.equal(job.state().importRequests, 0);
  assert.equal(job.state().stored.importTask.result.status, 'unavailable');
  assert.equal(hasImportWork(job.state().stored), false);
});
