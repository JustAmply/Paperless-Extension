import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type CDPSession,
} from '@playwright/test';
import { createServer, type Server } from 'node:http';
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

test('the toolbar action uploads the active PDF without permanent source access or duplicate POSTs', async ({}, testInfo) => {
  const pdf = samplePdf();
  const uploads: {
    authorization: string | undefined;
    name: string;
    content: Buffer;
  }[] = [];
  const sourceRequests: (string | undefined)[] = [];
  let context: BrowserContext | undefined;
  let server: Server | undefined;
  try {
    server = createServer(async (request, response) => {
      if (request.method === 'GET' && request.url === '/paperless/api/') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            documents: 'http://fixture.invalid/api/documents/',
          }),
        );
        return;
      }
      if (request.method === 'GET' && request.url === '/download?id=42') {
        sourceRequests.push(request.headers.authorization);
        response.writeHead(200, {
          'content-type': 'application/pdf',
          'content-length': pdf.length,
          'content-disposition': 'inline; filename="Toolbar.pdf"',
          'cache-control': 'no-store',
        });
        response.end(pdf);
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
    // Match patterns ignore ports. Distinct hostnames keep the PDF source outside
    // the server permission and exercise the real temporary activeTab grant.
    const sourceUrl = `http://localhost:${address.port}/download?id=42`;
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
          '--disable-features=ExtensionsMenuAccessControl',
        ],
      },
    );
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent('serviceworker'));
    const id = new URL(worker.url()).host;
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
          browser.developerPrivate.addHostPermission(extensionId, host, () => {
            const error = chrome.runtime.lastError;
            if (error) reject(new Error(error.message));
            else resolve();
          }),
        );
      },
      { extensionId: id, host: `${new URL(baseUrl).origin}/*` },
    );
    await manager.close();
    const setup = await context.newPage();
    await setup.goto(`chrome-extension://${id}/popup.html`);
    await setup.getByLabel('Paperless-Adresse').fill(baseUrl);
    await setup.getByLabel('API-Token', { exact: true }).fill(token);
    await setup.getByRole('button', { name: 'Verbinden', exact: true }).click();
    await expect(setup.locator('#upload-panel')).toBeVisible();
    const permissions = await worker.evaluate(() =>
      chrome.permissions.getAll(),
    );
    expect(permissions.origins).toEqual([`${new URL(baseUrl).origin}/*`]);
    await setup.close();
    const page = await context.newPage();
    await page.goto(sourceUrl);
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
    await page.bringToFront();
    const browserCdp = await context.browser()!.newBrowserCDPSession();
    const { targetInfos } = await browserCdp.send('Target.getTargets', {
      filter: [{}],
    });
    const targetInfo = targetInfos.find(
      (target) => target.type === 'tab' && target.url === sourceUrl,
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
            expression:
              'document.querySelector("#job-list [data-status=accepted] .job-message")?.textContent',
            returnByValue: true,
          });
          return (result['result'] as { value?: string })?.value;
        })
        .toBe('An Paperless übertragen');
      return { popupId: popupId!, command };
    };
    const first = await openAction();
    await expect.poll(() => uploads.length).toBe(1);
    expect(uploads[0]).toEqual({
      authorization: `Token ${token}`,
      name: 'Toolbar.pdf',
      content: pdf,
    });
    expect(sourceRequests.length).toBeGreaterThanOrEqual(2);
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
            name: 'Toolbar.pdf',
            source: { url: sourceUrl },
          },
        ],
      },
    });
    expect(uploads).toHaveLength(1);
    expect(
      (await worker.evaluate(() => chrome.permissions.getAll())).origins,
    ).toEqual(permissions.origins);
    await browserCdp.send('Target.closeTarget', { targetId: second.popupId });
  } finally {
    await context?.close();
    if (server)
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      );
  }
});
