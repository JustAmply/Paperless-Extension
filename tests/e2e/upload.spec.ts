import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const pdf = Buffer.from(
  '%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n',
);
const token = 'fixture-token';
const taskId = '12345678-1234-4567-89ab-123456789abc';
const screenshots = path.resolve('artifacts/screenshots');

interface Upload {
  authorization: string | undefined;
  fields: string[];
  name: string;
  content: Buffer;
}

let server: Server;
let baseUrl: string;
let uploads: Upload[] = [];
let sourceRequests = 0;
let sourceStatus = 200;
let sourceBody = pdf;
let taskRequests = 0;
let taskStatus = 'SUCCESS';
let taskHttpStatus = 200;
let relatedDocument: string | null = '42';
let slowTask = false;
let releaseTask: (() => void) | undefined;
let status = 200;
let profileRedirect = false;
let redirectVisits = 0;
let slow = false;
let release: (() => void) | undefined;
let context: BrowserContext;
let popup: Page;
let popupUrl: string;

async function openPopup(): Promise<Page> {
  const page = await context.newPage();
  await page.goto(popupUrl);
  await expect(page.locator('#fatal-error')).toBeHidden();
  return page;
}

async function connect(): Promise<void> {
  await popup.getByLabel('Paperless-Adresse').fill(baseUrl);
  await popup.getByLabel('API-Token', { exact: true }).fill(token);
  await popup.getByRole('button', { name: 'Verbinden', exact: true }).click();
  await expect(popup.locator('#upload-panel')).toBeVisible();
  await expect(popup.locator('#settings-panel')).toBeHidden();
}

async function chooseFile(
  name = 'Rechnung März.pdf',
  content = pdf,
): Promise<void> {
  const chooser = popup.waitForEvent('filechooser');
  await popup.getByRole('button', { name: /PDFs hier hineinziehen/ }).click();
  await (
    await chooser
  ).setFiles({ name, mimeType: 'application/pdf', buffer: content });
}

async function screenshot(name: string): Promise<void> {
  await popup.mouse.move(0, 0);
  await popup.locator('body').screenshot({
    path: path.join(screenshots, `${name}.png`),
    animations: 'disabled',
  });
}

test.beforeAll(async () => {
  await mkdir(screenshots, { recursive: true });
  server = createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/paperless/') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<!doctype html><title>Fixture</title><p>No PDF</p>');
        return;
      }
      if (
        request.method === 'GET' &&
        request.url === `/paperless/api/tasks/?task_id=${taskId}`
      ) {
        taskRequests++;
        expect(request.headers.authorization).toBe(`Token ${token}`);
        expect(request.headers.cookie).toBeUndefined();
        if (slowTask)
          await new Promise<void>((resolve) => {
            releaseTask = resolve;
          });
        response.writeHead(taskHttpStatus, {
          'content-type': 'application/json',
        });
        response.end(
          JSON.stringify([
            {
              task_id: taskId,
              status: taskStatus,
              related_document: relatedDocument,
            },
          ]),
        );
        return;
      }
      if (request.method === 'GET' && request.url === '/current.pdf') {
        sourceRequests++;
        response.writeHead(sourceStatus, { 'content-type': 'application/pdf' });
        response.end(sourceBody);
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
        if (profileRedirect) {
          response.writeHead(302, { location: '/login/' });
          response.end();
          return;
        }
        response.writeHead(
          request.headers.authorization === `Token ${token}` ? 200 : 401,
          {
            'content-type': 'application/json',
          },
        );
        response.end(JSON.stringify({ email: '', auth_token: token }));
        return;
      }
      if (request.url === '/login/') {
        redirectVisits++;
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<html>Proxy login</html>');
        return;
      }
      if (
        request.method === 'POST' &&
        request.url === '/paperless/api/documents/post_document/'
      ) {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const form = await new Request(
          `${baseUrl}api/documents/post_document/`,
          {
            method: 'POST',
            headers: { 'content-type': request.headers['content-type'] ?? '' },
            body: Buffer.concat(chunks),
          },
        ).formData();
        const document = form.get('document');
        if (!(document instanceof File))
          throw new Error('Upload did not contain a file');
        uploads.push({
          authorization: request.headers.authorization,
          fields: [...form.keys()],
          name: document.name,
          content: Buffer.from(await document.arrayBuffer()),
        });
        if (slow)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        response.writeHead(
          request.headers.authorization === `Token ${token}` ? status : 401,
          {
            'content-type': 'application/json',
          },
        );
        response.end(
          JSON.stringify(
            status === 200 ? taskId : { detail: 'Fixture rejection' },
          ),
        );
        return;
      }
      response.writeHead(404);
      response.end();
    } catch (error) {
      response.writeHead(500);
      response.end(String(error));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Fixture server has no TCP address');
  baseUrl = `http://127.0.0.1:${address.port}/paperless/`;
});

