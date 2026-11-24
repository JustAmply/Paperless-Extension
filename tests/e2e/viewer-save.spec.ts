import { browserLocale } from './locale.js';
import { chromium, expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';

test('the original invoice opens directly in the native viewer with PDF controls and keyboard navigation', async ({}, testInfo) => {
  const extension = path.resolve('dist');
  const context = await chromium.launchPersistentContext(
    testInfo.outputPath('profile'),
    {
      channel: 'chromium',
      ...browserLocale('de'),
      args: [
        '--lang=de',
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
      ],
    },
  );
  const portal = context.pages()[0]!;
  await portal.setContent(
    '<p style="break-after:page">First invoice page</p><p>Second invoice page</p>',
  );
  const pdf = await portal.pdf();
  let invoiceRequests = 0;
  const server = createServer((request, response) => {
    if (request.url === '/invoices/Rechnung.pdf') {
      invoiceRequests++;
      if (invoiceRequests !== 1) {
        response.writeHead(410).end();
        return;
      }
      response
        .writeHead(200, {
          'content-type': 'application/pdf',
          'cache-control': 'private, max-age=60',
        })
        .end(pdf);
      return;
    }
    response
      .writeHead(200, { 'content-type': 'text/html' })
      .end('<a href="/invoices/Rechnung.pdf" target="_blank">Rechnung</a>');
  });
  try {
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing fixture port');
    await portal.goto(`http://127.0.0.1:${address.port}/`);
    const [invoice] = await Promise.all([
      portal.waitForEvent('popup'),
      portal.getByRole('link', { name: 'Rechnung' }).click(),
    ]);
    const nativeViewer = () =>
      invoice
        .mainFrame()
        .childFrames()
        .find((frame) =>
          frame
            .url()
            .startsWith('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/'),
        );
    await expect.poll(() => Boolean(nativeViewer())).toBe(true);
    const viewer = nativeViewer()!;
    await expect(viewer.locator('#pagelength')).toHaveText('2');
    await expect(viewer.getByRole('button', { name: 'Drucken' })).toBeEnabled();
    const content = viewer
      .childFrames()
      .find((frame) => frame.url() === invoice.url())!;
    const pdfPlugin = content.locator(
      'embed[type="application/x-google-chrome-pdf"]',
    );
    await expect(pdfPlugin).toHaveAttribute('full-frame', '');
    await expect(pdfPlugin).toHaveAttribute('original-url', invoice.url());
    await invoice.bringToFront();
    const pageNumber = viewer.getByRole('textbox', { name: 'Seitennummer' });
    await pageNumber.click();
    await pageNumber.fill('2');
    await pageNumber.press('Enter');
    await expect
      .poll(() => content.evaluate(() => window.scrollY))
      .toBeGreaterThan(0);
    expect(invoiceRequests).toBe(1);
    const [saved] = await Promise.all([
      invoice.waitForEvent('download', { timeout: 5_000 }),
      viewer.getByRole('button', { name: 'Herunterladen' }).click(),
    ]);
    expect(saved.suggestedFilename()).toBe('Rechnung.pdf');
    expect(await readFile((await saved.path())!)).toEqual(pdf);
    expect(invoiceRequests).toBe(1);
  } finally {
    await context.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
