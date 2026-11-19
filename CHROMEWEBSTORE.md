# Chrome Web Store Listing — Paperless Upload

Last updated: 2026-11-16

## Store listing

- Name: Paperless Upload
- Short description: Geöffnete PDFs oder lokale PDF-Dateien direkt an deinen Paperless-ngx-Server übertragen.
- Primary language: German
- Category: Productivity → Tools
- Single purpose: Send user-selected PDF documents to the user's own Paperless-ngx server.

### Detailed description

Paperless Upload überträgt PDFs direkt an deinen eigenen Paperless-ngx-Server.

Lade die aktuell geöffnete PDF hoch, wähle lokale PDF-Dateien aus oder ziehe sie in das Erweiterungsfenster. Mit „Alle PDF-Tabs hochladen“ kannst du die erkannten PDFs des aktuellen Browserfensters gemeinsam übertragen.

Trage einmal deine Serveradresse und deinen Paperless-API-Token ein. Eine Übertragung startet erst, wenn du sie ausdrücklich auslöst. Du kannst das Erweiterungsfenster danach schließen; die Übertragung läuft weiter, solange Chrome geöffnet bleibt.

Die Erweiterung unterscheidet zwischen der Annahme einer Datei und dem anschließenden Import durch Paperless. Sie zeigt nach Möglichkeit den Importstatus und einen Link zum Dokument an. Wenn eine Übertragung nicht sicher bestätigt werden kann, wird sie nicht automatisch wiederholt.

Deine Einstellungen und vorübergehend benötigten Dokumente werden lokal im Browser gespeichert. PDFs werden nur an den von dir eingerichteten Paperless-Server übertragen. Es gibt keine Werbung, Analyse- oder Trackingdienste.

Voraussetzungen: ein eigener Paperless-ngx-Zugang und Chrome ab Version 116. Ab Chrome 151 können neu geöffnete PDFs direkt aus der bereits empfangenen Antwort übernommen werden. Bei nicht zugänglichen Dokumenten kannst du die Datei speichern und anschließend auswählen. Für lokale PDF-Tabs ist eine zusätzliche Dateizugriffsfreigabe erforderlich.

Paperless Upload ist ein unabhängiges Projekt und kein offizielles Produkt von Paperless-ngx.

## Graphics and assets

| Asset                             | Location                                  | Status                                              |
| --------------------------------- | ----------------------------------------- | --------------------------------------------------- |
| Store icon, 128 × 128             | `assets/icon-128.png`                     | Existing extension icon                             |
| Product screenshots               | `artifacts/store/screenshot-1280x800.png` | Generated from synthetic test evidence and uploaded |
| Small promotional tile, 440 × 280 | `artifacts/store/promo-440x280.png`       | Generated and uploaded                              |

Use synthetic documents and a fixture server for screenshots. Never show real API tokens, private server addresses, or personal documents.

## Permission justifications

| Permission                              | Justification                                                                                                                                                                                                                                  |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `activeTab`                             | Identifies the PDF in the active tab after the user opens the extension.                                                                                                                                                                       |
| `tabs`                                  | Reads tab URLs and titles to identify PDFs in the current window for the explicit window-upload action.                                                                                                                                        |
| `scripting`                             | Checks the top-level document type and URL to distinguish PDFs from ordinary web pages; it does not extract unrelated page content.                                                                                                            |
| `storage`                               | Saves the user-configured Paperless server, API token, and display preferences locally.                                                                                                                                                        |
| `offscreen`                             | Keeps the document-transfer queue and bounded import-status checks running when the popup is closed.                                                                                                                                           |
| `webRequest`                            | Observes PDF response metadata to preserve original filenames.                                                                                                                                                                                 |
| Optional `https://*/*` and `http://*/*` | Users choose their own self-hosted Paperless server and PDF source sites, so destinations cannot be fixed in advance. Granted access allows explicit PDF retrieval and transfers to that configured server. HTTP supports local installations. |
| Optional `file:///*`                    | Reads local PDF tabs only after the user grants file access. File selection and drag and drop do not require this permission.                                                                                                                  |

All executable code is packaged with the extension. No remotely hosted code is used.

## Privacy and data use

The extension handles authentication information, website content, and PDF source URLs. Do not describe it as processing no user data merely because there is no developer-operated backend.

- The Paperless API token is stored in local extension settings and sent only to the configured Paperless API.
- Selected PDF bytes and filenames are sent to that server when the user requests an upload. Documents can contain personal or sensitive information chosen by the user.
- PDF source URLs and tab metadata are processed locally for detection, filenames, and duplicate prevention. Source requests use the source site's existing browser session when needed.
- Captured PDFs and queued files are stored temporarily in local IndexedDB. They are not synced to a developer service.
- There is no advertising, analytics, sale of data, unrelated use, or creditworthiness assessment.

Policy source: [docs/PRIVACY_POLICY.md](docs/PRIVACY_POLICY.md). Public policy URL configured in the store: https://github.com/JustAmply/Paperless-Extension/blob/main/docs/PRIVACY_POLICY.md

## Distribution and developer information

- Intended visibility: Public.
- Publisher: JustAmply; verified public contact: info@amply.de.
- Publisher ID: `e4931f52-f369-4c07-b9af-5037f4827df8`; extension ID: `adpolpaolmleglppngfeoleclnoekmga`.
- Existing linked service account: `chrome-extension-publisher@chrome-extensions-470306.iam.gserviceaccount.com`.
- Homepage and corresponding source: https://github.com/JustAmply/Paperless-Extension
- Support: https://github.com/JustAmply/Paperless-Extension/issues
- Reuse an existing linked publisher service account when present. Google currently permits only one service account per publisher.

## Version history

| Version | Date       | Changes                                                                           | Status                    |
| ------- | ---------- | --------------------------------------------------------------------------------- | ------------------------- |
| 0.3.0   | 2026-11-16 | Initial store publication preparation for PDF uploads and import-status feedback. | Submitted; review pending |

## Submission requirements still to verify

- Publisher access and existing linked service account verified on 2026-11-16.
- First item created and version 0.3.0 ZIP uploaded in the Developer Dashboard.
- Public privacy policy, developer contact, store graphics, and final data-use disclosures.
- GitHub environment configuration described in [docs/RELEASING.md](docs/RELEASING.md).
- Store review and approval; a successful API submission does not mean the extension is publicly available.

## Current setup status

The store draft exists and includes German listing copy, the extension icon, a product screenshot, a promotional tile, permission justifications, and data-use disclosures (authentication information, web history/source URLs, and website content). The GitHub environment and its four variables are configured and restricted to main. The Google workload identity pool/provider exists with a repository-, branch-, workflow-, and subject-specific condition. The service-account IAM grant is configured. The repository and privacy policy are public, and the homepage/support/policy URLs are saved in the store. Release workflow run 43925511614 completed successfully, including verification, packaging, keyless authentication, upload, and submission. Version 0.3.0 is PENDING_REVIEW with automatic publication after approval.
