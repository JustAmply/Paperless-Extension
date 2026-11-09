import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type CDPSession,
} from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const token = 'toolbar-fixture-token';
const taskId = '12345678-1234-4567-89ab-123456789abc';

// Toolbar popups are real CDP targets, but Playwright does not expose them as
// Pages. Inspect their DOM using the public protocol without replacing it.
async function popupSession(cdp: CDPSession, targetId: string) {
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId });
  let commandId = 0;
  return async (
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> => {
    const id = ++commandId;
    return new Promise((resolve, reject) => {
      const listener = (event: { sessionId: string; message: string }) => {
        if (event.sessionId !== sessionId) return;
        const message = JSON.parse(event.message) as {
          id?: number;
          error?: { message: string };
          result?: Record<string, unknown>;
        };
        if (message.id !== id) return;
        cdp.off('Target.receivedMessageFromTarget', listener);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result ?? {});
      };
      cdp.on('Target.receivedMessageFromTarget', listener);
      void cdp
        .send('Target.sendMessageToTarget', {
          sessionId,
          message: JSON.stringify({ id, method, params }),
        })
        .catch((error: unknown) => {
          cdp.off('Target.receivedMessageFromTarget', listener);
          reject(error);
        });
    });
  };
}

function samplePdf(padding = 0): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << >> /Contents 4 0 R >>',
    `<< /Length ${padding} >>\nstream\n${' '.repeat(padding)}\nendstream`,
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

