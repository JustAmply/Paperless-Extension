# Paperless Upload

A small, unofficial Chrome extension that sends PDFs directly to your own Paperless-ngx server. Configure your server address and API token once in the popup. Then click the pinned extension icon while a PDF is open: the upload starts automatically. The same popup accepts PDF files through drag and drop or the file picker.

There are no document-management features, tracking services, accounts, or runtime dependencies.

## Install the local build

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select this project's **`dist`** folder.
3. Pin **Paperless Upload** to the toolbar.
4. Open the popup, enter your Paperless base address and API token, and choose **Verbinden**. Allow Chrome's access request for your server. The extension checks the API before saving.

Find the token in Paperless under **My Profile → API Token**. Use the base address, such as `https://paperless.example.com/`, or `https://example.com/paperless/` for a subpath installation. Do not enter an `/api/` endpoint. HTTPS is recommended; HTTP is available for local installations, with a visible warning.

Once configured, clicking the toolbar icon checks the current HTTP(S) document and sends it if it contains a PDF. File URLs additionally need the permission offered in the popup and Chrome's **Allow access to file URLs** switch in the extension details. Drag and drop and the file picker work without file-URL access.

Uploads continue after the popup closes, while Chrome is running. Reopening the popup shows the latest batch and avoids resending the same tab URL. Each new batch replaces the previous batch's status. Up to 10 PDFs can be submitted together; each file may be up to 50 MiB. Files are sent sequentially.

**An Paperless übertragen** means the API accepted the PDF for processing. Paperless still performs its import, OCR, duplicate checks, and workflows. If confirmation is lost, check Paperless before manually sending again; the extension never automatically repeats an upload POST.

## Browser limitations

- Direct HTTP(S) PDFs work even without a `.pdf` URL suffix. Detection uses actual PDF bytes rather than trusting the filename or MIME type. A single authenticated GET is used to obtain the source document.
- Chrome's protected built-in PDF viewer cannot be scripted. The extension re-fetches the original tab URL using the temporary `activeTab` permission. Ordinary HTML pages are ignored after checking the first 1 KiB.
- `blob:` URLs, embedded PDF frames, POST-generated downloads, single-use download links, and some login/referrer-dependent documents may not be retrievable this way. Download the PDF and drop it into the popup instead.
- Server redirects are rejected so the API token stays bound to the configured destination. Enter the final server URL, including its correct subpath. An authentication gateway must permit Paperless token authentication for `/api/`.
- Browser shutdown interrupts in-flight work. On the next opening, interrupted uploads are marked unconfirmed rather than retried. Files still waiting in the queue can proceed. The extension does not poll Paperless's import tasks.

## Development

Node.js 24 or newer is required. Only four direct development dependencies are used: TypeScript, Chrome API types, Prettier, and Playwright. Native ES modules run unchanged in Chrome; TypeScript is the only compiler.

```sh
npm ci
npx playwright install chromium
npm run check
npm run package
```

`npm run build` type-checks and produces a fresh `dist/`. `npm test` runs Node unit tests against that build. `npm run test:e2e` loads the actual distribution in an isolated Chromium profile and exercises the popup, API requests, file transfer, and popup-close lifecycle against a local fixture server. Browser evidence is written to `artifacts/screenshots/`. `npm run package` creates `artifacts/paperless-upload-0.1.0.zip` with `manifest.json` at its root. Windows uses .NET's ZIP implementation through PowerShell; Linux/macOS use `zip`.

GitHub Actions runs formatting, strict compilation, unit tests, browser tests, and packaging on pushes and pull requests. It uploads the unpacked extension, ZIP, and browser test evidence as workflow artifacts. Action revisions and npm dependencies are pinned; Dependabot proposes updates. No store publishing or server secrets are required.

See [the architecture](docs/ARCHITECTURE.md) for component responsibilities, lifecycle, and security decisions. This project is distributed under GPL-3.0-only; the official Paperless artwork is credited in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). It is not an official Paperless-ngx product.
