import { UserError, type Settings } from './model.js';

export function normalizeServer(input: string): string {
  const text = input.trim();
  let url: URL;
  try {
    url = new URL(text.includes('://') ? text : `https://${text}`);
  } catch {
    throw new UserError('Bitte gib eine gültige Paperless-Adresse ein.');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new UserError(
      'Nutze eine HTTP(S)-Adresse ohne Zugangsdaten, Suche oder Sprungmarke.',
    );
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
  return url.href;
}

export function hostPermission(url: string): string {
  return `${new URL(url).origin}/*`;
}

export function validateSettings(
  input: string,
  token: string,
  previous?: Settings,
): Settings {
  const url = normalizeServer(input);
  const value = token.trim() || (previous?.url === url ? previous.token : '');
  if (!value && previous && previous.url !== url)
    throw new UserError(
      'Gib für die neue Paperless-Adresse einen API-Token ein.',
    );
  if (!value || /[^\x21-\x7e]/.test(value) || value.length > 512) {
    throw new UserError(
      'Bitte gib deinen Paperless-API-Token ohne Leerzeichen ein.',
    );
  }
  return { url, token: value };
}