for (const sourceType of ['get', 'post', 'single-use', 'blob'] as const) {
  test(`the toolbar confirms upload of a ${sourceType} PDF without fetching it again or duplicating POSTs`, async ({}, testInfo) => {
    test.setTimeout(60_000);
    const pdf = samplePdf();
    const expectedName =
      sourceType === 'blob'
        ? `PDF von localhost – ${createHash('sha256').update(pdf).digest('hex').slice(0, 8)}.pdf`
        : 'Rechnung März.pdf';
    const uploads: {
      authorization: string | undefined;
      name: string;
      content: Buffer;
    }[] = [];
    const sourceRequests: (string | undefined)[] = [];
    const sourceMethods: string[] = [];
    let context: BrowserContext | undefined;
    let server: Server | undefined;
    try {
      server = createServer(async (request, response) => {
        if (request.url === '/oversize.pdf') {
          const large = samplePdf(50 * 1024 * 1024);
          response.writeHead(200, {
            'content-type': 'application/pdf',
            'content-length': large.length,
          });
          response.end(large);
          return;
        }
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
        if (request.method === 'GET' && request.url === '/form') {
          response.writeHead(200, { 'content-type': 'text/html' });
          response.end(
            '<form method="post" action="/download?id=42"><input name="document" value="42"><button>Open PDF</button></form>',
          );
          return;
        }
        if (request.url === '/download?id=42') {
          sourceRequests.push(request.headers.authorization);
          sourceMethods.push(request.method ?? '');
          if (
            (sourceType === 'post' && request.method !== 'POST') ||
            (sourceType === 'single-use' && sourceRequests.length > 1)
          ) {
            response.writeHead(410);
            response.end();
            return;
          }
          if (sourceType === 'post') {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            expect(Buffer.concat(chunks).toString()).toBe('document=42');
          }
          const content =
            sourceType === 'post' && sourceMethods.length > 1
              ? Buffer.concat([pdf, Buffer.from('% different document\n')])
              : pdf;
          response.writeHead(200, {
            'content-type': 'application/pdf',
            'content-length': content.length,
            'content-disposition':
              sourceType === 'post' && sourceMethods.length > 1
                ? 'inline; filename="Neue Rechnung.pdf"'
                : "inline; filename=invoice.pdf; filename*=UTF-8''Rechnung%20M%C3%A4rz.pdf",
            'cache-control': 'no-store',
          });
          response.end(content);
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
          if (!(document instanceof File))
            throw new Error('Missing PDF upload');
          uploads.push({
            authorization: request.headers.authorization,
            name: document.name,
            content: Buffer.from(await document.arrayBuffer()),
          });
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify(taskId));
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
      // Distinct hostnames still verify source requests never carry the API token.
      let sourceUrl = `http://localhost:${address.port}/download?id=42`;
      let navigationUrl =
        sourceType === 'get' ? `${sourceUrl}#page=1&zoom=150` : sourceUrl;
      const extensionPath = path.resolve('dist');
      context = await chromium.launchPersistentContext(
        testInfo.outputPath('profile'),
        {
          channel: 'chromium',
          headless: true,
          args: [
            `--disable-extensions-except=${extensionPath}`,
            `--load-extension=${extensionPath}`,
            '--enable-unsafe-extension-debugging',
          ],
        },
      );
      const worker =
        context.serviceWorkers()[0] ??
        (await context.waitForEvent('serviceworker'));
      const id = new URL(worker.url()).host;
      const sourceCache = () =>
        worker.evaluate(async () => {
          const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open('paperless-upload');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          try {
            return await new Promise<
              { tabId: number; size: number; error?: string }[]
            >((resolve, reject) => {
              const request = db
                .transaction('sources')
                .objectStore('sources')
                .getAll();
              request.onsuccess = () =>
                resolve(
                  request.result.map(
                    (item: { tabId: number; file?: Blob; error?: string }) => ({
                      tabId: item.tabId,
                      size: item.file?.size ?? 0,
                      ...(item.error ? { error: item.error } : {}),
                    }),
                  ),
                );
              request.onerror = () => reject(request.error);
            });
          } finally {
            db.close();
          }
        });
      const manager = await context.newPage();
      await manager.goto('chrome://extensions/');
      await manager.evaluate(
        async ({ extensionId, host }) => {
          const browser = chrome as typeof chrome & {
            developerPrivate: {
              addHostPermission: (
                extensionId: string,
                host: string,
                callback: () => void,
              ) => void;
            };
          };
          await new Promise<void>((resolve, reject) =>
            browser.developerPrivate.addHostPermission(
              extensionId,
              host,
              () => {
                const error = chrome.runtime.lastError;
                if (error) reject(new Error(error.message));
                else resolve();
              },
            ),
          );
        },
        { extensionId: id, host: '*://*/*' },
      );
      await manager.close();
      const setup = await context.newPage();
      await setup.goto(`chrome-extension://${id}/popup.html`);
      // Restore the preapproved origins through permissions.request during setup,
      // so Chrome dispatches onAdded and enables the response listener.
      await setup.evaluate(() =>
        chrome.permissions.remove({ origins: ['https://*/*', 'http://*/*'] }),
      );
      await setup.reload();
      await setup.getByLabel('Paperless-Adresse').fill(baseUrl);
      await setup.getByLabel('API-Token', { exact: true }).fill(token);
      await setup
        .getByRole('button', { name: 'Verbinden', exact: true })
        .click();
      await expect(setup.locator('#upload-panel')).toBeVisible();
      const permissions = await worker.evaluate(() =>
        chrome.permissions.getAll(),
      );
      expect(
        await worker.evaluate(() =>
          chrome.permissions.contains({
            origins: ['http://*/*', 'https://*/*'],
          }),
        ),
      ).toBe(true);
      await setup.close();
      const page = await context.newPage();
      if (sourceType === 'post') {
        await page.goto(`http://localhost:${address.port}/form`);
        await page.getByRole('button', { name: 'Open PDF' }).click();
        await page.waitForURL(sourceUrl);
      } else if (sourceType === 'blob') {
        await page.goto(`http://localhost:${address.port}/form`);
        sourceUrl = await page.evaluate(
          (bytes) => {
            const blob = new Blob([new Uint8Array(bytes)], {
              type: 'application/pdf',
            });
            return URL.createObjectURL(blob);
          },
          [...pdf],
        );
        navigationUrl = `${sourceUrl}#page=1&zoom=150`;
        await page.goto(navigationUrl);
      } else await page.goto(navigationUrl);
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
      if (sourceType === 'get' || sourceType === 'blob') {
        const handler = page
          .frames()
          .find(
            (frame) => frame.url() === `chrome-extension://${id}/capture.html`,
          );
        expect(handler).toBeDefined();
        await expect(handler!.locator('iframe')).toHaveAttribute(
          'src',
          /#page=1&zoom=150$/,
        );
        await mkdir(path.resolve('artifacts/screenshots'), { recursive: true });
        await page.screenshot({
          path: path.resolve('artifacts/screenshots/pdf-viewer.png'),
        });
      }
      await page.bringToFront();
      const browserCdp = await context.browser()!.newBrowserCDPSession();
      const { targetInfos } = await browserCdp.send('Target.getTargets', {
        filter: [{}],
      });
      const targetInfo = targetInfos.find(
        (target) => target.type === 'tab' && target.url === navigationUrl,
      );
      if (!targetInfo)
        throw new Error('The active PDF has no browser tab target');
      const openAction = async () => {
        await browserCdp.send('Extensions.triggerAction', {
          id,
          targetId: targetInfo.targetId,
        });
        let popupId: string | undefined;
        await expect
          .poll(async () => {
            const targets = await browserCdp.send('Target.getTargets');
            popupId = targets.targetInfos.find(
              (target) => target.url === `chrome-extension://${id}/popup.html`,
            )?.targetId;
            return Boolean(popupId);
          })
          .toBe(true);
        const command = await popupSession(browserCdp, popupId!);
        await expect
          .poll(async () => {
            const result = await command('Runtime.evaluate', {
              expression: 'document.querySelector("#upload-panel")?.hidden',
              returnByValue: true,
            });
            return (result['result'] as { value?: string })?.value;
          })
          .toBe(false);
        return { popupId: popupId!, command };
      };
      const first = await openAction();
      expect(uploads).toHaveLength(0);
      expect(sourceMethods).toEqual(
        sourceType === 'blob' ? [] : [sourceType === 'post' ? 'POST' : 'GET'],
      );
      await first.command('Runtime.evaluate', {
        expression: 'document.querySelector("#send-current").click()',
      });
      await expect
        .poll(async () => {
          const result = await first.command('Runtime.evaluate', {
            expression:
              'document.querySelector("#job-list [data-status=accepted] .job-message")?.textContent',
            returnByValue: true,
          });
          return (result['result'] as { value?: string })?.value;
        })
        .toBe('An Paperless übertragen');
      await expect.poll(() => uploads.length).toBe(1);
      expect(uploads[0]).toEqual({
        authorization: `Token ${token}`,
        name: expectedName,
        content: pdf,
      });
      expect(sourceRequests).toHaveLength(sourceType === 'blob' ? 0 : 1);
      expect(
        sourceRequests.every((authorization) => authorization === undefined),
      ).toBe(true);
      const layout = await first.command('Page.getLayoutMetrics');
      const contentSize = layout['cssContentSize'] as {
        x: number;
        y: number;
        width: number;
        height: number;
      };
      const screenshot = await first.command('Page.captureScreenshot', {
        captureBeyondViewport: true,
        clip: { ...contentSize, scale: 1 },
      });
      const screenshots = path.resolve('artifacts/screenshots');
      await mkdir(screenshots, { recursive: true });
      await writeFile(
        path.join(screenshots, 'toolbar-uploaded.png'),
        Buffer.from(screenshot['data'] as string, 'base64'),
      );
      await browserCdp.send('Target.closeTarget', { targetId: first.popupId });
      const second = await openAction();
      const stateResult = await second.command('Runtime.evaluate', {
        expression:
          'chrome.runtime.sendMessage({ target: "background", type: "state" })',
        awaitPromise: true,
        returnByValue: true,
      });
      const jobState = (stateResult['result'] as { value: unknown }).value;
      expect(jobState).toHaveProperty('state.jobs.length', 1);
      expect(jobState).toMatchObject({
        state: {
          jobs: [
            {
              status: 'accepted',
              name: expectedName,
              source: { url: sourceUrl },
            },
          ],
        },
      });
      expect(uploads).toHaveLength(1);
      expect(sourceRequests).toHaveLength(sourceType === 'blob' ? 0 : 1);
      if (sourceType === 'blob') {
        const button = await second.command('Runtime.evaluate', {
          expression:
            'document.querySelector("#send-current").matches(":not([hidden]):disabled")',
          returnByValue: true,
        });
        expect(button['result']).toMatchObject({ value: true });
      }
      expect(
        (await worker.evaluate(() => chrome.permissions.getAll())).origins,
      ).toEqual(permissions.origins);
      await browserCdp.send('Target.closeTarget', { targetId: second.popupId });
      if (sourceType === 'post') {
        await page.goto(`http://localhost:${address.port}/form`);
        await page.getByRole('button', { name: 'Open PDF' }).click();
        await page.waitForURL(sourceUrl);
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
        const next = await openAction();
        await expect
          .poll(async () => {
            const result = await next.command('Runtime.evaluate', {
              expression: 'document.querySelector("#send-current").disabled',
              returnByValue: true,
            });
            return (result['result'] as { value?: boolean }).value;
          })
          .toBe(false);
        expect(uploads).toHaveLength(1);
        await next.command('Runtime.evaluate', {
          expression: 'document.querySelector("#send-current").click()',
        });
        await expect.poll(() => uploads.length).toBe(2);
        expect(uploads[1]?.name).toBe('Neue Rechnung.pdf');
        expect(uploads[1]?.content).toEqual(
          Buffer.concat([pdf, Buffer.from('% different document\n')]),
        );
        expect(sourceMethods).toEqual(['POST', 'POST']);
        await browserCdp.send('Target.closeTarget', { targetId: next.popupId });
      }
      if (sourceType === 'get') {
        const original = (await sourceCache())[0]!;
        const replacement = await context.newPage();
        await replacement.goto(`chrome-extension://${id}/popup.html`);
        // Fill the real cache without running 25 PDF viewer processes.
        const ready = await replacement.evaluate(async (url) => {
          const { capturePdf, capturedSources, clearCapturedPdf } =
            (await import(
              chrome.runtime.getURL('data/sources.js')
            )) as typeof import('../../src/data/sources.js');
          const file = new Blob([new Uint8Array(5 * 1024 * 1024)]);
          const createdAt = Date.now();
          for (let index = 1; index <= 25; index++)
            await capturePdf({
              tabId: -index,
              url,
              name: 'Cache fixture.pdf',
              fingerprint: `fixture-${index}`,
              createdAt: createdAt + index,
              file,
            });
          const sources = await capturedSources();
          for (const source of sources)
            if (source.tabId < 0) await clearCapturedPdf(source.tabId);
          return sources.filter((source) => source.availability === 'ready')
            .length;
        }, sourceUrl);
        expect(ready).toBe(25);
        expect(await sourceCache()).toEqual([
          {
            tabId: original.tabId,
            size: 0,
            error: expect.stringContaining('nicht mehr verfügbar'),
          },
        ]);
        const localFiles = Array.from({ length: 11 }, (_, index) => ({
          name: `Local ${index + 1}.pdf`,
          mimeType: 'application/pdf',
          buffer: pdf,
        }));
        await replacement.locator('#file-input').setInputFiles(localFiles);
        await expect(replacement.locator('[data-status=accepted]')).toHaveCount(
          localFiles.length,
        );
        await replacement.close();
        await page.bringToFront();
        const evicted = await openAction();
        const unavailableButton = await evicted.command('Runtime.evaluate', {
          expression: 'document.querySelector("#send-current").disabled',
          returnByValue: true,
        });
        expect((unavailableButton['result'] as { value: boolean }).value).toBe(
          true,
        );
        await expect
          .poll(async () => {
            const result = await evicted.command('Runtime.evaluate', {
              expression:
                'document.querySelector("#current-status")?.textContent',
              returnByValue: true,
            });
            return (result['result'] as { value?: string }).value;
          })
          .toContain('nicht mehr verfügbar');
        expect(sourceRequests).toHaveLength(1);
        expect(uploads.slice(1).map((upload) => upload.name)).toEqual(
          localFiles.map((file) => file.name),
        );
        await browserCdp.send('Target.closeTarget', {
          targetId: evicted.popupId,
        });
        await page.goto(`http://localhost:${address.port}/oversize.pdf`);
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
        expect(await sourceCache()).toEqual([
          {
            tabId: original.tabId,
            size: 0,
            error: expect.stringContaining('zu groß'),
          },
        ]);
      }
      await page.goto(`http://localhost:${address.port}/form`);
      await expect.poll(async () => (await sourceCache()).length).toBe(0);
      if (sourceType === 'get') {
        const closed = await context.newPage();
        await closed.goto(sourceUrl);
        await expect
          .poll(
            async () =>
              (await sourceCache()).filter((item) => item.size > 0).length,
          )
          .toBe(1);
        await closed.close();
        await expect.poll(async () => (await sourceCache()).length).toBe(0);
      }
    } finally {
      await context?.close();
      if (server)
        await new Promise<void>((resolve, reject) =>
          server!.close((error) => (error ? reject(error) : resolve())),
        );
    }
  });
}
