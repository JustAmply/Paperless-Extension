export const MAX_PDF_BYTES = 50 * 1024 * 1024;
export const MAX_BATCH_FILES = 10;

export interface Settings {
  url: string;
  token: string;
}

export interface Source {
  url: string;
  tabId: number;
}

export type JobStatus =
  | 'queued'
  | 'downloading'
  | 'uploading'
  | 'accepted'
  | 'failed'
  | 'uncertain'
  | 'skipped';

export interface Job {
  id: string;
  name: string;
  status: JobStatus;
  message: string;
  createdAt: number;
  source?: Source;
}

export interface State {
  settings: { url: string; configured: boolean };
  jobs: Job[];
}

export type BackgroundRequest =
  | { target: 'background'; type: 'state' }
  | { target: 'background'; type: 'save'; url: string; token: string }
  | { target: 'background'; type: 'process' }
  | { target: 'background'; type: 'changed' }
  | { target: 'background'; type: 'idle' }
  | { target: 'background'; type: 'settings' };

export interface BackgroundResponse {
  ok: boolean;
  error?: string;
  state?: State;
  settings?: Settings;
}

export function isActive(job: Job): boolean {
  return ['queued', 'downloading', 'uploading'].includes(job.status);
}

export class UserError extends Error {}

export function errorMessage(error: unknown): string {
  return error instanceof UserError
    ? error.message
    : 'Die Aktion konnte nicht abgeschlossen werden. Bitte versuche es erneut.';
}
