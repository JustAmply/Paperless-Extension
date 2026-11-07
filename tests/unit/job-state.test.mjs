import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hasImportWork,
  importDeadline,
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

test('terminal import results can be dismissed while pending and uncertain outcomes remain visible', () => {
  for (const status of ['success', 'duplicate', 'failure', 'unavailable']) {
    const accepted = withResult(status);
    assert.equal(canDismissJob(accepted), true);
    const dismissed = { ...accepted, dismissed: true };
    assert.equal(dismissed.status, 'accepted');
    assert.equal(canDismissJob(dismissed), false);
  }
  assert.equal(canDismissJob(withResult('pending')), false);
  assert.equal(
    canDismissJob(withResult('unavailable', { retryable: true })),
    false,
  );
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
