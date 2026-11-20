# Chrome Web Store releases

The existing **Verify and package** workflow checks every push and pull request. **Publish to Chrome Web Store** is a separate, manually dispatched workflow on `main`. It checks the requested version, runs `npm run check`, packages the extension, and preserves the exact ZIP as a workflow artifact. A separate publishing job obtains a short-lived Google service-account token through GitHub OIDC and uploads that artifact. No service-account key or OAuth refresh token is stored in GitHub.

## One-time setup

1. Create the item in the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole). The API cannot create a new item; upload the first ZIP through the dashboard. Complete the listing, privacy disclosures, screenshots, distribution settings, and review notes from [CHROMEWEBSTORE.md](../CHROMEWEBSTORE.md).
2. Enable the Chrome Web Store API and IAM Service Account Credentials API in the Google Cloud project. Create a service account without project-wide roles, or reuse the account already linked to this publisher. The store currently allows only **one linked service account per publisher**; do not replace an existing one used by other extensions. Link its email under the publisher's Account settings.
3. Create a Workload Identity pool/provider for GitHub's issuer `https://token.actions.githubusercontent.com`. Map `google.subject=assertion.sub`. The condition below reads the repository assertions directly; additional attribute mappings are not required. Restrict the provider condition to this repository's numeric ID, its owner's numeric ID, `assertion.ref == 'refs/heads/main'`, and `assertion.workflow_ref == 'JustAmply/Paperless-Extension/.github/workflows/publish.yml@refs/heads/main'`. Numeric IDs prevent another owner from obtaining access by reusing a repository name.
4. Grant `roles/iam.workloadIdentityUser` **on that service account only** to the pool subject `repo:JustAmply@15849513/Paperless-Extension@1451509304:environment:chrome-web-store`. The IAM principal is `principal://iam.googleapis.com/projects/403016675760/locations/global/workloadIdentityPools/paperless-github/subject/repo:JustAmply@15849513/Paperless-Extension@1451509304:environment:chrome-web-store`. No Owner or Editor role is needed. Allow several minutes for IAM changes to propagate.
5. Create the GitHub environment `chrome-web-store`, restrict deployment branches to `main`, and configure its variables below. Add a required reviewer when supported by the repository's GitHub plan. The explicit workflow dispatch remains the release approval when environment reviewers are unavailable.

| Environment variable             | Value                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------ |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | `projects/403016675760/locations/global/workloadIdentityPools/paperless-github/providers/github` |
| `GCP_SERVICE_ACCOUNT`            | `chrome-extension-publisher@chrome-extensions-470306.iam.gserviceaccount.com`                    |
| `CWS_PUBLISHER_ID`               | `e4931f52-f369-4c07-b9af-5037f4827df8`                                                           |
| `CWS_EXTENSION_ID`               | `adpolpaolmleglppngfeoleclnoekmga`                                                               |

These are identifiers, not secrets. The workflow requests only the `https://www.googleapis.com/auth/chromewebstore` OAuth scope. Store authorization is publisher-wide, so restrict the GitHub identity at the provider and service-account IAM binding as described above.

## Release an update

1. Update `package.json`, `package-lock.json`, and `manifest.json` together to a version newer than the store's last upload. Update the listing/version history when needed. Commit and push the intended release to `main`.
2. In GitHub Actions, select **Publish to Chrome Web Store → Run workflow**, choose `main`, and enter the exact manifest version.
3. Select `upload` to save a draft without requesting publication, or `publish` to upload and submit for review with automatic publication after approval. Approve the deployment environment if configured.
4. Read the workflow summary and verify the revision in the Developer Dashboard. `PENDING_REVIEW` means submitted, not publicly available. Visibility is inherited from the store item; a visibility change must first be published through the dashboard.

The workflow never runs on a push or tag, never skips review, and stops on store validation warnings. It polls asynchronous package processing for up to five minutes. Upload and publish POSTs are never retried automatically. After any uncertain network response or failed run, inspect the Dashboard before rerunning; the store might already have accepted the package. A draft uploaded successfully can be submitted directly in the Dashboard without uploading the same version again.

## Localized store materials

Run `npm run build` followed by `node scripts/store-assets.mjs` with Playwright Chromium installed. For every packaged locale, the generator opens a synthetic invoice in an isolated browser profile, uploads it to a local fixture, waits for import success and captures the actual popup. It renders one 1280 × 800 store screenshot per language under `store/graphics/<locale>/` and one global 440 × 280 promotional tile. The translated headlines and sample filenames are in [store/screenshot-copy.json](../store/screenshot-copy.json).

When the release changes listing text or graphics:

1. Choose `upload` in the release workflow to create a package draft. The uploaded package supplies the locale list and localized short descriptions.
2. Open **Store listing** in the Developer Dashboard. Select each language, paste its [detailed description](../store/listing/) and replace its localized screenshot with the matching `screenshot-1280x800.png`. Use the English screenshot for the default listing.
3. Replace the global small promotional tile with `store/graphics/promo-440x280.png`. Save the listing and verify the language selections, images and descriptions before submitting the draft for review.

## References

- [Chrome Web Store API usage](https://developer.chrome.com/docs/webstore/using-api)
- [Localize a Chrome Web Store listing](https://developer.chrome.com/docs/webstore/cws-dashboard-listing#localize-your-listing)
- [Store service-account setup and publisher limitation](https://developer.chrome.com/docs/webstore/service-accounts)
- [GitHub Actions authentication and Workload Identity Federation](https://github.com/google-github-actions/auth)
- [Upload state values](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/UploadState)
- [Publish request and review semantics](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/publish)