async function grantWebAccess(): Promise<void> {
  // Pregrant the one-time web permission through Chrome's real management API. Native
  // permission dialogs are outside Playwright's page automation surface.
  const manager = await context.newPage();
  await manager.goto('chrome://extensions/');
  await manager.evaluate(
    async ({ id, host }) => {
      const browser = chrome as typeof chrome & {
        developerPrivate: {
          addHostPermission: (
            extensionId: string,
            host: string,
            callback: () => void,
          ) => void;
        };
      };
      await new Promise<void>((resolve, reject) => {
        browser.developerPrivate.addHostPermission(id, host, () => {
          const error = chrome.runtime.lastError;
          if (error) reject(new Error(error.message));
          else resolve();
        });
      });
    },
    { id: new URL(popupUrl).host, host: '*://*/*' },
  );
  await manager.close();
}

test.beforeEach(async () => {
  uploads = [];
  sourceRequests = 0;
  sourceStatus = 200;
  sourceBody = pdf;
  taskRequests = 0;
  taskStatus = 'SUCCESS';
  taskHttpStatus = 200;
  relatedDocument = '42';
  slowTask = false;
  releaseTask = undefined;
  status = 200;
  profileRedirect = false;
  redirectVisits = 0;
  slow = false;
  release = undefined;
  const extensionPath = path.resolve('dist');
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    viewport: { width: 390, height: 700 },
    colorScheme: 'light',
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--disable-features=ExtensionsMenuAccessControl',
    ],
  });
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent('serviceworker'));
  const extensionId = new URL(worker.url()).host;
  popupUrl = `chrome-extension://${extensionId}/popup.html`;

  await grantWebAccess();
  popup = await openPopup();
  await expect(popup.locator('#settings-panel')).toBeVisible();
});

