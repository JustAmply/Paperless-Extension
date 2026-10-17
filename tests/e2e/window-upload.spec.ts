import { chromium, expect, test, type BrowserContext } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

function samplePdf(): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << >> /Contents 4 0 R >>',
    '<< /Length 0 >>\nstream\n\nendstream',
  ];
  let document = '%PDF-1.7\n';
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(document);
    document += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(document);
  document += `xref\n0 5\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(document);
}

test('window upload finds extensionless PDFs, skips HTML and other windows, and avoids repeated uploads', async () => {
  const pdf = samplePdf();
  const token = 'window-fixture-token';
  const uploads: {
    authorization: string | undefined;
    name: string;
    content: Buffer;
  }[] = [];
  const sourceRequests: {
    url: string;
    authorization: string | undefined;
  }[] = [];
  let context: BrowserContext | undefined;
  let server: Server | undefined;
  try {
    server = createServer(async (request, response) => {
      if (request.method === 'GET' && request.url === '/paperless/api/') {
        response.writeHead(302, { location: 'schema/view/' });
        response.end();
        return;
      }
      if (
        request.method === 'GET' &&
        request.url === '/paperless/api/profile/'
      ) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ email: '', auth_token: token }));
        return;
      }
      if (request.method === 'GET' && request.url?.startsWith('/download')) {
        sourceRequests.push({
          url: request.url,
          authorization: request.headers.authorization,
        });
        const name = new URL(
          request.url,
          'http://fixture.invalid',
        ).searchParams.get('id');
        response.writeHead(200, {
          'content-type': 'application/pdf',
          'content-length': pdf.length,
          'content-disposition': `inline; filename="${name}.pdf"`,
          'cache-control': 'no-store',
        });
        response.end(pdf);
        return;
      }
      if (request.method === 'GET' && request.url === '/ordinary') {
        sourceRequests.push({
          url: request.url,
          authorization: request.headers.authorization,
        });
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(
          '<!doctype html><title>Ordinary page</title><p>No PDF</p>',
        );
        return;
      }
      if (
        request.method === 'POST' &&
        request.url === '/paperless/api/documents/post_document/'
      ) {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const form = await new Request('http://fixture.invalid/', {
          method: 'POST',
          headers: { 'content-type': request.headers['content-type'] ?? '' },
          body: Buffer.concat(chunks),
        }).formData();
        const document = form.get('document');
        if (!(document instanceof File)) throw new Error('Missing PDF upload');
        uploads.push({
          authorization: request.headers.authorization,
          name: document.name,
          content: Buffer.from(await document.arrayBuffer()),
        });
        const unconfirmed = document.name === 'Unconfirmed.pdf';
        response.writeHead(unconfirmed ? 502 : 200, {
          'content-type': 'application/json',
        });
        response.end(
          JSON.stringify(
            unconfirmed
              ? { detail: 'Fixture gateway error after accepting the body' }
              : '12345678-1234-4567-89ab-123456789abc',
          ),
        );
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing fixture port');
    const baseUrl = `http://127.0.0.1:${address.port}/paperless/`;
    const sourceOrigin = `http://localhost:${address.port}`;
    const firstUrl = `${new URL(baseUrl).origin}/download?id=First`;
    const secondUrl = `${sourceOrigin}/download?id=Second`;
    const otherUrl = `${sourceOrigin}/download?id=OtherWindow`;
    const extensionPath = path.resolve('dist');
    context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      viewport: { width: 390, height: 700 },
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--disable-features=ExtensionsMenuAccessControl',
      ],
    });
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent('serviceworker'));
    const id = new URL(worker.url()).host;
    const popupUrl = `chrome-extension://${id}/popup.html`;
    const manager = await context.newPage();
    await manager.goto('chrome://extensions/');
    await manager.evaluate(
      async ({ extensionId, origins }) => {
        const browser = chrome as typeof chrome & {
          developerPrivate: {
            addHostPermission: (
              extensionId: string,
              host: string,
              callback: () => void,
            ) => void;
          };
        };
        for (const host of origins) {
          await new Promise<void>((resolve, reject) => {
            browser.developerPrivate.addHostPermission(
              extensionId,
              host,
              () => {
                const error = chrome.runtime.lastError;
                if (error) reject(new Error(error.message));
                else resolve();
              },
            );
          });
        }
      },
      {
        extensionId: id,
        origins: [`${new URL(baseUrl).origin}/*`, `${sourceOrigin}/*`],
      },
    );
    await manager.close();
    const setup = await context.newPage();
    await setup.goto(popupUrl);
    await setup.getByLabel('Paperless-Adresse').fill(baseUrl);
    await setup.getByLabel('API-Token', { exact: true }).fill(token);
    await setup.getByRole('button', { name: 'Verbinden', exact: true }).click();
    await expect(setup.locator('#upload-panel')).toBeVisible();
    await setup.close();
    const first = await context.newPage();
    await first.goto(firstUrl);
    const second = await context.newPage();
    await second.goto(secondUrl);
    const duplicate = await context.newPage();
    await duplicate.goto(firstUrl);
    const ordinary = await context.newPage();
    await ordinary.goto(`${sourceOrigin}/ordinary`);
    for (const page of [first, second, duplicate]) {
      await expect
        .poll(() =>
          page
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
    }
    const firstTab = await worker.evaluate(
      async (url) =>
        (await chrome.tabs.query({})).find((tab) => tab.url === url),
      firstUrl,
    );
    if (firstTab?.id === undefined) throw new Error('Missing source tab');
    const otherWindow = await worker.evaluate(
      async (url) => chrome.windows.create({ url, focused: false }),
      otherUrl,
    );
    await expect
      .poll(async () =>
        worker.evaluate(
          async (windowId) =>
            (await chrome.tabs.query({ windowId })).some(
              (tab) =>
                tab.url?.includes('OtherWindow') && tab.status === 'complete',
            ),
          otherWindow.id,
        ),
      )
      .toBe(true);
    await worker.evaluate(
      async ({ tabId, windowId }) => {
        await chrome.windows.update(windowId, { focused: true });
        await chrome.tabs.update(tabId, { active: true });
      },
      { tabId: firstTab.id, windowId: firstTab.windowId },
    );

    // Opening the UI in an inactive tab preserves the active PDF for the same
    // automatic single-tab upload used by a toolbar popup.
    const popupEvent = context.waitForEvent('page');
    await worker.evaluate(
      async ({ url, windowId }) =>
        chrome.tabs.create({ url, windowId, active: false }),
      { url: popupUrl, windowId: firstTab.windowId },
    );
    const popup = await popupEvent;
    await popup.waitForURL(popupUrl);
    await expect(
      popup.locator('#job-list [data-status="accepted"]'),
    ).toContainText('First.pdf');
    await expect.poll(() => uploads.length).toBe(1);
    await popup.bringToFront();
    const htmlRequests = sourceRequests.filter(
      (request) => request.url === '/ordinary',
    ).length;
    const firstRequests = sourceRequests.filter(
      (request) => request.url === '/download?id=First',
    ).length;
    const otherRequests = sourceRequests.filter(
      (request) => request.url === '/download?id=OtherWindow',
    ).length;

    await popup.locator('#send-window').click();
    await expect.poll(() => uploads.length).toBe(2);
    await expect(
      popup.locator('#job-list [data-status="accepted"]'),
    ).toContainText(['First.pdf', 'Second.pdf']);
    expect(uploads.map((upload) => upload.name)).toEqual([
      'First.pdf',
      'Second.pdf',
    ]);
    expect(
      uploads.every(
        (upload) =>
          upload.authorization === `Token ${token}` &&
          upload.content.equals(pdf),
      ),
    ).toBe(true);
    expect(
      sourceRequests.every((request) => request.authorization === undefined),
    ).toBe(true);
    expect(
      sourceRequests.filter((request) => request.url === '/ordinary'),
    ).toHaveLength(htmlRequests);
    expect(
      sourceRequests.filter((request) => request.url === '/download?id=First'),
    ).toHaveLength(firstRequests);
    expect(
      sourceRequests.filter(
        (request) => request.url === '/download?id=OtherWindow',
      ),
    ).toHaveLength(otherRequests);
    await expect(popup.locator('#send-window')).toBeEnabled();
    await popup.locator('#send-window').click();
    await expect(popup.locator('#send-window')).toBeEnabled();
    expect(uploads).toHaveLength(2);
    const screenshots = path.resolve('artifacts/screenshots');
    await mkdir(screenshots, { recursive: true });
    await popup.mouse.move(0, 0);
    await popup.locator('body').screenshot({
      path: path.join(screenshots, 'window-uploaded.png'),
      animations: 'disabled',
    });

    const unconfirmedEvent = context.waitForEvent('page');
    const unconfirmedUrl = `${sourceOrigin}/download?id=Unconfirmed`;
    await worker.evaluate(
      async ({ url, windowId }) =>
        chrome.tabs.create({ url, windowId, active: false }),
      { url: unconfirmedUrl, windowId: firstTab.windowId },
    );
    const unconfirmed = await unconfirmedEvent;
    await unconfirmed.waitForURL(unconfirmedUrl);
    await expect
      .poll(() =>
        unconfirmed
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
    await popup.locator('#send-window').click();
    await expect(
      popup.locator('#job-list [data-status="uncertain"]'),
    ).toContainText('Unconfirmed.pdf');
    expect(uploads).toHaveLength(3);
    await expect(popup.locator('#send-window')).toBeEnabled();
    await popup.locator('#send-window').click();
    await expect(popup.locator('#send-window')).toBeEnabled();
    await expect(
      popup.locator('#job-list [data-status="uncertain"]'),
    ).toContainText('Unconfirmed.pdf');
    expect(uploads.map((upload) => upload.name)).toEqual([
      'First.pdf',
      'Second.pdf',
      'Unconfirmed.pdf',
    ]);
    await expect(
      popup.locator('#job-list [data-status="accepted"]'),
    ).toHaveCount(2);
    const warning = popup.locator(
      '#job-list [data-status="uncertain"] .job-message',
    );
    await expect(warning).toContainText('Keine Bestätigung erhalten.');
    await warning.scrollIntoViewIfNeeded();
    await popup.mouse.move(0, 0);
    await popup.locator('body').screenshot({
      path: path.join(screenshots, 'window-uncertain.png'),
      animations: 'disabled',
    });
    const permissions = await worker.evaluate(() =>
      chrome.permissions.getAll(),
    );
    expect(permissions.origins?.sort()).toEqual(
      [`${new URL(baseUrl).origin}/*`, `${sourceOrigin}/*`].sort(),
    );
  } finally {
    await context?.close();
    if (server)
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      );
  }
});
