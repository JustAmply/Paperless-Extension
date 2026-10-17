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

The Chrome service worker owns `chrome.storage`, optional permissions, badges, and offscreen creation/closure. The offscreen document owns requests because Chrome can terminate a worker whose fetch waits more than 30 seconds. It closes after the queue is drained. A popup poll refreshes visible status every 500 ms only while that popup exists. There is no permanent page script, polling job, or worker keepalive.

## Data and lifecycle

- `chrome.storage.local`: normalized base URL and API token, limited to trusted extension contexts. Settings are not synced to a Google account.
- IndexedDB `jobs`: metadata and status for the latest batch. Local file selection is bounded to ten records; a window batch is bounded by the PDF tabs in that window. Source jobs include the original URL and tab ID. Reopening the popup avoids repeating a URL, including duplicates in different tabs.
- IndexedDB `files`: temporary blobs, deleted after each terminal result. Metadata queries do not load the file bodies. Starting another batch clears previous terminal records and leftover blobs in one transaction.
- Job transitions: `queued → downloading → uploading → accepted | failed | uncertain`; local files skip `downloading`, ordinary web pages end as `skipped`.
- A newly created offscreen document marks previously interrupted downloads as failed and previously interrupted uploads as uncertain. It does not repeat either request. Still-queued jobs have never started an upload and can proceed.

The queue is deliberately one batch at a time. IndexedDB checks and stages each batch within one read/write transaction, preventing overlapping popups from adding conflicting batches. When staging a window batch, confirmed and unconfirmed results for matching URLs are retained; only new or explicitly retried failed URLs are queued. Offscreen lifecycle mutations are serialized. There is no retry queue or upload history feature.

The window action snapshots the current window's retrievable tab URLs before its click handler requests the corresponding optional host permissions. `src/browser/pdf-tabs.ts` queries that same window again and checks permission coverage before inspecting the top-level document's MIME type and URL with `scripting.executeScript`. This supports extensionless PDF URLs without fetching unrelated HTML pages. Navigation changes are excluded by matching the inspected URL against the tab snapshot, and identical URLs are deduplicated before staging. The service worker owns detection and staging so the scan can finish after the popup closes.

## Security and permissions

Required permissions are `activeTab`, `tabs`, `scripting`, `storage`, and `offscreen`. `tabs` provides the URLs needed to request scoped permissions before the window action starts; `scripting` reads only the top-level document type and URL during that explicit action. There are no persistent content scripts or browsing-wide host grants. The configured Paperless origin is requested as an optional host permission directly from the save gesture; the window action requests only the current window's retrievable origins. Chrome retains accepted host grants until revoked in its extension settings. Replacing a server removes its previous server origin permission after a successful connection check. Local `file:` access is optional and separate.

PDFs are validated by byte signature in the first 1 KiB and bounded to 50 MiB while reading. MIME types and filenames alone do not establish PDF content. All selected files are validated before a batch is staged. The browser's file selection already provides local file access, so it does not need broad filesystem access.

Only the Paperless service sends the `Authorization: Token` header. Source requests carry the source site's normal browser credentials, never the Paperless token. API requests omit browser cookies and reject redirects. Source URLs may contain sensitive query parameters and remain local as part of the latest batch; they are not logged or sent to a third party. All UI content is inserted with `textContent`, not interpreted as HTML. The manifest enforces local-only scripts and styles and prohibits objects.

Connection verification uses `GET api/profile/`, an authenticated endpoint that does not require access to documents. The public `api/` root redirects to Swagger in current Paperless versions and cannot establish connectivity or token validity. Only a matching profile token confirms the connection; the profile response is discarded without being stored, logged, or sent to the popup. Manual redirect handling reports a redirected API separately from network errors without following it or forwarding credentials.

HTTP is allowed for self-hosted local servers with an explicit UI warning. The extension cannot fix invalid TLS certificates or bypass server authentication gateways. It does not encrypt the locally stored token; Chrome profile access grants access to extension storage. This is described plainly rather than hidden behind ineffective client-side encryption.

## Verification boundaries

Unit tests cover validation and network contracts. Chromium tests cover actual extension execution, IndexedDB cleanup, messaging, multipart transfer, sequential batches, continued uploads after closing the UI, and interrupted-upload recovery. A separate toolbar test opens a real PDF in Chrome's viewer, triggers the actual extension action, and verifies a source outside the permanently granted server host. The window test uses extensionless PDF tabs, an ordinary HTML page, duplicate URLs, and a second browser window. It also verifies that repeated window actions preserve accepted and unconfirmed uploads without another POST. Test-only Chrome management APIs pregrant the local fixture server permission; accepting Chrome's native permission dialog remains a manual check. A local fixture API provides deterministic responses without real credentials or production data. These checks do not establish compatibility with every PDF provider or prove import completion on a particular Paperless installation.

Primary references: [Paperless upload API](https://github.com/paperless-ngx/paperless-ngx/blob/dev/docs/api.md#posting-documents-file-uploads), [Chrome activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab), [offscreen documents](https://developer.chrome.com/docs/extensions/reference/api/offscreen), [service worker lifetime](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle), [Chrome messaging serialization](https://developer.chrome.com/docs/extensions/develop/concepts/messaging#serialization).
