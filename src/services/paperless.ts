import { UserError, type Settings } from '../shared/model.js';

function rejection(status: number): UserError {
  switch (status) {
    case 401:
      return new UserError(
        'Der API-Token ist ungültig. Bitte prüfe ihn in den Einstellungen.',
      );
    case 403:
      return new UserError(
        'Keine Berechtigung. Prüfe die Rechte des Tokens und den Serverzugriff.',
      );
    case 413:
      return new UserError(
        'Der Server lehnt die Dateigröße ab. Prüfe sein Upload-Limit.',
      );
    case 429:
      return new UserError(
        'Zu viele Anfragen. Bitte versuche es später erneut.',
      );
    default:
      return new UserError(
        `Paperless hat die Anfrage abgelehnt (HTTP ${status}). Prüfe die Adresse und gegebenenfalls die Paperless-Protokolle.`,
      );
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
    throw new UserError(
      'Paperless ist nicht erreichbar. Prüfe Adresse, HTTPS-Zertifikat und Netzwerk.',
    );
  }
  if (
    response.type === 'opaqueredirect' ||
    (response.status >= 300 && response.status < 400)
  ) {
    throw new UserError(
      'Der Server leitet die API-Anfrage weiter. Nutze die direkte Paperless-Basisadresse. Ein vorgeschalteter Login muss Token-Zugriff auf /api/ erlauben.',
    );
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
    throw new UserError(
      'Unter dieser Adresse antwortet keine Paperless-API. Nutze die Basisadresse, gegebenenfalls mit Unterpfad.',
    );
  }
}

export async function uploadPdf(
  settings: Settings,
  file: Blob,
  name: string,
): Promise<'accepted' | 'uncertain'> {
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
    return 'uncertain';
  }
  if (!response.ok) {
    if (response.status >= 500) return 'uncertain';
    throw rejection(response.status);
  }
  try {
    const task: unknown = await response.json();
    return typeof task === 'string' &&
      /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(task)
      ? 'accepted'
      : 'uncertain';
  } catch {
    return 'uncertain';
  }
}
