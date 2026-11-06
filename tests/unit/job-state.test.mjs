import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hasImportWork,
  importDeadline,
  isJobVisible,
  nextImportCheck,
  canDismissJob,
} from '../../dist/shared/job-state.js';

const job = {
  id: 'fixture',
  name: 'fixture.pdf',
  status: 'accepted',
  message: '',
  createdAt: 1_000,
  completedAt: 2_000,
  importTask: {
    taskId: 'task',
    serverUrl: 'https://fixture.invalid/',
    startedAt: 2_000,
  },
};
const withResult = (status, extra = {}) => ({
  ...job,
  importTask: {
    ...job.importTask,
    checkedAt: 3_000,
    result: { status, message: '', ...extra },
  },
});

test('terminal import warnings can be hidden while accepted records retain duplicate protection', () => {
  for (const status of ['failure', 'unavailable']) {
    const accepted = withResult(status);
    assert.equal(canDismissJob(accepted), true);
    const dismissed = { ...accepted, dismissed: true };
    assert.equal(isJobVisible(dismissed), false);
    assert.equal(dismissed.status, 'accepted');
    assert.equal(canDismissJob(dismissed), false);
  }
  assert.equal(canDismissJob(withResult('pending')), false);
  assert.equal(
    canDismissJob(withResult('unavailable', { retryable: true })),
    false,
  );
  assert.equal(canDismissJob(withResult('success')), false);
  assert.equal(canDismissJob({ ...job, status: 'uncertain' }), false);
});

test('import checks are bounded by acceptance time and distinguish retryable failures', () => {
  assert.equal(hasImportWork(job), true);
  assert.equal(importDeadline(job), 122_000);
  assert.equal(nextImportCheck(job), 0);
  assert.equal(hasImportWork(withResult('pending')), true);
  assert.equal(nextImportCheck(withResult('pending')), 8_000);
  assert.equal(hasImportWork(withResult('unavailable')), false);
  assert.equal(
    hasImportWork(withResult('unavailable', { retryable: true })),
    true,
  );
  assert.equal(
    nextImportCheck(withResult('unavailable', { retryable: true })),
    18_000,
  );
  assert.equal(
    nextImportCheck({
      ...job,
      importTask: {
        ...job.importTask,
        checkedAt: 121_000,
        result: { status: 'pending', message: '' },
      },
    }),
    122_000,
  );
  for (const status of ['success', 'duplicate', 'failure'])
    assert.equal(hasImportWork(withResult(status)), false);
  assert.equal(hasImportWork({ ...job, status: 'uncertain' }), false);
});

test('only successful terminal rows disappear after eight seconds without changing stored status', () => {
  for (const status of ['success', 'duplicate']) {
    const completed = withResult(status);
    assert.equal(isJobVisible(completed, 10_999), true);
    assert.equal(isJobVisible(completed, 11_000), false);
    assert.equal(completed.status, 'accepted');
  }
  for (const status of ['pending', 'failure', 'unavailable'])
    assert.equal(isJobVisible(withResult(status), 999_000), true);
  assert.equal(isJobVisible({ ...job, status: 'uncertain' }, 999_000), true);
  assert.equal(isJobVisible({ ...job, status: 'failed' }, 999_000), true);
  const { importTask: _task, ...legacy } = job;
  assert.equal(isJobVisible(legacy, 10_000), false);
});
