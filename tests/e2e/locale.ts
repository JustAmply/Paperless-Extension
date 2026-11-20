export function browserLocale(tag: string) {
  const locale = new Intl.Locale(tag).maximize();
  return {
    locale: tag,
    env: {
      ...process.env,
      LANGUAGE: tag,
      LANG: `${locale.language}_${locale.region}.UTF-8`,
    },
  };
}
