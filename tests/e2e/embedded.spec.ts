import { browserLocale } from './locale.js';
import { chromium, expect, test } from '@playwright/test';
import { createServer } from 'node:http';
import path from 'node:path';

test('uploads the visible invoice in a portal frame and a blank blob viewer without replaying protected requests', async () => {
  const extension = path.resolve('dist');
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    ...browserLocale('de'),
    args: [
      '--lang=de',
      '--disable-features=ExtensionsMenuAccessControl',
      `--load-extension=${extension}`,
      `--disable-extensions-except=${extension}`,
    ],
  });
  const portal = context.pages()[0]!;
  await portal.setContent('Invoice A');
  const invoice = await portal.pdf();
  await portal.setContent('Invoice B');
  const blobInvoice = await portal.pdf();
  await portal.setContent('Invoice C');
  const remainingInvoice = await portal.pdf();
  const sourceRequests: string[] = [];
  const uploads: Buffer[] = [];
  const server = createServer(async (request, response) => {
    if (request.url === '/api/profile/') {
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ auth_token: 'test-token' }));
      return;
    }
    if (request.url === '/portal' || request.url === '/hidden-preview') {
      const hidden = request.url === '/hidden-preview';
      response.writeHead(200, {
        'content-type': 'text/html',
        'set-cookie': 'session=fixture; HttpOnly; SameSite=Strict; Path=/',
      });
      response.end(
        `<iframe src="/statement?once=${hidden ? 'preview' : 'invoice'}" style="position:fixed;inset:0;width:100%;height:100%;border:0;${hidden ? 'opacity:0' : ''}"></iframe>`,
      );
      return;
    }
    if (request.url === '/choices') {
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          '<object type="application/pdf" data="/statement?once=choice1"></object><object type="application/pdf" data="/statement?once=choice2"></object>',
        );
      return;
    }
    if (request.url?.startsWith('/statement?')) {
      if (
        sourceRequests.includes(request.url) ||
        request.headers.cookie !== 'session=fixture' ||
        request.headers.authorization
      ) {
        response.writeHead(403).end();
      } else {
        response
          .writeHead(200, {
            'content-type': 'application/pdf',
            'cache-control': 'no-store',
          })
          .end(request.url.endsWith('choice1') ? remainingInvoice : invoice);
      }
      sourceRequests.push(request.url);
      return;
    }
    if (
      request.method === 'POST' &&
      request.url === '/api/documents/post_document/'
    ) {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const form = await new Response(Buffer.concat(chunks), {
        headers: { 'content-type': request.headers['content-type']! },
      }).formData();
      const file = form.get('document');
      if (!(file instanceof File)) throw new Error('Missing document');
      uploads.push(Buffer.from(await file.arrayBuffer()));
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify('12345678-1234-4567-89ab-123456789abc'));
      return;
    }
    response.writeHead(404).end();
  });
  try {
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing fixture port');
    const base = `http://127.0.0.1:${address.port}/`;
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent('serviceworker'));
    const id = new URL(worker.url()).host;
    // Preapprove the grants so Chrome can complete the popup's real permission request headlessly.
    const manager = await context.newPage();
    await manager.goto('chrome://extensions/');
    await manager.evaluate(async (id) => {
      const management = (
        chrome as typeof chrome & {
          developerPrivate: {
            addHostPermission(id: string, host: string, done: () => void): void;
          };
        }
      ).developerPrivate;
      for (const origin of ['http://*/*', 'https://*/*'])
        await new Promise<void>((resolve, reject) =>
          management.addHostPermission(id, origin, () => {
            if (chrome.runtime.lastError)
              reject(new Error(chrome.runtime.lastError.message));
            else resolve();
          }),
        );
    }, id);
    await manager.close();
    const setup = await context.newPage();
    const popupUrl = `chrome-extension://${id}/popup.html`;
    await setup.goto(popupUrl);
    await setup.getByLabel('Paperless-Adresse').fill(base);
    await setup.getByLabel('API-Token', { exact: true }).fill('test-token');
    await setup.getByRole('button', { name: 'Verbinden', exact: true }).click();
    await expect(setup.locator('#upload-panel')).toBeVisible();
    await setup.close();

    await portal.goto(new URL('portal', base).href);
    await expect
      .poll(() =>
        portal
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
    await portal.evaluate(() => {
      document.body.tabIndex = -1;
      document.body.focus();
      window.addEventListener('keydown', (event) => {
        if (event.ctrlKey || event.metaKey)
          document.body.dataset[event.key.toLowerCase()] = String(
            event.defaultPrevented,
          );
      });
    });
    for (const key of ['s', 'p']) {
      await portal.keyboard.press(`ControlOrMeta+${key}`);
      await expect(portal.locator('body')).toHaveAttribute(
        `data-${key}`,
        'false',
      );
    }
    const blankEvent = portal.waitForEvent('popup');
    await portal.evaluate((data) => {
      const blank = window.open('about:blank', '_blank')!;
      const pdf = new Blob(
        [Uint8Array.from(atob(data), (value) => value.charCodeAt(0))],
        { type: 'application/pdf' },
      );
      const embed = blank.document.createElement('embed');
      embed.src = URL.createObjectURL(pdf);
      embed.type = 'application/pdf';
      blank.document.body.append(embed);
    }, blobInvoice.toString('base64'));
    const blank = await blankEvent;
    const hidden = await context.newPage();
    await hidden.goto(new URL('hidden-preview', base).href);
    const choices = await context.newPage();
    await choices.goto(new URL('choices', base).href);
    for (const page of [portal, blank, hidden, choices]) {
      await expect
        .poll(
          () =>
            page
              .frames()
              .filter((frame) =>
                frame
                  .url()
                  .startsWith(
                    'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/',
                  ),
              ).length,
        )
        .toBe(page === choices ? 2 : 1);
    }

    await portal.bringToFront();
    const popupEvent = context.waitForEvent('page');
    await worker.evaluate(
      (url) => chrome.tabs.create({ url, active: false }),
      popupUrl,
    );
    const popup = await popupEvent;
    await popup.waitForURL(popupUrl);
    await expect(popup.locator('#send-current')).toBeVisible();
    // Native viewers outlive the extension worker that observed the handoff.
    const cdp = await context.newCDPSession(popup);
    const { targetInfos } = await cdp.send('Target.getTargets');
    const background = targetInfos.find(
      (target) => target.url === worker.url(),
    );
    if (!background) throw new Error('Missing extension worker target');
    const startedAt = await worker.evaluate(() => performance.timeOrigin);
    await cdp.send('Target.closeTarget', { targetId: background.targetId });
    await popup.reload();
    await expect(popup.locator('#send-current')).toBeEnabled();
    const resumed = context
      .serviceWorkers()
      .find((item) => item.url() === worker.url());
    expect(
      await resumed?.evaluate(() => performance.timeOrigin),
    ).toBeGreaterThan(startedAt);
    await popup.locator('#send-current').click();
    await expect(popup.locator('[data-status="accepted"]')).toHaveCount(1);
    expect(uploads).toEqual([invoice]);
    await popup.locator('#send-window').click();
    await expect(popup.locator('[data-status="accepted"]')).toHaveCount(2);
    expect(uploads).toEqual([invoice, blobInvoice]);
    await choices
      .locator('object')
      .last()
      .evaluate((object) => object.remove());
    await popup.locator('#send-window').click();
    await expect(popup.locator('[data-status="accepted"]')).toHaveCount(3);
    expect(uploads).toEqual([invoice, blobInvoice, remainingInvoice]);
    expect(sourceRequests.sort()).toEqual([
      '/statement?once=choice1',
      '/statement?once=choice2',
      '/statement?once=invoice',
      '/statement?once=preview',
    ]);

    await test.step('Open an embedded invoice in its own tab and upload it after closing the portal', async () => {
      const requestsBeforeOpening = [...sourceRequests];
      await hidden.locator('iframe').evaluate((frame) => {
        frame.style.opacity = '1';
      });
      await popup.evaluate(() => chrome.storage.local.remove('settings'));
      await hidden.bringToFront();
      await popup.reload();
      await expect(popup.locator('#settings-panel')).toBeVisible();
      const opening = context.waitForEvent('page');
      await popup
        .getByRole('button', { name: 'Im eigenen PDF-Tab öffnen' })
        .click();
      const detached = await opening;
      await detached.waitForURL(/^filesystem:chrome-extension:/);
      const native = () =>
        detached
          .mainFrame()
          .childFrames()
          .find((frame) =>
            frame
              .url()
              .startsWith(
                'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/',
              ),
          );
      await expect.poll(() => Boolean(native())).toBe(true);
      await expect(native()!.locator('#pagelength')).toHaveText('1');
      await expect(
        native()!.getByRole('button', { name: 'Drucken' }),
      ).toBeEnabled();
      expect(uploads).toHaveLength(3);
      await hidden.close();
      await popup.evaluate(
        (url) =>
          chrome.storage.local.set({ settings: { url, token: 'test-token' } }),
        base,
      );
      await detached.bringToFront();
      await popup.reload();
      await expect(popup.locator('#open-original')).toBeHidden();
      await expect(popup.locator('#send-current')).toBeEnabled();
      await popup.locator('#send-current').click();
      await expect.poll(() => uploads.length).toBe(4);
      expect(uploads[3]).toEqual(invoice);
      expect(sourceRequests).toEqual(requestsBeforeOpening);
    });
  } finally {
    await context.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
