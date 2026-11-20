import assert from 'node:assert/strict';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
const output = path.join(root, 'store', 'graphics');
const copy = JSON.parse(
  await readFile(path.join(root, 'store/screenshot-copy.json'), 'utf8'),
);
const locales = (await readdir(path.join(dist, '_locales'))).sort();
assert.deepEqual(
  Object.keys(copy).sort(),
  locales,
  'Missing localized screenshot copy',
);
const listings = await readdir(path.join(root, 'store/listing'));
assert.deepEqual(
  listings.sort(),
  locales.map((locale) => locale + '.txt'),
  'Missing store listing',
);

const taskId = '12345678-1234-4567-89ab-123456789abc';
const fixtureToken = 'local-screenshot-fixture';
const icon = await readFile(path.join(dist, 'assets/icon-128.png'));
const imageUrl = (bytes) => 'data:image/png;base64,' + bytes.toString('base64');
await mkdir(output, { recursive: true });

const artwork = await chromium.launch({ channel: 'chromium' });
try {
  const page = await artwork.newPage({
    viewport: { width: 440, height: 280 },
    deviceScaleFactor: 1,
  });
  // Chrome Web Store has one small promotional tile shared by all locales.
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    body { margin: 0; display: grid; place-content: center; justify-items: center; gap: 19px;
      height: 100vh; background: #e7f1e5; color: #143d28; font-family: "Segoe UI", Arial, sans-serif; }
    img { width: 98px; height: 98px; object-fit: contain; }
    b { font-size: 35px; font-weight: 650; letter-spacing: -1.5px; }
  </style><img src="${imageUrl(icon)}" alt=""><b>Paperless Upload</b>`);
  await page.locator('img').evaluate((img) => img.decode());
  await page.screenshot({ path: path.join(output, 'promo-440x280.png') });

  // Use a real one-page PDF, displayed by the browser and accepted by the local fixture.
  await page.setContent('<!doctype html><title>Sample</title><p>PDF 042</p>');
  const pdf = await page.pdf();
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/profile/') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ auth_token: fixtureToken }));
    }
    if (req.method === 'GET' && req.url?.endsWith('.pdf')) {
      res.writeHead(200, {
        'content-type': 'application/pdf',
        'content-length': pdf.length,
      });
      return res.end(pdf);
    }
    if (req.method === 'POST' && req.url === '/api/documents/post_document/') {
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(taskId));
    }
    if (req.method === 'GET' && req.url === '/api/tasks/?task_id=' + taskId) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(
        JSON.stringify([
          { task_id: taskId, status: 'SUCCESS', related_document: '42' },
        ]),
      );
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const serverUrl = `http://127.0.0.1:${server.address().port}/`;
  try {
    for (const locale of locales) {
      const language = locale.replaceAll('_', '-');
      const { title, detail, caption, filename } = copy[locale];
      const popup = await capturePopup(language, serverUrl, filename);
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.setContent(`<!doctype html><html lang="${language}"><meta charset="utf-8">
        <style>
          * { box-sizing: border-box; }
          body { margin: 0; color: #193c29; font-family: "Segoe UI", "Yu Gothic UI", Arial, sans-serif; }
          main { display: grid; grid-template-columns: 590px 690px; height: 800px; }
          section { padding: 64px; display: flex; flex-direction: column; justify-content: center; }
          .copy { background: #edf4ea; position: relative; }
          .brand { position: absolute; top: 62px; display: flex; align-items: center; gap: 14px;
            font-size: 26px; font-weight: 650; letter-spacing: -.8px; }
          .brand img { width: 42px; height: 42px; }
          h1 { margin: 32px 0; font-size: 65px; font-weight: 670; line-height: 1.09;
            letter-spacing: -2.5px; text-wrap: balance; }
          p { margin: 0; font-size: 25px; line-height: 1.42; text-wrap: pretty; }
          .demo { align-items: center; background: #d7e6d6; }
          .popup { display: block; width: 468px; height: auto; border-radius: 12px;
            box-shadow: 0 15px 44px #173e2826; }
          .caption { margin-top: 28px; max-width: 468px; color: #365441; font-size: 20px;
            line-height: 1.45; text-align: center; text-wrap: balance; }
          :lang(ja) h1 { letter-spacing: -2px; line-height: 1.2; }
        </style><main>
          <section class="copy"><div class="brand"><img src="${imageUrl(icon)}" alt="">Paperless Upload</div>
            <h1></h1><p></p></section>
          <section class="demo"><img class="popup" src="${imageUrl(popup)}" alt=""><p class="caption"></p></section>
        </main></html>`);
      await page
        .locator('h1')
        .evaluate((el, text) => (el.textContent = text), title);
      await page
        .locator('.copy p')
        .evaluate((el, text) => (el.textContent = text), detail);
      await page
        .locator('.caption')
        .evaluate((el, text) => (el.textContent = text), caption);
      await page
        .locator('img')
        .evaluateAll((images) =>
          Promise.all(images.map((img) => img.decode())),
        );
      assert.ok(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth === innerWidth &&
            document.documentElement.scrollHeight === innerHeight,
        ),
        'Artwork exceeds the viewport for ' + locale,
      );
      const folder = path.join(output, locale);
      await mkdir(folder, { recursive: true });
      await page.screenshot({
        path: path.join(folder, 'screenshot-1280x800.png'),
      });
      console.log('Created store screenshot for ' + locale);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
} finally {
  await artwork.close();
}

async function capturePopup(language, serverUrl, filename) {
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    locale: language,
    colorScheme: 'light',
    deviceScaleFactor: 2,
    viewport: { width: 390, height: 640 },
    env: { ...process.env, LANG: language, LANGUAGE: language },
    args: [
      `--lang=${language}`,
      `--disable-extensions-except=${dist}`,
      `--load-extension=${dist}`,
    ],
  });
  try {
    context.setDefaultTimeout(15_000);
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent('serviceworker'));
    const id = new URL(worker.url()).host;
    const active = context.pages()[0];
    await active.goto('chrome://extensions/');
    await active.evaluate(
      (id) =>
        new Promise((resolve, reject) => {
          chrome.developerPrivate.addHostPermission(id, '*://*/*', () => {
            if (chrome.runtime.lastError)
              reject(new Error(chrome.runtime.lastError.message));
            else resolve();
          });
        }),
      id,
    );
    const setup = await context.newPage();
    await setup.goto('chrome-extension://' + id + '/popup.html');
    await setup.evaluate(() =>
      chrome.permissions.remove({ origins: ['https://*/*', 'http://*/*'] }),
    );
    await setup.reload();
    await setup.locator('#server-url').fill(serverUrl);
    await setup.locator('#api-token').fill(fixtureToken);
    await setup.locator('#save-settings').click();
    await setup.locator('#upload-panel').waitFor();
    await setup.close();
    await active.goto(new URL(encodeURIComponent(filename), serverUrl).href);
    await active.bringToFront();
    const next = context.waitForEvent('page');
    await worker.evaluate(() =>
      chrome.tabs.create({
        url: chrome.runtime.getURL('popup.html'),
        active: false,
      }),
    );
    const popup = await next;
    await popup.waitForURL('chrome-extension://' + id + '/popup.html');
    assert.equal(
      await popup.evaluate(() => chrome.i18n.getUILanguage()),
      language,
    );
    await popup.locator('#send-current').click();
    try {
      await popup.locator('[data-import-status="success"]').waitFor();
    } catch (cause) {
      throw new Error(await popup.locator('body').innerText(), { cause });
    }
    assert.equal(await popup.locator('.job-name').innerText(), filename);
    const catalog = JSON.parse(
      await readFile(
        path.join(
          dist,
          '_locales',
          language.replaceAll('-', '_'),
          'messages.json',
        ),
        'utf8',
      ),
    );
    assert.equal(
      await popup.locator('#drop-zone').innerText(),
      catalog.uiChooseFiles.message,
    );
    assert.equal(
      await popup.evaluate(() => document.documentElement.lang),
      language,
    );
    await popup.mouse.move(0, 0);
    return await popup.locator('body').screenshot({ animations: 'disabled' });
  } finally {
    await context.close();
  }
}
