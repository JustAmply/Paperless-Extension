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
- IndexedDB `jobs`: metadata and status for the latest batch, at most ten records. A source job also includes its tab ID and original URL to prevent accidental repeat uploads from reopening the same popup.
- IndexedDB `files`: temporary blobs, deleted after each terminal result. Metadata queries do not load the file bodies. Starting another batch clears previous terminal records and leftover blobs in one transaction.
- Job transitions: `queued → downloading → uploading → accepted | failed | uncertain`; local files skip `downloading`, ordinary web pages end as `skipped`.
- A newly created offscreen document marks previously interrupted downloads as failed and previously interrupted uploads as uncertain. It does not repeat either request. Still-queued jobs have never started an upload and can proceed.

The queue is deliberately one batch at a time. IndexedDB checks and stages each batch within one read/write transaction, preventing overlapping popups from adding conflicting batches. Offscreen lifecycle mutations are serialized. There is no retry queue or upload history feature.

## Security and permissions

Required permissions are `activeTab`, `storage`, and `offscreen`. The current page is accessible only after the user invokes the action. There are no content scripts or browsing-wide host grants. The configured Paperless origin is requested as an optional host permission directly from the save gesture. Replacing a server removes its previous origin permission after a successful connection check. Local `file:` access is optional and separate.

PDFs are validated by byte signature in the first 1 KiB and bounded to 50 MiB while reading. MIME types and filenames alone do not establish PDF content. All selected files are validated before a batch is staged. The browser's file selection already provides local file access, so it does not need broad filesystem access.

Only the Paperless service sends the `Authorization: Token` header. Source requests carry the source site's normal browser credentials, never the Paperless token. API requests omit browser cookies and reject redirects. Source URLs may contain sensitive query parameters and remain local as part of the latest batch; they are not logged or sent to a third party. All UI content is inserted with `textContent`, not interpreted as HTML. The manifest enforces local-only scripts and styles and prohibits objects.

HTTP is allowed for self-hosted local servers with an explicit UI warning. The extension cannot fix invalid TLS certificates or bypass server authentication gateways. It does not encrypt the locally stored token; Chrome profile access grants access to extension storage. This is described plainly rather than hidden behind ineffective client-side encryption.

## Verification boundaries

Unit tests cover validation and network contracts. Chromium tests cover actual extension execution, IndexedDB cleanup, messaging, multipart transfer, sequential batches, continued uploads after closing the UI, and interrupted-upload recovery. A separate toolbar test opens a real PDF in Chrome's viewer, triggers the actual extension action, and verifies a source outside the permanently granted server host. Test-only Chrome management APIs pregrant the local fixture server permission; accepting Chrome's native permission dialog remains a manual check. A local fixture API provides deterministic responses without real credentials or production data. These checks do not establish compatibility with every PDF provider or prove import completion on a particular Paperless installation.

Primary references: [Paperless upload API](https://github.com/paperless-ngx/paperless-ngx/blob/dev/docs/api.md#posting-documents-file-uploads), [Chrome activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab), [offscreen documents](https://developer.chrome.com/docs/extensions/reference/api/offscreen), [service worker lifetime](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle), [Chrome messaging serialization](https://developer.chrome.com/docs/extensions/develop/concepts/messaging#serialization).
