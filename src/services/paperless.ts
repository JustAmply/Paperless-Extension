import { message } from '../shared/i18n.js';
import { UserError, type Settings } from '../shared/model.js';

function rejection(status: number): UserError {
  switch (status) {
    case 401:
      return new UserError(message('apiInvalidToken'));
    case 403:
      return new UserError(message('apiDenied'));
    case 413:
      return new UserError(message('apiTooLarge'));
    case 429:
      return new UserError(message('apiRateLimited'));
    default:
      return new UserError(message('apiRejected', String(status)));
  }
}

function options(settings: Settings): RequestInit {
  return {
    headers: { Authorization: `Token ${settings.token}` },
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store',
  };
}

export async function verifyConnection(settings: Settings): Promise<void> {
  let response: Response;
  try {
    // The API root redirects to Swagger in current Paperless versions.
    response = await fetch(new URL('api/profile/', settings.url), {
      ...options(settings),
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new UserError(message('apiUnreachable'));
  }
  if (
    response.type === 'opaqueredirect' ||
    (response.status >= 300 && response.status < 400)
  ) {
    throw new UserError(message('apiRedirect'));
  }
  if (!response.ok) throw rejection(response.status);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    /* An HTML login page is not the Paperless API. */
  }
  if (
    !body ||
    typeof body !== 'object' ||
    !('auth_token' in body) ||
    body.auth_token !== settings.token
  ) {
    throw new UserError(message('apiNotFound'));
  }
}

export async function uploadPdf(
  settings: Settings,
  file: Blob,
  name: string,
): Promise<{ status: 'accepted'; taskId: string } | { status: 'uncertain' }> {
  const body = new FormData();
  body.append('document', file, name);
  let response: Response;
  try {
    response = await fetch(
      new URL('api/documents/post_document/', settings.url),
      {
        ...options(settings),
        method: 'POST',
        body,
        signal: AbortSignal.timeout(5 * 60_000),
      },
    );
  } catch {
    return { status: 'uncertain' };
  }
  if (!response.ok) {
    if (response.status >= 500) return { status: 'uncertain' };
    throw rejection(response.status);
  }
  try {
    const task: unknown = await response.json();
    return typeof task === 'string' &&
      /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(task)
      ? { status: 'accepted', taskId: task }
      : { status: 'uncertain' };
  } catch {
    return { status: 'uncertain' };
  }
}
