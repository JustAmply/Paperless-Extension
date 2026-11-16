import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

export function validateVersion(requested, actual) {
  if (!/^\d+\.\d+\.\d+$/.test(requested) || requested !== actual)
    throw new Error('The requested release version must match manifest.json.');
}

export async function publishPackage(
  { token, publisherId, extensionId, operation, zip },
  { fetch = globalThis.fetch, sleep = setTimeout } = {},
) {
  if (!token || !publisherId || !/^[a-p]{32}$/.test(extensionId))
    throw new Error('Chrome Web Store credentials and item IDs are required.');
  if (!['upload', 'publish'].includes(operation))
    throw new Error('Release operation must be upload or publish.');
  const resource = `publishers/${encodeURIComponent(publisherId)}/items/${extensionId}`;
  const api = `https://chromewebstore.googleapis.com/v2/${resource}`;
  async function request(url, method, body, contentType) {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(contentType ? { 'Content-Type': contentType } : {}),
      },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
    });
    // Do not log response bodies or automatically repeat a state-changing request.
    if (!response.ok)
      throw new Error(
        `Chrome Web Store ${method} request failed (HTTP ${response.status}). Check the Developer Dashboard before retrying.`,
      );
    return response.json();
  }

  const uploaded = await request(
    `https://chromewebstore.googleapis.com/upload/v2/${resource}:upload`,
    'POST',
    zip,
    'application/zip',
  );
  let uploadState = uploaded.uploadState;
  for (
    let attempt = 0;
    uploadState === 'IN_PROGRESS' && attempt < 60;
    attempt++
  ) {
    await sleep(5000);
    const status = await request(`${api}:fetchStatus`, 'GET');
    uploadState = status.lastAsyncUploadState;
  }
  if (uploadState !== 'SUCCEEDED')
    throw new Error(
      `Upload did not succeed (${uploadState ?? 'unknown state'}). Check the Developer Dashboard before retrying.`,
    );
  if (operation === 'upload')
    return 'Package uploaded as a draft. It has not been submitted for review.';

  const published = await request(
    `${api}:publish`,
    'POST',
    JSON.stringify({ publishType: 'DEFAULT_PUBLISH', blockOnWarnings: true }),
    'application/json',
  );
  if (
    !['PENDING_REVIEW', 'PUBLISHED', 'PUBLISHED_TO_TESTERS'].includes(
      published.state,
    )
  )
    throw new Error(
      `Unexpected submission state (${published.state ?? 'unknown state'}). Check the Developer Dashboard.`,
    );
  return `Submission accepted. Chrome Web Store state: ${published.state}. Publication remains subject to store review and the item's visibility settings.`;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const root = path.resolve(import.meta.dirname, '..');
  const manifest = JSON.parse(
    await readFile(path.join(root, 'manifest.json'), 'utf8'),
  );
  const version = process.env.RELEASE_VERSION;
  validateVersion(version, manifest.version);
  const summary = await publishPackage({
    token: process.env.CWS_ACCESS_TOKEN,
    publisherId: process.env.CWS_PUBLISHER_ID,
    extensionId: process.env.CWS_EXTENSION_ID,
    operation: process.env.RELEASE_OPERATION,
    zip: await readFile(
      path.join(root, 'artifacts', `paperless-upload-${version}.zip`),
    ),
  });
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
}
