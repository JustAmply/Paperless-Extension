# Privacy policy for Paperless Upload

Last updated: 2026-11-24

Publisher: JustAmply.

## Data handled by the extension

Paperless Upload sends PDF documents you select to the Paperless-ngx server you configure. It processes your server address, API token, display preferences, PDF contents and filenames, PDF source addresses, and transfer and import status. A PDF may contain personal or sensitive information; you control which documents you upload and which server receives them.

The extension reads tab information to identify PDFs in the current browser window. On supported Chrome versions, it temporarily captures newly opened PDFs locally, including PDFs embedded in portal pages, so that an explicit upload can use the already received document. Opening a PDF, opening the extension, or saving settings does not itself send a document to Paperless.

## Storage and transmission

Settings and your Paperless API token are stored locally in your Chrome profile. The token is not synced through Chrome Sync and is not placed in document queue records. Someone with access to your browser profile may be able to access locally stored data.

Captured PDFs and files staged for upload are stored temporarily in the browser's local IndexedDB database. For a separate native viewer tab, the extension can also create a temporary named copy in its private filesystem within your Chrome profile. Source addresses and transfer results are also retained locally to show progress and prevent accidental duplicate uploads.

When you request an upload, the selected PDF and its filename are sent to your configured Paperless server. The extension also contacts that server to verify the connection and check import status. Your Paperless API token is sent only to that server's API. API redirects are rejected.

When an uncaptured PDF needs to be retrieved from its source website, that request may use your existing browser login for that site. The Paperless API token is never included in source requests. HTTP connections are supported for local installations but do not provide transport encryption; use HTTPS where possible.

## Data use and recipients

The extension has no developer-operated document backend, advertising, analytics, or tracking service. It does not sell data, use it for unrelated purposes, or use it for creditworthiness decisions. Document processing and retention on your Paperless server are controlled by that server's operator. Source websites receive ordinary requests needed to retrieve PDFs when applicable.

## Retention and your controls

The local capture cache is limited to 25 PDFs and 512 MiB. Older captures are evicted when these limits are reached. A private viewer copy is retained while the source or another tab displaying it remains open. After the last view closes or navigates away, the extension removes the copy. When a viewer is replaced or Chrome restarts, the extension removes captures whose viewer is no longer open. Files staged for upload are separate from this cache; queued files can remain available across browser restarts. Staged file bytes are removed when a transfer reaches a terminal state or its eligible queue record is removed.

Transfer results and document identifiers may remain locally to prevent repeated uploads. Hiding a successful result does not necessarily delete that duplicate-prevention record. You can revoke website and file access through Chrome's extension settings. Uninstalling the extension removes its browser-managed local storage. Removing the extension does not delete documents already sent to Paperless.

## Changes and contact

This policy will be updated when the extension's data practices change, with the revision date shown above.

Contact: info@amply.de
