export const MAX_PDF_BYTES = 50 * 1024 * 1024;
export const MAX_BATCH_BYTES = 512 * 1024 * 1024;

export interface Settings {
  url: string;
  token: string;
}

export interface Source {
  url: string;
  tabId: number;
  fingerprint?: string;
}

export function sourceKey(source: Source): string {
  return JSON.stringify([source.url, source.fingerprint ?? '']);
}

export interface SourceInfo extends Source {
  availability: 'ready' | 'loading' | 'unavailable';
  error?: string;
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
  completedAt?: number;
  dismissed?: boolean;
  serverUrl?: string;
  source?: Source;
  importTask?: {
    taskId: string;
    serverUrl: string;
    startedAt?: number;
    result?: ImportResult;
    checkedAt?: number;
  };
}

export interface ImportResult {
  status: 'pending' | 'success' | 'failure' | 'duplicate' | 'unavailable';
  message: string;
  documentId?: number;
  retryable?: boolean;
}

export interface State {
  settings: { url: string; configured: boolean };
  jobs: Job[];
  sources: SourceInfo[];
}

export type BackgroundRequest =
  | { target: 'background'; type: 'state' }
  | { target: 'background'; type: 'pdf-disposition'; url: string }
  | { target: 'background'; type: 'dismiss-results' }
  | { target: 'background'; type: 'save'; url: string; token: string }
  | { target: 'background'; type: 'process' }
  | {
      target: 'background';
      type: 'upload-window';
      windowId: number;
      serverUrl: string;
    }
  | { target: 'background'; type: 'changed' }
  | { target: 'background'; type: 'idle' }
  | { target: 'background'; type: 'runner-stopped' }
  | { target: 'background'; type: 'settings' };

export interface BackgroundResponse {
  ok: boolean;
  error?: string;
  state?: State;
  settings?: Settings;
  message?: string;
  disposition?: string;
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
