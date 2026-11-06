# Architecture

## Pattern and scope

Use a small layered architecture with an application controller in each Chrome execution context. Plain functions and ES modules provide the boundaries; there is no DI container, event bus, repository interface hierarchy, or UI framework. Modules depend inward on shared types and validation. Browser and network effects stay at the edges.

```text
popup.ts                 background.ts              offscreen.ts
DOM, settings form       Chrome API coordination    Sequential upload runner
PDF selection            Trusted token storage      Source retrieval + multipart
       │                       │                         │
       └───── control messages ┴──── control messages ──┘
       │                                                 │
       └──────────── data/jobs.ts (IndexedDB) ────────────┘
                         │
                    shared/ types
                    services/ API + PDF source fetch
```

The popup stages selected PDF blobs in IndexedDB and asks the background worker to process them. The worker creates one offscreen document using the `BLOBS` reason. Chrome messages carry control data and small status objects, never binary files. The offscreen runner reads blobs directly and uses `FormData` for upload. This avoids JSON serialization and base64 memory overhead.

The toolbar action opens the popup without staging a new job. Only **Aktuelle PDF hochladen**, file selection/drop, or the window action starts a new batch. Saving settings and granting local file access do not start uploads. Reopening the popup can resume jobs already queued by an earlier explicit action; accepted and uncertain results disable the matching current-tab action, while failed jobs require an explicit retry.

The Chrome service worker owns `chrome.storage`, optional permissions, badges, and offscreen creation/closure. The offscreen document owns requests because Chrome can terminate a worker whose fetch waits more than 30 seconds. It closes after the queue is drained. A popup poll refreshes visible status every 500 ms only while that popup exists. There is no permanent page script, polling job, or worker keepalive.

## PDF response capture and display

On Chrome 151 or newer, the manifest's `mime_types_handler` routes top-level PDF responses to `capture.html`. `capture.ts` obtains `chrome.mimeHandler.getStreamInfo()` and fetches its extension-owned stream URL once. `Response.blob()` lets the browser assemble the received body without accumulating JavaScript byte-array chunks. This consumes the already received response rather than replaying its original URL, credentials, or POST body, so POST-generated PDFs and single-use links can be uploaded later.

The handler uses `can_embed: false`. It creates a local Blob URL and embeds it in an iframe, where Chrome's native PDF viewer displays it. This avoids recursively invoking the handler for embedded PDFs. The original URL fragment is forwarded to preserve PDF page and zoom parameters. The handler does not use `abortAndFallbackToNativeHandler()`: the tested Chrome 156 path made another source request after fallback, including after the response had been read. A Blob URL keeps display independent of the original server.

PDF display does not depend on upload eligibility or successful cache storage. PDFs above 50 MiB can still be viewed, and cache errors are displayed alongside the viewer. Only valid PDFs within the upload limit receive a cached body and a SHA-256 content fingerprint. The capture API may filter `Content-Disposition`, even with host access, so names use an available response filename, the URL basename, or `Dokument.pdf`.

Chrome 116 remains the minimum supported version. On older versions, or for a source without a capture record, the existing HTTP(S) GET/file retrieval path remains available. Capture cannot recover a response retroactively from a previously opened native viewer. Such a PDF must be saved from its current viewer and selected locally, or safely reopened when its source allows another request. Arbitrary `blob:` tabs and embedded PDF frames are not captured.

## Data and lifecycle

- `chrome.storage.local`: normalized base URL and API token, limited to trusted extension contexts. Settings are not synced to a Google account.
- IndexedDB database `paperless-upload`, version 2: the upgrade retains existing `jobs` and `files` stores and adds `sources`.
- IndexedDB `sources`: captured PDF metadata keyed by tab ID, with the original URL, name, capture time, fingerprint, and an optional Blob or error. Valid content uses a SHA-256 fingerprint; loading/error records have a temporary identity. The cache holds at most ten bodies and 100 MiB in total. Oldest bodies are evicted first while metadata is retained as an unavailable marker. Navigation, tab closure, and browser startup clear captured records.
- IndexedDB `jobs`: metadata and status for the latest batch. Local file selection is bounded to ten records; a window batch is bounded by the PDF tabs in that window. Source jobs include the original URL, tab ID, and capture fingerprint when available. Captured document identity combines URL and fingerprint: identical content at the same URL is preserved across tabs, while a different response at the same POST endpoint can be uploaded separately. Uncaptured sources retain URL-based identity. PDF page fragments are excluded from identity.
- IndexedDB `files`: temporary blobs, deleted after each terminal result. Metadata queries do not load the file bodies. Starting another batch clears previous terminal records and leftover blobs in one transaction.
- Job transitions: `queued → downloading → uploading → accepted | failed | uncertain`; local files and staged captured PDFs skip `downloading`, ordinary web pages end as `skipped`.
- A newly created offscreen document marks previously interrupted downloads as failed and previously interrupted uploads as uncertain. It does not repeat either request. Still-queued jobs have never started an upload and can proceed.

