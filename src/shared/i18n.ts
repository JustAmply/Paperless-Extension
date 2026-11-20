import { legacyMessage } from './legacy-message.js';

export type MessageKey = keyof typeof import('../../_locales/de/messages.json');

export interface LocalizedMessage {
  key: MessageKey;
  substitutions?: string[];
}

// Jobs and cross-context messages carry these values until a UI renders them.
// The offscreen document only has access to chrome.runtime.
export function message(
  key: MessageKey,
  ...substitutions: string[]
): LocalizedMessage {
  return substitutions.length ? { key, substitutions } : { key };
}

export function t(key: MessageKey, ...substitutions: string[]): string {
  return chrome.i18n.getMessage(key, substitutions);
}

export function resolveMessage(value: LocalizedMessage | string): string {
  const localized =
    typeof value === 'string' ? (legacyMessage(value) ?? value) : value;
  return typeof localized === 'string'
    ? localized
    : t(localized.key, ...(localized.substitutions ?? []));
}

export function localizeDocument(): void {
  document.documentElement.lang = t('languageTag');
  document.documentElement.dir = 'ltr';
  for (const attribute of ['', 'title', 'aria-label', 'placeholder']) {
    const marker = attribute ? `data-i18n-${attribute}` : 'data-i18n';
    for (const element of document.querySelectorAll(`[${marker}]`)) {
      const text = chrome.i18n.getMessage(element.getAttribute(marker)!);
      if (attribute) element.setAttribute(attribute, text);
      else element.textContent = text;
    }
  }
}
