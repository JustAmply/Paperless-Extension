export function browserLocale(tag: string) {
  const locale = new Intl.Locale(tag).maximize();
  return {
    locale: tag,
    env: {
      ...process.env,
      LANGUAGE: tag,
      // Linux CI need not have the requested regional locale installed.
      // Chromium uses the system encoding for filenames even when its UI is localized.
      ...(process.platform === 'linux'
        ? { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }
        : { LANG: `${locale.language}_${locale.region}.UTF-8` }),
    },
  };
}
