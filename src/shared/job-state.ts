import type { Job } from './model.js';

export const IMPORT_CHECK_WINDOW_MS = 120_000;
const SUCCESS_DISPLAY_MS = 8_000;

export function hasImportWork(job: Job): boolean {
  if (job.status !== 'accepted' || !job.importTask) return false;
  const result = job.importTask.result;
  return !result || result.status === 'pending' || result.retryable === true;
}

export function importDeadline(job: Job): number {
  return (
    (job.importTask?.startedAt ?? job.completedAt ?? job.createdAt) +
    IMPORT_CHECK_WINDOW_MS
  );
}

export function nextImportCheck(job: Job): number {
  const task = job.importTask;
  if (!task?.checkedAt) return 0;
  return Math.min(
    importDeadline(job),
    task.checkedAt + (task.result?.retryable ? 15_000 : 5_000),
  );
}

export function canDismissJob(job: Job): boolean {
  if (job.dismissed) return false;
  if (job.status === 'failed' || job.status === 'skipped') return true;
  return job.status === 'accepted' && !hasImportWork(job);
}

export function isJobVisible(job: Job, now: number, engaged = false): boolean {
  if (job.dismissed) return false;
  if (job.status !== 'accepted') return true;
  const task = job.importTask;
  if (
    task &&
    task.result?.status !== 'success' &&
    task.result?.status !== 'duplicate'
  )
    return true;
  const finishedAt = task?.checkedAt ?? job.completedAt ?? job.createdAt;
  return engaged || now < finishedAt + SUCCESS_DISPLAY_MS;
}
