import { message, type LocalizedMessage } from './i18n.js';

export const MAX_PDF_BYTES = 50 * 1024 * 1024;
export const MAX_BATCH_BYTES = 512 * 1024 * 1024;

export interface Settings {
  url: string;
  token: string;
}

export interface Source {
  url: string;
  tabId: number;
  documentId?: string;
  fingerprint?: string;
}

export function sourceKey(source: Source): string {
  return JSON.stringify([source.url, source.fingerprint ?? '']);
}

export interface SourceInfo extends Source {
  viewerUrl?: string;
  embedded?: boolean;
  availability: 'ready' | 'loading' | 'unavailable';
  error?: LocalizedMessage | string;
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
  message: LocalizedMessage | string;
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
  message: LocalizedMessage | string;
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
  | { target: 'background'; type: 'capture-context'; url: string }
  | { target: 'background'; type: 'dismiss-results' }
  | { target: 'background'; type: 'retry-import'; jobId: string }
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
  documentId?: string;
  error?: LocalizedMessage | string;
  state?: State;
  settings?: Settings;
  message?: LocalizedMessage | string;
  disposition?: string;
}

export function isActive(job: Job): boolean {
  return ['queued', 'downloading', 'uploading'].includes(job.status);
}

export class UserError extends Error {
  readonly userMessage: LocalizedMessage | string;

  constructor(userMessage: LocalizedMessage | string) {
    super(typeof userMessage === 'string' ? userMessage : userMessage.key);
    this.userMessage = userMessage;
  }
}

export function errorMessage(error: unknown): LocalizedMessage | string {
  return error instanceof UserError
    ? error.userMessage
    : message('actionFailed');
}
