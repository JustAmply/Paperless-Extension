import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { errorMessage, UserError } from '../../dist/shared/model.js';

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
  };
  let deleted = false;
  let uploads = 0;
  const effects = {
    getJobs: async () => [],
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
          settings: { url: 'https://fixture.invalid/', token: 'fixture' },
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
      return outcome;
    },
    downloadPdf: async () => {},
    chrome: { runtime: { onMessage: { addListener() {} } } },
  };
  // Exercise the built runner with deterministic storage/network failures,
  // without creating an extension context or making a real upload request.
  const { processJob, recovered } = new Function(
    ...Object.keys(effects),
    `${source}\nreturn { processJob, recovered };`,
  )(...Object.values(effects));
  await recovered;
  return {
    run: () => processJob(stored),
    state: () => ({ stored, deleted, uploads }),
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
