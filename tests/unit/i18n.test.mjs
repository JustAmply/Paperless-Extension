import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const dist = new URL('../../dist/', import.meta.url);
const read = (path) => readFile(new URL(path, dist), 'utf8');
const catalog = async (locale) =>
  JSON.parse(await read(`_locales/${locale}/messages.json`));

test('all packaged locales cover the manifest, UI and substitution contract', async () => {
  const manifest = JSON.parse(await read('manifest.json'));
  const base = await catalog(manifest.default_locale);
  const locales = await readdir(new URL('_locales/', dist));
  assert.ok(locales.length >= 10);
  for (const match of JSON.stringify(manifest).matchAll(/__MSG_(\w+)__/g))
    assert.ok(Object.hasOwn(base, match[1]), match[1]);
  for (const file of ['popup.html', 'capture.html']) {
    for (const match of (await read(file)).matchAll(
      /data-i18n(?:-[\w-]+)?="(\w+)"/g,
    ))
      assert.ok(Object.hasOwn(base, match[1]), `${file} uses ${match[1]}`);
  }
  for (const locale of locales) {
    const messages = await catalog(locale);
    assert.deepEqual(
      Object.keys(messages).sort(),
      Object.keys(base).sort(),
      locale,
    );
    assert.equal(messages.languageTag.message, locale.replace('_', '-'));
    assert.ok(messages.extensionDescription.message.length <= 132, locale);
    for (const [key, { message, placeholders = {} }] of Object.entries(
      messages,
    )) {
      const context = `${locale}/${key}`;
      assert.ok(message.trim(), context);
      const names = [
        ...new Set(
          [...message.matchAll(/\$(\w+)\$/g)].map((m) => m[1].toLowerCase()),
        ),
      ].sort();
      assert.deepEqual(names, Object.keys(placeholders).sort(), context);
      const positions = (definitions) =>
        Object.fromEntries(
          Object.entries(definitions).map(([name, { content }]) => [
            name,
            content,
          ]),
        );
      assert.deepEqual(
        positions(placeholders),
        positions(base[key].placeholders ?? {}),
        context,
      );
      for (const { content } of Object.values(placeholders))
        assert.match(content, /^\$[1-9]$/, context);
    }
  }
});
