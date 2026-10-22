# Paperless Upload

A small, unofficial Chrome extension that sends PDFs directly to your own Paperless-ngx server. Configure your server address and API token once in the popup. While a PDF is open, click the pinned extension icon and then **Aktuelle PDF hochladen** to send it. Opening the popup or saving settings never starts a new upload. The same popup accepts PDF files through drag and drop or the file picker, and can send all PDF tabs in the current window.

There are no document-management features, tracking services, accounts, or runtime dependencies.

## Install the local build

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select this project's **`dist`** folder.
3. Pin **Paperless Upload** to the toolbar.
4. Open the popup, enter your Paperless base address and API token, and choose **Verbinden**. Allow Chrome's access request for your server. The extension checks the API before saving.

Find the token in Paperless under **My Profile → API Token**. Use the base address, such as `https://paperless.example.com/`, or `https://example.com/paperless/` for a subpath installation. Do not enter an `/api/` endpoint. HTTPS is recommended; HTTP is available for local installations, with a visible warning.

On Chrome 151 or newer, the extension captures the response when a top-level PDF opens and displays it in Chrome's native PDF viewer using a local Blob URL. Clicking **Aktuelle PDF hochladen** uses those captured bytes, without requesting the original document again. This supports POST-generated PDFs and single-use download links. Capturing a PDF only stores it locally; it does not send it to Paperless.

File URLs additionally need the permission offered in the popup and Chrome's **Allow access to file URLs** switch in the extension details. Granting access enables the upload button; uploading still requires a separate click. Drag and drop and the file picker work without file-URL access.

Choose **PDF-Tabs hochladen** to send the PDFs open in the same browser window. Chrome asks for access to the sites in that window so the extension can read each tab's document type; ordinary HTML pages are inspected without downloading them again. Captured PDFs use their stored bytes; uncaptured PDFs use the retrieval fallback described below. Other windows are excluded. Captured documents with the same URL and SHA-256 content fingerprint are sent once, including tabs with different PDF page fragments. Different PDF contents returned by the same POST endpoint remain separate documents. Confirmed and unconfirmed uploads from the latest batch are preserved instead of repeated when using the window action again.

Uploads continue after the popup closes, while Chrome is running. Reopening the popup shows the latest batch; the current-tab button stays disabled for a matching confirmed or unconfirmed upload. A failed upload requires an explicit retry. New file selections and single-tab uploads replace the previous batch's status; the window action retains matching confirmed or unconfirmed results. Up to 10 local PDF files can be selected together; the window action includes every detected PDF tab. Each uploaded file may be up to 50 MiB. Files are sent sequentially.

The local capture cache holds up to 10 PDFs and 100 MiB in total. Older files are evicted when either limit is reached; navigation, tab closure, and browser startup also clear captured data. If a captured PDF is no longer available, the extension asks you to save it from the viewer and select or drop it into the popup, rather than replaying its original request. PDFs above the upload limit and cache failures still allow the PDF to be displayed. Files already staged for upload remain available independently of the capture cache.

**An Paperless übertragen** means the API accepted the PDF for processing. Paperless still performs its import, OCR, duplicate checks, and workflows. If confirmation is lost, check Paperless before manually sending again; the extension never automatically repeats an upload POST.

## Browser limitations

- Chrome 116 or newer is supported. Chrome 151 or newer is required to capture an already received PDF response through `chrome.mimeHandler`. Earlier Chrome versions and uncaptured sources use a fresh authenticated GET for HTTP(S) URLs or read an allowed file URL. That fallback cannot reconstruct POST bodies or consumed download links.
- Direct HTTP(S) PDFs work even without a `.pdf` URL suffix. Upload validation checks actual PDF bytes rather than trusting the filename or MIME type. The window action uses captured source metadata or inspects the top-level document type and URL; it does not inspect the protected viewer's own frames or fetch ordinary HTML pages.
- Capture applies when a PDF opens as a top-level document, not to embedded PDF frames or arbitrary `blob:` tabs. A PDF that was already open before capture became active cannot be captured retroactively. Save it from the current viewer and select or drop it into the popup; reopen it only if its source can safely be requested again.
- The native viewer receives the original PDF URL fragment, including page and zoom parameters. Chrome may filter `Content-Disposition` from the capture API, so the filename comes from the URL or falls back to `Dokument.pdf` when the original filename is unavailable.
- If a window contains local `file:` tabs, enable Chrome's **Allow access to file URLs** switch before using the window action. Without it, the scan stops with an instruction instead of silently omitting those tabs.
- Some login/referrer-dependent documents may remain unavailable to the GET fallback. Save the PDF and drop it into the popup instead.
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

`npm run build` type-checks and produces a fresh `dist/`. `npm test` runs Node unit tests against that build. `npm run test:e2e` loads the actual distribution in an isolated Chromium profile and exercises the popup, API requests, file transfer, response capture, window-scoped PDF detection, and popup-close lifecycle against a local fixture server. Browser evidence is written to `artifacts/screenshots/`. `npm run package` creates `artifacts/paperless-upload-0.3.0.zip` with `manifest.json` at its root. Windows uses .NET's ZIP implementation through PowerShell; Linux/macOS use `zip`.

GitHub Actions runs formatting, strict compilation, unit tests, browser tests, and packaging on pushes and pull requests. It uploads the unpacked extension, ZIP, and browser test evidence as workflow artifacts. Action revisions and npm dependencies are pinned; Dependabot proposes updates. No store publishing or server secrets are required.

See [the architecture](docs/ARCHITECTURE.md) for component responsibilities, lifecycle, and security decisions. This project is distributed under GPL-3.0-only; the official Paperless artwork is credited in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). It is not an official Paperless-ngx product.
