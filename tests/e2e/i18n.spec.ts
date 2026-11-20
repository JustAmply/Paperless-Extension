import { chromium, expect, test } from '@playwright/test';
import path from 'node:path';
import { browserLocale } from './locale.js';

for (const sample of [
  {
    locale: 'fr',
    language: 'fr',
    setup: 'Se connecter à Paperless',
    address: 'Adresse de Paperless',
    token: 'Jeton API',
    settings: 'Paramètres',
    connect: 'Se connecter',
    actionTitle: 'Envoyer le PDF à Paperless',
    error: 'Saisissez une adresse Paperless valide.',
  },
  {
    locale: 'cs',
    language: 'en',
    setup: 'Connect to Paperless',
    address: 'Paperless address',
    token: 'API token',
    settings: 'Settings',
    connect: 'Connect',
    actionTitle: 'Send PDF to Paperless',
    error: 'Enter a valid Paperless address.',
  },
]) {
  test(`Chrome locale ${sample.locale} uses ${sample.language} for the manifest, popup and validation`, async () => {
    const extension = path.resolve('dist');
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      ...browserLocale(sample.locale),
      args: [
        `--lang=${sample.locale}`,
        `--load-extension=${extension}`,
        `--disable-extensions-except=${extension}`,
      ],
    });
    try {
      const worker =
        context.serviceWorkers()[0] ??
        (await context.waitForEvent('serviceworker'));
      const page = await context.newPage();
      await page.goto(new URL('popup.html', worker.url()).href);
      expect(await page.evaluate(() => chrome.i18n.getUILanguage())).toBe(
        sample.locale,
      );
      expect(
        await page.evaluate(
          () => chrome.runtime.getManifest().action?.default_title,
        ),
      ).toBe(sample.actionTitle);
      await expect(page.locator('html')).toHaveAttribute(
        'lang',
        sample.language,
      );
      await expect(
        page.getByRole('heading', { name: sample.setup }),
      ).toBeVisible();
      await expect(page.locator('#settings-toggle')).toHaveAttribute(
        'aria-label',
        sample.settings,
      );
      await expect(page.locator('#settings-toggle')).toHaveAttribute(
        'title',
        sample.settings,
      );

      await page
        .getByRole('textbox', { name: sample.address })
        .fill('https://[');
      await page.getByLabel(sample.token, { exact: true }).fill('fixture');
      await page
        .getByRole('button', { name: sample.connect, exact: true })
        .click();
      await expect(page.locator('#settings-status')).toHaveText(sample.error);
    } finally {
      await context.close();
    }
  });
}
