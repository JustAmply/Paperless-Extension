# Chrome Web Store Listing — Paperless Upload

Last updated: 2026-11-20

## Store listing

- Name: Paperless Upload
- Category: Productivity → Tools
- Default language: English
- Single purpose: Send user-selected PDF documents to the user's own Paperless-ngx server.

The manifest supplies each short description from `extensionDescription` in the corresponding [Chrome message catalog](_locales/). The following plain-text files contain the detailed descriptions exactly as they should appear in the Developer Dashboard.

| Store language      | Detailed description                           |
| ------------------- | ---------------------------------------------- |
| German              | [Deutsch](store/listing/de.txt)                |
| English             | [English](store/listing/en.txt)                |
| French              | [Français](store/listing/fr.txt)               |
| Spanish             | [Español](store/listing/es.txt)                |
| Italian             | [Italiano](store/listing/it.txt)               |
| Dutch               | [Nederlands](store/listing/nl.txt)             |
| Polish              | [Polski](store/listing/pl.txt)                 |
| Portuguese (Brazil) | [Português do Brasil](store/listing/pt_BR.txt) |
| Swedish             | [Svenska](store/listing/sv.txt)                |
| Japanese            | [日本語](store/listing/ja.txt)                 |

## Graphics and assets

| Asset                                    | Location                                          |
| ---------------------------------------- | ------------------------------------------------- |
| Store icon, 128 × 128                    | `assets/icon-128.png`                             |
| Localized screenshots, 1280 × 800        | `store/graphics/<locale>/screenshot-1280x800.png` |
| Global small promotional tile, 440 × 280 | `store/graphics/promo-440x280.png`                |

Each screenshot shows the actual popup running in its target language after a successful import on a local fixture server. The tile uses the extension name and icon across all languages. See the [release instructions](docs/RELEASING.md#localized-store-materials) to regenerate and apply the assets.

## Permission justifications

| Permission                              | Justification                                                                                                                                                                                                                                  |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `activeTab`                             | Identifies the PDF in the active tab after the user opens the extension.                                                                                                                                                                       |
| `tabs`                                  | Reads tab URLs and titles to identify PDFs in the current window for the explicit window-upload action.                                                                                                                                        |
| `scripting`                             | Identifies PDFs by document type or by the URL and visibility of an embedded viewer. Handles the save shortcut in a full-page PDF embed.                                                                                                       |
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

| Version | Date       | Changes                                                                                         | Status      |
| ------- | ---------- | ----------------------------------------------------------------------------------------------- | ----------- |
| 0.4.1   | 2026-11-20 | Use English for the default extension and store language.                                       | Local build |
| 0.4.0   | 2026-11-20 | Localize the extension and store materials in ten languages.                                    | Store draft |
| 0.3.1   | 2026-11-19 | Save displayed PDFs by keyboard and recognize protected invoices in direct or embedded viewers. | Local build |
| 0.3.0   | 2026-11-17 | First store release with PDF uploads and import-status feedback.                                | Published   |

The initial release was submitted on November 16 by workflow run 43925511614. The [public store listing](https://chromewebstore.google.com/detail/paperless-upload/adpolpaolmleglppngfeoleclnoekmga) showed version 0.3.0 in German, dated November 17, when checked on November 20, 2026.

The [0.4.0 release workflow](https://github.com/JustAmply/Paperless-Extension/actions/runs/44652732907) uploaded the ten-language package as a draft. The localized detailed descriptions, screenshots, and global promotional tile still need to be saved in the Developer Dashboard before the draft is submitted for review.
