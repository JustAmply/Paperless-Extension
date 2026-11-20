import assert from 'node:assert/strict';
import test from 'node:test';
import { UserError } from '../../dist/shared/model.js';
import { hasImportWork } from '../../dist/shared/job-state.js';
import { createUploadRunner } from '../../dist/upload-runner.js';

const destination = 'https://fixture.invalid/';

function fixture({ outcome = 'accepted', failNotification = false } = {}) {
  const jobs = new Map();
  const files = new Set();
  const uploads = [];
  let importRequests = 0;
  let serverUrl = destination;
  let failedWrites = 0;
  let holdRead;
  function queue(id) {
    jobs.set(id, {
      id,
      name: id + '.pdf',
      status: 'queued',
      message: '',
      createdAt: 0,
      serverUrl: destination,
    });
    files.add(id);
  }
  queue('first');
  const runner = createUploadRunner({
    getJobs: async () => {
      const snapshot = [...jobs.values()].map((job) => structuredClone(job));
      if (holdRead && snapshot.length === 0) {
        const { wait, entered } = holdRead;
        holdRead = undefined;
        entered();
        await wait;
      }
      return snapshot;
    },
    getFile: async (id) => (files.has(id) ? new Blob(['%PDF-1.7']) : undefined),
    putJob: async (job) => {
      jobs.set(job.id, job);
    },
    finishJob: async (job) => {
      if (failedWrites > 0) {
        failedWrites--;
        throw new Error('Write failed');
      }
      jobs.set(job.id, job);
      files.delete(job.id);
    },
    getSettings: async () => ({ url: serverUrl, token: 'fixture' }),
    validatePdf: async () => {},
    uploadPdf: async (settings, _file, name) => {
      uploads.push({ url: settings.url, name });
      if (outcome instanceof Error) throw outcome;
      return outcome === 'accepted'
        ? { status: outcome, taskId: 'fixture-task' }
        : { status: outcome };
    },
    downloadPdf: async () => {},
    changed: async () => {
      if (
        failNotification &&
        [...jobs.values()].some((job) => job.status === outcome)
      )
        throw new Error('Notification failed');
    },
    checkImport: async () => {
      importRequests++;
      return { status: 'success', message: 'Imported', documentId: 42 };
    },
    updateImportResult: async (job, result) => {
      jobs.set(job.id, {
        ...jobs.get(job.id),
        importTask: { ...job.importTask, result, checkedAt: Date.now() },
      });
    },
  });
  return {
    run: runner.run,
    jobs,
    files,
    uploads,
    queue,
    setServer(url) {
      serverUrl = url;
    },
    failWrites(count) {
      failedWrites = count;
    },
    importRequests: () => importRequests,
    holdEmptyRead() {
      const { promise: wait, resolve: release } = Promise.withResolvers();
      const { promise: reached, resolve: entered } = Promise.withResolvers();
      holdRead = { wait, entered };
      return { reached, release };
    },
  };
}

for (const outcome of ['accepted', 'uncertain']) {
  test(`a badge failure after ${outcome} cannot stop the remaining batch`, async () => {
    const f = fixture({ outcome, failNotification: true });
    f.queue('second');
    await f.run();
    assert.deepEqual(
      [...f.jobs.values()].map((job) => job.status),
      [outcome, outcome],
    );
    assert.deepEqual(
      f.uploads.map((upload) => upload.name),
      ['first.pdf', 'second.pdf'],
    );
    assert.equal(f.files.size, 0);
  });
}

test('a failed terminal write is retried without repeating the POST', async () => {
  const f = fixture();
  f.failWrites(1);
  await f.run();
  assert.equal(f.jobs.get('first').status, 'accepted');
  assert.equal(f.uploads.length, 1);
  assert.equal(f.files.size, 0);
});

test('the same runner recovers a failed terminal transaction on its next run', async () => {
  const f = fixture();
  f.failWrites(2);
  await assert.rejects(f.run(), /Write failed/);
  assert.equal(f.jobs.get('first').status, 'uploading');
  assert.equal(f.files.has('first'), true);
  await f.run();
  assert.equal(f.jobs.get('first').status, 'uncertain');
  assert.equal(f.files.size, 0);
  assert.equal(f.uploads.length, 1);
});

test('a start signal arriving during an empty queue read is not lost', async () => {
  const f = fixture();
  f.jobs.clear();
  const { reached, release } = f.holdEmptyRead();
  const running = f.run();
  await reached;
  f.queue('second');
  const next = f.run();
  release();
  await Promise.all([running, next]);
  assert.deepEqual(
    f.uploads.map((upload) => upload.name),
    ['second.pdf'],
  );
  assert.equal(f.jobs.get('second').status, 'accepted');
});

test('an explicit API rejection remains a failed upload with its explanation', async () => {
  const f = fixture({ outcome: new UserError({ key: 'apiDenied' }) });
  await f.run();
  assert.equal(f.jobs.get('first').status, 'failed');
  assert.deepEqual(f.jobs.get('first').message, { key: 'apiDenied' });
  assert.equal(f.uploads.length, 1);
  assert.equal(f.files.size, 0);
});

test('queued files cannot be sent to a different Paperless server', async () => {
  const f = fixture();
  f.setServer('https://other-fixture.invalid/');
  await f.run();
  assert.equal(f.uploads.length, 0);
  assert.equal(f.jobs.get('first').status, 'failed');
  assert.deepEqual(f.jobs.get('first').message, { key: 'destinationChanged' });
});

test('the runner automatically confirms an accepted upload', async () => {
  const f = fixture();
  await f.run();
  assert.equal(f.uploads.length, 1);
  assert.equal(f.importRequests(), 1);
  assert.equal(f.jobs.get('first').importTask.result.status, 'success');
  assert.equal(f.jobs.get('first').status, 'accepted');
});

test('expired automatic checks terminate without a GET or duplicate POST', async () => {
  const f = fixture();
  const job = f.jobs.get('first');
  job.status = 'accepted';
  job.importTask = {
    serverUrl: destination,
    taskId: 'old',
    startedAt: 0,
    checkedAt: 1,
    result: { status: 'pending', message: 'Processing' },
  };
  await f.run();
  assert.equal(f.uploads.length, 0);
  assert.equal(f.importRequests(), 0);
  assert.equal(f.jobs.get('first').importTask.result.status, 'unavailable');
  assert.equal(hasImportWork(f.jobs.get('first')), false);
});

test('automatic checks never use a changed server to look up an older upload', async () => {
  const f = fixture();
  const job = f.jobs.get('first');
  job.status = 'accepted';
  job.importTask = {
    serverUrl: destination,
    taskId: 'old',
    startedAt: Date.now(),
  };
  f.setServer('https://other-fixture.invalid/');
  await f.run();
  assert.equal(f.uploads.length, 0);
  assert.equal(f.importRequests(), 0);
  assert.equal(f.jobs.get('first').importTask.result.status, 'unavailable');
  assert.equal(hasImportWork(f.jobs.get('first')), false);
});