The queue is deliberately one batch at a time. IndexedDB checks and stages each batch within one read/write transaction, preventing overlapping popups from adding conflicting batches. Staging copies matching captured blobs from `sources` into `files` in that transaction, so subsequent cache eviction, tab closure, or navigation does not invalidate queued uploads. A matching loading, error, or unavailable capture record fails with an explanation rather than falling back to another GET. When staging a window batch, confirmed and unconfirmed results for matching document identities are retained; only new or explicitly retried failed documents are queued. Offscreen lifecycle mutations are serialized. There is no retry queue or upload history feature.

The window action snapshots the current window's retrievable tab URLs before its click handler requests the corresponding optional host permissions. `src/browser/pdf-tabs.ts` queries that same window again and checks permission coverage. Captured source records identify matching PDF tabs directly; other tabs are inspected for the top-level document's MIME type and URL with `scripting.executeScript`. This supports extensionless PDF URLs without fetching unrelated HTML pages. Navigation changes are excluded by matching the inspected or captured URL against the tab snapshot, and matching document identities are deduplicated before staging. The service worker owns detection and staging so the scan can finish after the popup closes.

The popup can explicitly dismiss failed/skipped jobs and transient notices. Dismissal checks for active jobs and removes eligible records and blobs in one IndexedDB transaction; it leaves accepted/uncertain outcomes intact and refreshes the toolbar badge. Non-PDF responses remain visible as skipped and allow an explicit retry. Terminal upload results are persisted outside the processing-error handler so a failed status notification cannot turn an accepted or uncertain POST into a retryable failure.

## Security and permissions

Required permissions are `activeTab`, `tabs`, `scripting`, `storage`, and `offscreen`. `tabs` provides the URLs needed to request scoped permissions before the window action starts; `scripting` reads only the top-level document type and URL during that explicit action. The MIME handler receives top-level PDFs as they open, independently of those optional host grants, and only stores their data locally until an explicit upload action. There are no persistent content scripts or browsing-wide host grants. The configured Paperless origin is requested as an optional host permission directly from the save gesture; the window action requests only the current window's retrievable origins. Chrome retains accepted host grants until revoked in its extension settings. Replacing a server removes its previous server origin permission after a successful connection check. Local `file:` access is optional and separate.

Uploaded PDFs are validated by byte signature in the first 1 KiB and bounded to 50 MiB. The GET fallback enforces that limit while reading; response capture assembles a Blob for display before applying the upload/cache limit. MIME types and filenames alone do not establish PDF content. All selected files are validated before a batch is staged. The browser's file selection already provides local file access, so it does not need broad filesystem access.

Only the Paperless service sends the `Authorization: Token` header. Source requests carry the source site's normal browser credentials, never the Paperless token; captured bytes require no new source request. API requests omit browser cookies and reject redirects. Source URLs may contain sensitive query parameters and remain local in capture metadata and the latest batch; they are not logged or sent to a third party. The token is not stored in either IndexedDB job or capture records. All UI content is inserted with `textContent`, not interpreted as HTML. The manifest enforces local-only scripts and styles, permits Blob frames for the native PDF viewer, and prohibits objects. No remote code or runtime dependencies are used.

Connection verification uses `GET api/profile/`, an authenticated endpoint that does not require access to documents. The public `api/` root redirects to Swagger in current Paperless versions and cannot establish connectivity or token validity. Only a matching profile token confirms the connection; the profile response is discarded without being stored, logged, or sent to the popup. Manual redirect handling reports a redirected API separately from network errors without following it or forwarding credentials.

HTTP is allowed for self-hosted local servers with an explicit UI warning. The extension cannot fix invalid TLS certificates or bypass server authentication gateways. It does not encrypt the locally stored token; Chrome profile access grants access to extension storage. This is described plainly rather than hidden behind ineffective client-side encryption.

## Verification boundaries

Unit tests cover validation and network contracts. Chromium tests cover actual extension execution, IndexedDB cleanup, messaging, multipart transfer, sequential batches, continued uploads after closing the UI, and interrupted-upload recovery. Popup tests verify that opening and saving settings do not request or upload a source before the explicit current-tab action. Toolbar cases open GET, POST-generated, and single-use PDFs in Chrome's viewer, trigger the actual extension action, and check source request counts and uploaded bytes outside the permanently granted server host. The window test uses extensionless PDF tabs, an ordinary HTML page, duplicate URLs, and a second browser window. It also verifies that repeated window actions preserve accepted and unconfirmed uploads without another POST. Test-only Chrome management APIs pregrant the local fixture server permission; accepting Chrome's native permission dialog remains a manual check. A local fixture API provides deterministic responses without real credentials or production data. These checks do not establish compatibility with every PDF provider or prove import completion on a particular Paperless installation.

Primary references: [Paperless upload API](https://github.com/paperless-ngx/paperless-ngx/blob/dev/docs/api.md#posting-documents-file-uploads), [Chrome MIME handler](https://developer.chrome.com/docs/extensions/reference/api/mimeHandler), [Chrome activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab), [offscreen documents](https://developer.chrome.com/docs/extensions/reference/api/offscreen), [service worker lifetime](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle), [Chrome messaging serialization](https://developer.chrome.com/docs/extensions/develop/concepts/messaging#serialization).
