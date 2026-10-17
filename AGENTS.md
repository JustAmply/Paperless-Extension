# Paperless Upload

Focused Manifest V3 Chrome extension. Its only product feature is PDF upload to a user-configured Paperless-ngx server. UI copy is German; source, documentation, and identifiers are English.

- Use strict TypeScript, native ES modules, and browser APIs without runtime dependencies or remote code.
- For changes to the upload flow, permissions, or lifecycle, read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for component responsibilities and platform constraints.
- Never send PDF blobs through Chrome JSON messaging. Store blobs temporarily in IndexedDB; messages carry control data only.
- The Paperless token belongs only in `chrome.storage.local`, restricted to trusted extension contexts. Never put it in job records, source requests, logs, screenshots, or tests against real accounts.
- Never automatically retry an upload POST. An ambiguous response means the server may already have accepted the file.
- Success means accepted for processing, not imported or archived. Keep this distinction in UI copy and tests.
- Change source files, then regenerate `dist/` with `npm run build`. Keep generated output untracked.
- Run `npm run check` before finishing. This checks formatting, strict compilation, Node unit tests, and browser tests of the built extension. After dependency changes, run `npm ci` and install Chromium with `npx playwright install chromium`.
- Keep package and manifest versions aligned. `npm run package` creates a loadable ZIP without adding runtime dependencies.
- Preserve upstream logo attribution and GPL license files.