test.afterEach(async () => {
  release?.();
  releaseTask?.();
  await context?.close();
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

test('setup and file chooser upload work when the public API root redirects to Swagger', async () => {
  await screenshot('setup');
  await connect();
  await screenshot('ready');
  await popup.emulateMedia({ colorScheme: 'dark' });
  await screenshot('ready-dark');
  await popup.emulateMedia({ colorScheme: 'light' });
  await chooseFile();
  await expect(
    popup.locator('#job-list [data-status="accepted"]'),
  ).toContainText('Rechnung März.pdf');
  expect(uploads).toHaveLength(1);
  expect(uploads[0]).toEqual({
    authorization: `Token ${token}`,
    fields: ['document'],
    name: 'Rechnung März.pdf',
    content: pdf,
  });
  await expect
    .poll(async () =>
      popup.evaluate(async () => {
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('paperless-upload');
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        try {
          return await new Promise<number>((resolve, reject) => {
            const request = database
              .transaction('files')
              .objectStore('files')
              .count();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
        } finally {
          database.close();
        }
      }),
    )
    .toBe(0);
  await screenshot('uploaded');
  await popup
    .getByRole('button', { name: 'Einstellungen', exact: true })
    .click();
  await expect(popup.getByLabel('API-Token', { exact: true })).toHaveValue('');
  await expect(popup.getByLabel('API-Token', { exact: true })).toHaveAttribute(
    'placeholder',
    'Gespeicherten Token beibehalten',
  );
  await popup.reload();
  await expect(popup.locator('#upload-panel')).toBeVisible();
  await expect(
    popup.locator('#job-list [data-status="accepted"]'),
  ).toBeVisible();
  expect(uploads).toHaveLength(1);
});

test('setup rejects invalid tokens and login redirects without saving settings or following the redirect', async () => {
  await popup.getByLabel('Paperless-Adresse').fill(baseUrl);
  await popup
    .getByLabel('API-Token', { exact: true })
    .fill('invalid-fixture-token');
  await popup.getByRole('button', { name: 'Verbinden', exact: true }).click();
  await expect(popup.locator('#settings-status')).toContainText(
    'API-Token ist ungültig',
  );
  await expect(popup.locator('#settings-panel')).toBeVisible();

  profileRedirect = true;
  await popup.getByLabel('API-Token', { exact: true }).fill(token);
  await popup.getByRole('button', { name: 'Verbinden', exact: true }).click();
  await expect(popup.locator('#settings-status')).toContainText(
    'leitet die API-Anfrage weiter',
  );
  expect(redirectVisits).toBe(0);
  expect(uploads).toHaveLength(0);
  expect(
    await popup.evaluate(() => chrome.storage.local.get('settings')),
  ).toEqual({});

  profileRedirect = false;
  await connect();
});

async function useCurrentPdf(): Promise<void> {
  // These tests open the popup in a tab. Supply the active source URL while
  // keeping real extension storage, requests, and upload processing intact.
  await popup.addInitScript((url) => {
    const query = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async (queryInfo) => {
      const tabs = await query(queryInfo);
      return queryInfo.active ? tabs.map((tab) => ({ ...tab, url })) : tabs;
    };
  }, new URL('/current.pdf', baseUrl).href);
  await popup.reload();
}

test('opening the popup and saving settings require an explicit current PDF upload, including failed retries', async () => {
  await useCurrentPdf();
  await connect();
  const send = popup.locator('#send-current');
  await expect(send).toBeEnabled();
  await expect(popup.locator('#document-name')).toHaveText('current.pdf');
  await expect(popup.locator('#document-availability')).toContainText(
    'beim Hochladen geprüft',
  );
  expect(sourceRequests).toBe(0);
  expect(uploads).toHaveLength(0);
  await popup.reload();
  await expect(send).toBeEnabled();
  expect(sourceRequests).toBe(0);
  expect(uploads).toHaveLength(0);

  status = 401;
  await send.click();
  await expect(popup.locator('#job-list [data-status="failed"]')).toBeVisible();
  await expect(send).toBeEnabled();
  await popup.reload();
  await expect(send).toBeEnabled();
  expect(sourceRequests).toBe(1);
  expect(uploads).toHaveLength(1);

  status = 200;
  await send.click();
  await expect(
    popup.locator('#job-list [data-status="accepted"]'),
  ).toBeVisible();
  await expect(send).toBeDisabled();
  await popup.reload();
  await expect(
    popup.locator('#job-list [data-status="accepted"]'),
  ).toBeVisible();
  await expect(send).toBeDisabled();
  expect(sourceRequests).toBe(2);
  expect(uploads).toHaveLength(2);
});

test('the current PDF action remains disabled after an uncertain upload', async () => {
  await useCurrentPdf();
  await connect();
  status = 502;
  const send = popup.locator('#send-current');
  await send.click();
  await expect(
    popup.locator('#job-list [data-status="uncertain"]'),
  ).toBeVisible();
  await expect(send).toBeDisabled();
  await popup.reload();
  await expect(
    popup.locator('#job-list [data-status="uncertain"]'),
  ).toBeVisible();
  await expect(send).toBeDisabled();
  expect(sourceRequests).toBe(1);
  expect(uploads).toHaveLength(1);
});

test('a source 404 can be dismissed permanently without retrying or uploading', async () => {
  await useCurrentPdf();
  await connect();
  sourceStatus = 404;
  await popup.locator('#send-current').click();
  await expect(popup.locator('#job-list [data-status="failed"]')).toContainText(
    'HTTP 404',
  );
  await popup.reload();
  await expect(popup.locator('#job-list')).toContainText('HTTP 404');
  await screenshot('source-error');
  await popup
    .getByRole('button', { name: 'Fehlermeldungen schließen' })
    .click();
  await expect(popup.locator('#job-list li')).toHaveCount(0);
  await popup.reload();
  await expect(popup.locator('#dismiss-failures')).toBeHidden();
  await expect(popup.locator('#job-list li')).toHaveCount(0);
  const worker = context.serviceWorkers()[0]!;
  expect(await worker.evaluate(() => chrome.action.getBadgeText({}))).toBe('');
  expect(sourceRequests).toBe(1);
  expect(uploads).toHaveLength(0);
  await chooseFile('Saved from viewer.pdf');
  await expect(
    popup.locator('#job-list [data-status="accepted"]'),
  ).toBeVisible();
  expect(uploads).toHaveLength(1);
});

test('non-PDF responses remain visible and do not lock the current action', async () => {
  await useCurrentPdf();
  await connect();
  sourceBody = Buffer.from('<html>Sign in</html>');
  await popup.locator('#send-current').click();
  await expect(
    popup.locator('#job-list [data-status="skipped"]'),
  ).toContainText('Keine PDF');
  await expect(popup.locator('#send-current')).toBeEnabled();
  expect(uploads).toHaveLength(0);
  sourceBody = pdf;
  await popup.locator('#send-current').click();
  await expect(
    popup.locator('#job-list [data-status="accepted"]'),
  ).toBeVisible();
  expect(uploads).toHaveLength(1);
});

test('dismissing validation errors retains uncertain outcomes and duplicate protection', async () => {
  await useCurrentPdf();
  await connect();
  status = 502;
  await popup.locator('#send-current').click();
  await expect(
    popup.locator('#job-list [data-status="uncertain"]'),
  ).toBeVisible();
  await chooseFile('invalid.pdf', Buffer.from('not a PDF'));
  await expect(popup.locator('#upload-status')).toContainText('keine PDF');
  await popup
    .getByRole('button', { name: 'Fehlermeldungen schließen' })
    .click();
  await expect(popup.locator('#upload-status')).toBeEmpty();
  await expect(
    popup.locator('#job-list [data-status="uncertain"]'),
  ).toBeVisible();
  await expect(popup.locator('#send-current')).toBeDisabled();
  expect(uploads).toHaveLength(1);
});

test('invalid files stay local and a dropped PDF uploads', async () => {
  await connect();
  await chooseFile('fake.pdf', Buffer.from('<html>This is not a PDF</html>'));
  await expect(popup.locator('#upload-status')).toContainText('keine PDF');
  expect(uploads).toHaveLength(0);
  const transfer = await popup.evaluateHandle(
    (content) => {
      const data = new DataTransfer();
      data.items.add(
        new File([new Uint8Array(content)], 'Dropped.pdf', {
          type: 'application/pdf',
        }),
      );
      return data;
    },
    [...pdf],
  );
  await popup
    .locator('#drop-zone')
    .dispatchEvent('drop', { dataTransfer: transfer });
  await transfer.dispose();
  await expect(
    popup.locator('#job-list [data-status="accepted"]'),
  ).toContainText('Dropped.pdf');
  expect(uploads).toHaveLength(1);
  expect(uploads[0]?.content).toEqual(pdf);
});

test('known API rejections explain the error without retrying the upload', async () => {
  await connect();
  status = 401;
  await chooseFile();
  await expect(popup.locator('#job-list [data-status="failed"]')).toContainText(
    'API-Token ist ungültig',
  );
  await popup.reload();
  await expect(popup.locator('#job-list [data-status="failed"]')).toBeVisible();
  expect(uploads).toHaveLength(1);
});

test('uncertain outcomes survive reopening without a duplicate POST', async () => {
  await connect();
  status = 502;
  await chooseFile();
  await expect(
    popup.locator('#job-list [data-status="uncertain"]'),
  ).toContainText('Prüfe zuerst den Paperless-Posteingang');
  await popup.close();
  popup = await openPopup();
  await expect(
    popup.locator('#job-list [data-status="uncertain"]'),
  ).toBeVisible();
  expect(uploads).toHaveLength(1);
});

test('an offscreen upload completes after its popup closes', async () => {
  await connect();
  slow = true;
  await chooseFile('Slow.pdf');
  await expect.poll(() => uploads.length).toBe(1);
  await expect(
    popup.locator('#job-list [data-status="uploading"]'),
  ).toBeVisible();
  await popup.close();
  release?.();
  popup = await openPopup();
  await expect(
    popup.locator('#job-list [data-status="accepted"]'),
  ).toContainText('Slow.pdf');
  expect(uploads).toHaveLength(1);
});

test('a multi-file batch waits for each upload before starting the next', async () => {
  await connect();
  slow = true;
  const chooser = popup.waitForEvent('filechooser');
  await popup.getByRole('button', { name: /PDFs hier hineinziehen/ }).click();
  await (
    await chooser
  ).setFiles([
    { name: 'First.pdf', mimeType: 'application/pdf', buffer: pdf },
    { name: 'Second.pdf', mimeType: 'application/pdf', buffer: pdf },
  ]);
  await expect(
    popup.locator('#job-list [data-status="uploading"]'),
  ).toContainText('First.pdf');
  await expect(popup.locator('#job-list [data-status="queued"]')).toContainText(
    'Second.pdf',
  );
  expect(uploads.map((upload) => upload.name)).toEqual(['First.pdf']);
  release?.();
  await expect.poll(() => uploads.length).toBe(2);
  await expect(
    popup.locator('#job-list [data-status="accepted"]'),
  ).toContainText('First.pdf');
  await expect(
    popup.locator('#job-list [data-status="uploading"]'),
  ).toContainText('Second.pdf');
  release?.();
  await expect(popup.locator('#job-list [data-status="accepted"]')).toHaveCount(
    2,
  );
  expect(uploads.map((upload) => upload.name)).toEqual([
    'First.pdf',
    'Second.pdf',
  ]);
});

test('an interrupted POST becomes uncertain after recovery without being sent again', async () => {
  await connect();
  slow = true;
  await chooseFile('Interrupted.pdf');
  await expect.poll(() => uploads.length).toBe(1);
  await expect(
    popup.locator('#job-list [data-status="uploading"]'),
  ).toBeVisible();
  await popup.close();
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent('serviceworker'));
  await worker.evaluate(() => chrome.offscreen.closeDocument());
  release?.();
  popup = await openPopup();
  await expect(
    popup.locator('#job-list [data-status="uncertain"]'),
  ).toContainText('Prüfe zuerst den Paperless-Posteingang');
  expect(uploads).toHaveLength(1);
});

test('closing failures preserves completed uploads and cannot alter an active batch', async () => {
  await connect();
  slow = true;
  status = 401;
  await popup.locator('#file-input').setInputFiles([
    { name: 'Rejected.pdf', mimeType: 'application/pdf', buffer: pdf },
    { name: 'Accepted.pdf', mimeType: 'application/pdf', buffer: pdf },
  ]);
  await expect.poll(() => uploads.length).toBe(1);
  release?.();
  await expect.poll(() => uploads.length).toBe(2);
  await expect(popup.locator('#job-list [data-status="failed"]')).toContainText(
    'Rejected.pdf',
  );
  await expect(popup.locator('#dismiss-failures')).toBeDisabled();
  await popup.evaluate(() =>
    chrome.runtime.sendMessage({
      target: 'background',
      type: 'dismiss-failures',
    }),
  );
  await expect(popup.locator('#job-list li')).toHaveCount(2);
  status = 200;
  release?.();
  await expect(
    popup.locator('#job-list [data-status="accepted"]'),
  ).toContainText('Accepted.pdf');
  await popup.locator('#dismiss-failures').click();
  await expect(popup.locator('#job-list li')).toHaveCount(1);
  await expect(
    popup.locator('#job-list [data-status="accepted"]'),
  ).toBeVisible();
  await popup.reload();
  await expect(popup.locator('#job-list li')).toHaveCount(1);
  expect(uploads).toHaveLength(2);
});

test('imports are checked automatically and successful rows disappear without allowing a duplicate upload', async () => {
  await useCurrentPdf();
  await connect();
  taskStatus = 'STARTED';
  relatedDocument = null;
  await popup.locator('#send-current').click();
  await expect(popup.locator('[data-import-status="pending"]')).toContainText(
    'verarbeitet',
  );
  expect(taskRequests).toBe(1);
  taskStatus = 'SUCCESS';
  relatedDocument = '42';
  await expect(popup.locator('[data-import-status="success"]')).toContainText(
    'importiert',
  );
  await expect(popup.locator('.document-link')).toHaveAttribute(
    'href',
    `${baseUrl}documents/42/details`,
  );
  await screenshot('import-success');
  await popup.locator('.document-link').focus();
  await popup.waitForTimeout(8_500);
  await expect(popup.locator('.document-link')).toBeVisible();
  await popup.locator('#drop-zone').focus();
  await expect(popup.locator('#job-list li')).toHaveCount(0);
  await expect(popup.locator('#batch-summary')).toBeHidden();
  await popup.reload();
  await expect(popup.locator('#job-list li')).toHaveCount(0);
  await expect(popup.locator('#send-current')).toBeDisabled();
  await expect(popup.locator('#send-current')).toHaveText(
    'Bereits an Paperless übertragen',
  );
  expect(uploads).toHaveLength(1);
  expect(taskRequests).toBe(2);
});

for (const duplicate of [false, true]) {
  test(`automatic import ${duplicate ? 'duplicate' : 'failure'} results remain separate from upload acceptance`, async () => {
    await useCurrentPdf();
    await connect();
    taskStatus = 'FAILURE';
    relatedDocument = duplicate ? '42' : null;
    await popup.locator('#send-current').click();
    await expect(
      popup.locator(
        `[data-import-status="${duplicate ? 'duplicate' : 'failure'}"]`,
      ),
    ).toBeVisible();
    await expect(popup.locator('[data-status="accepted"]')).toBeVisible();
    await expect(popup.locator('#send-current')).toBeDisabled();
    await expect(popup.locator('.document-link')).toHaveCount(
      duplicate ? 1 : 0,
    );
    expect(uploads).toHaveLength(1);
    if (!duplicate) {
      await popup.locator('#dismiss-failures').click();
      await expect(popup.locator('#job-list li')).toHaveCount(0);
      await popup.reload();
      await expect(popup.locator('#send-current')).toBeDisabled();
      await expect(popup.locator('#job-list li')).toHaveCount(0);
    }
  });
}

test('unavailable task permissions stay visible and can be dismissed without another POST', async () => {
  await useCurrentPdf();
  await connect();
  taskHttpStatus = 403;
  await popup.locator('#send-current').click();
  await expect(
    popup.locator('[data-import-status="unavailable"]'),
  ).toContainText('Aufgaben-Berechtigung');
  await popup.mouse.move(0, 0);
  await popup.waitForTimeout(8_500);
  await expect(
    popup.locator('[data-import-status="unavailable"]'),
  ).toBeVisible();
  expect(taskRequests).toBe(1);
  await popup.locator('#dismiss-failures').click();
  await expect(popup.locator('#job-list li')).toHaveCount(0);
  await expect(popup.locator('#send-current')).toBeDisabled();
  expect(uploads).toHaveLength(1);
});

test('automatic import checks continue after closing the popup', async () => {
  await connect();
  taskStatus = 'PENDING';
  await chooseFile();
  await expect(popup.locator('[data-import-status="pending"]')).toBeVisible();
  await popup.close();
  taskStatus = 'SUCCESS';
  await expect.poll(() => taskRequests).toBe(2);
  popup = await openPopup();
  await expect(popup.locator('[data-import-status="success"]')).toBeVisible();
  expect(uploads).toHaveLength(1);
});

test('automatic import checks never query an old task on a new server', async () => {
  await connect();
  taskStatus = 'PENDING';
  await chooseFile();
  await expect(popup.locator('[data-import-status="pending"]')).toBeVisible();
  await popup.evaluate(async (url) => {
    await chrome.storage.local.set({
      settings: { url, token: 'new-fixture-token' },
    });
  }, new URL('/other-server/', baseUrl).href);
  await expect(popup.locator('.import-result')).toContainText(
    'anderen Paperless-Server',
  );
  await popup.waitForTimeout(5_500);
  expect(taskRequests).toBe(1);
  expect(uploads).toHaveLength(1);
});

test('an in-flight import check cannot resurrect a replaced batch', async () => {
  await connect();
  slowTask = true;
  await chooseFile('Old.pdf');
  await expect.poll(() => taskRequests).toBe(1);
  await chooseFile('New.pdf');
  await expect(popup.locator('#job-list')).toContainText('New.pdf');
  slowTask = false;
  releaseTask?.();
  await expect(popup.locator('[data-import-status="success"]')).toBeVisible();
  await popup.reload();
  await expect(popup.locator('#job-list li')).toHaveCount(1);
  await expect(popup.locator('#job-list')).toContainText('New.pdf');
  expect(uploads).toHaveLength(2);
});

test('web access is requested once, denial does not upload, and granted access is reused', async () => {
  await connect();
  const ordinary = await context.newPage();
  await ordinary.goto(baseUrl);
  await popup.reload();
  await popup.evaluate(() =>
    chrome.permissions.remove({ origins: ['http://*/*', 'https://*/*'] }),
  );
  await expect(popup.locator('#web-access-note')).toBeVisible();
  const requests: string[][] = [];
  await popup.exposeFunction('recordPermissionRequest', (origins: string[]) =>
    requests.push(origins),
  );
  await popup.evaluate(() => {
    const fixture = window as Window & {
      recordPermissionRequest: (origins: string[]) => Promise<void>;
    };
    const original = chrome.permissions.request.bind(chrome.permissions);
    window.addEventListener(
      'restore-permission-request',
      () => {
        chrome.permissions.request = original;
      },
      { once: true },
    );
    chrome.permissions.request = async (permissions) => {
      await fixture.recordPermissionRequest(permissions.origins ?? []);
      return false;
    };
  });
  await popup.locator('#send-window').click();
  await expect(popup.locator('#upload-status')).toContainText('nicht erlaubt');
  expect(requests).toEqual([['https://*/*', 'http://*/*']]);
  expect(uploads).toHaveLength(0);
  await popup.evaluate(() =>
    window.dispatchEvent(new Event('restore-permission-request')),
  );
  await popup.locator('#send-window').click();
  await expect(popup.locator('#web-access-note')).toBeHidden();
  await popup.evaluate(() => {
    chrome.permissions.request = async () => {
      throw new Error('Unexpected repeated permission request');
    };
  });
  await expect(popup.locator('#web-access-note')).toBeHidden();
  await popup.locator('#send-window').click();
  await expect(popup.locator('#upload-status')).toContainText('Keine PDF-Tabs');
  await popup.locator('#send-window').click();
  await expect(popup.locator('#send-window')).toBeEnabled();
  expect(requests).toHaveLength(1);
  expect(uploads).toHaveLength(0);
  await ordinary.close();
});

test('settings artwork is centered and the ready screen has no secondary workflow buttons', async () => {
  await connect();
  const centers = await popup.locator('#settings-toggle').evaluate((button) => {
    const svg = button.querySelector('svg')!;
    const gear = svg.querySelector('path')!;
    const circle = svg.querySelector('circle')!;
    const bounds = [button, svg, gear, circle].map((node) => {
      const box = node.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    });
    return bounds;
  });
  for (const center of centers.slice(1)) {
    expect(Math.abs(center.x - centers[0]!.x)).toBeLessThan(0.25);
    expect(Math.abs(center.y - centers[0]!.y)).toBeLessThan(0.25);
  }
  await expect(
    popup.locator(
      '#check-imports, #stop-import-checks, #send-selected, #window-selection',
    ),
  ).toHaveCount(0);
  await expect(popup.locator('#web-access-note')).toBeHidden();
});
