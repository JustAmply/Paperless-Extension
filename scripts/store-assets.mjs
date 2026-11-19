import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'artifacts', 'store');
const png = async (file) =>
  `data:image/png;base64,${(await readFile(path.join(root, file))).toString('base64')}`;
// The browser test fixture contains synthetic data and no configured API token.
const popup = await png('artifacts/screenshots/import-success.png');
const icon = await png('assets/icon-128.png');
await mkdir(output, { recursive: true });

const browser = await chromium.launch();
try {
  for (const { name, width, height, content } of [
    {
      name: 'screenshot-1280x800.png',
      width: 1280,
      height: 800,
      content: `
        <main class="screenshot">
          <section class="copy">
            <div class="brand"><img src="${icon}" alt="" width="44" height="44">Paperless Upload</div>
            <h1>Deine PDFs.<br>Direkt in<br>Paperless.</h1>
            <p>Geöffnete PDFs übertragen<br>oder lokale Dateien auswählen.</p>
            <div class="detail">Für deinen eigenen Paperless-ngx-Server.</div>
            <div class="footer">Keine Werbung. Kein Tracking.</div>
          </section>
          <section class="demo">
            <div class="popup"><img src="${popup}" width="390" height="336" alt="Paperless Upload bestätigt den erfolgreichen Import einer PDF."></div>
            <p>Hochladen. Import prüfen. Dokument öffnen.</p>
            <span>Originalansicht mit einer Beispieldatei</span>
          </section>
        </main>`,
    },
    {
      name: 'promo-440x280.png',
      width: 440,
      height: 280,
      content: `
        <main class="promo">
          <div class="brand"><img src="${icon}" alt="" width="34" height="34">Paperless Upload</div>
          <h1>PDFs direkt<br>an Paperless.</h1>
          <p>Dein Browser. Dein Server.</p>
        </main>`,
    },
  ]) {
    const page = await browser.newPage({
      viewport: { width, height },
      deviceScaleFactor: 1,
    });
    await page.setContent(`<!doctype html><html lang="de"><meta charset="utf-8"><title>Paperless Upload</title><style>
      * { box-sizing: border-box; }
      body { margin: 0; color: #153b25; font-family: "Segoe UI", Arial, sans-serif; }
      .screenshot { width: 1280px; height: 800px; display: grid; grid-template-columns: 700px 580px; background: #f0f6f0; }
      .copy { padding: 62px 0 44px 66px; }
      .brand { display: flex; align-items: center; gap: 12px; font-size: 26px; font-weight: 650; }
      .brand img { object-fit: contain; }
      h1 { margin: 50px 0 24px; font-size: 72px; line-height: 1.06; letter-spacing: -2px; font-weight: 700; }
      .copy > p { font-size: 26px; line-height: 1.5; margin: 0; color: #355642; }
      .detail { font-size: 19px; margin-top: 25px; }
      .footer { font-size: 17px; margin-top: 57px; color: #52705b; }
      .demo { background: #deebdf; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 32px; }
      .popup { background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 18px 50px #153b2526; }
      .popup img { display: block; }
      .demo p { font-size: 20px; margin: 34px 0 10px; }
      .demo span { font-size: 15px; color: #52705b; }
      .promo { width: 440px; height: 280px; padding: 26px 30px; background: #e5efe5; }
      .promo .brand { font-size: 21px; gap: 8px; }
      .promo h1 { font-size: 43px; line-height: 1.07; letter-spacing: -1px; margin: 24px 0 17px; }
      .promo p { font-size: 18px; margin: 0; color: #355642; }
    </style><body>${content}</body></html>`);
    await page.locator('img').evaluateAll(async (images) => {
      await Promise.all(images.map((image) => image.decode()));
    });
    await page.screenshot({ path: path.join(output, name) });
    await page.close();
    console.log(`Created artifacts/store/${name}`);
  }
} finally {
  await browser.close();
}
