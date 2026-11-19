import { chromium, expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';

test('saving a newly opened invoice uses its displayed PDF and filename', async ({}, testInfo) => {
  const extension = path.resolve('dist');
  const context = await chromium.launchPersistentContext(
    testInfo.outputPath('profile'),
    {
      channel: 'chromium',
      args: [
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
      ],
    },
  );
  const pdf = await context.pages()[0]!.pdf();
  let invoiceRequests = 0;
  const server = createServer((request, response) => {
    if (request.url === '/invoices/Rechnung.pdf') {
      invoiceRequests++;
      if (invoiceRequests !== 1) {
        response.writeHead(410).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/pdf' }).end(pdf);
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
    const portal = context.pages()[0]!;
    await portal.goto(`http://127.0.0.1:${address.port}/`);
    const [invoice] = await Promise.all([
      portal.waitForEvent('popup'),
      portal.getByRole('link', { name: 'Rechnung' }).click(),
    ]);
    await expect
      .poll(() =>
        invoice
          .frames()
          .some((frame) =>
            frame
              .url()
              .startsWith(
                'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/',
              ),
          ),
      )
      .toBe(true);
    await invoice.bringToFront();
    const [saved] = await Promise.all([
      invoice.waitForEvent('download', { timeout: 5_000 }),
      invoice.keyboard.press('ControlOrMeta+s'),
    ]);
    expect(saved.suggestedFilename()).toBe('Rechnung.pdf');
    expect(await readFile((await saved.path())!)).toEqual(pdf);
    expect(invoiceRequests).toBe(1);
  } finally {
    await context.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
