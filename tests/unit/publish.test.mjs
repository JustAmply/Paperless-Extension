import assert from 'node:assert/strict';
import test from 'node:test';
import { publishPackage, validateVersion } from '../../scripts/publish.mjs';

const options = {
  token: 'fixture-token',
  publisherId: 'fixture-publisher',
  extensionId: 'a'.repeat(32),
  operation: 'publish',
  zip: Buffer.from('fixture-package'),
};

function fixture(responses) {
  const calls = [];
  const sleeps = [];
  return {
    calls,
    sleeps,
    fetch: async (url, init) => {
      calls.push({ url, ...init });
      const response = responses.shift();
      if (response instanceof Error) throw response;
      assert.ok(response, 'Unexpected request');
      return response instanceof Response ? response : Response.json(response);
    },
    sleep: async (duration) => sleeps.push(duration),
  };
}

test('release version must explicitly match the manifest', () => {
  validateVersion('0.3.0', '0.3.0');
  for (const version of [undefined, '', '0.3.1', '../0.3.0', 'v0.3.0'])
    assert.throws(() => validateVersion(version, '0.3.0'));
});

test('draft upload sends ZIP bytes to the media endpoint without publishing', async () => {
  const transport = fixture([{ uploadState: 'SUCCEEDED' }]);
  const summary = await publishPackage(
    { ...options, operation: 'upload' },
    transport,
  );
  assert.match(summary, /not been submitted/);
  assert.equal(transport.calls.length, 1);
  const [upload] = transport.calls;
  assert.equal(
    upload.url,
    `https://chromewebstore.googleapis.com/upload/v2/publishers/fixture-publisher/items/${options.extensionId}:upload`,
  );
  assert.equal(upload.method, 'POST');
  assert.equal(upload.headers.Authorization, 'Bearer fixture-token');
  assert.equal(upload.headers['Content-Type'], 'application/zip');
  assert.equal(upload.body, options.zip);
  assert.equal(upload.redirect, 'error');
});

test('asynchronous upload is polled before submitting with warnings blocking publication', async () => {
  const transport = fixture([
    { uploadState: 'IN_PROGRESS' },
    { lastAsyncUploadState: 'IN_PROGRESS' },
    { lastAsyncUploadState: 'SUCCEEDED' },
    { state: 'PENDING_REVIEW' },
  ]);
  const summary = await publishPackage(options, transport);
  assert.match(summary, /PENDING_REVIEW/);
  assert.deepEqual(
    transport.calls.map(({ method }) => method),
    ['POST', 'GET', 'GET', 'POST'],
  );
  assert.ok(transport.calls[1].url.endsWith(':fetchStatus'));
  assert.ok(transport.calls[3].url.endsWith(':publish'));
  assert.deepEqual(JSON.parse(transport.calls[3].body), {
    publishType: 'DEFAULT_PUBLISH',
    blockOnWarnings: true,
  });
  assert.deepEqual(transport.sleeps, [5000, 5000]);
});

test('failed or unrecognized upload states never submit the item', async () => {
  for (const state of ['FAILED', 'NOT_FOUND', undefined]) {
    const transport = fixture([{ uploadState: state }]);
    await assert.rejects(
      publishPackage(options, transport),
      /Upload did not succeed/,
    );
    assert.equal(transport.calls.length, 1);
  }
});

test('upload polling stops after five minutes without repeating the upload', async () => {
  const transport = fixture([
    { uploadState: 'IN_PROGRESS' },
    ...Array.from({ length: 60 }, () => ({
      lastAsyncUploadState: 'IN_PROGRESS',
    })),
  ]);
  await assert.rejects(
    publishPackage(options, transport),
    /Upload did not succeed/,
  );
  assert.equal(transport.calls.length, 61);
  assert.equal(
    transport.calls.filter(({ method }) => method === 'POST').length,
    1,
  );
});

test('HTTP and network failures never retry uploads or leak response bodies', async () => {
  for (const response of [
    new Response('private server response', { status: 403 }),
    new Error('network error'),
  ]) {
    const transport = fixture([response]);
    await assert.rejects(publishPackage(options, transport), (error) => {
      assert.doesNotMatch(
        error.message,
        /private server response|fixture-token/,
      );
      return true;
    });
    assert.equal(transport.calls.length, 1);
  }
});

test('publish failure is reported without automatically resubmitting', async () => {
  const transport = fixture([
    { uploadState: 'SUCCEEDED' },
    new Response('', { status: 400 }),
  ]);
  await assert.rejects(publishPackage(options, transport), /HTTP 400/);
  assert.equal(transport.calls.length, 2);
});

test('rejected submission is not reported as successful', async () => {
  const transport = fixture([
    { uploadState: 'SUCCEEDED' },
    { state: 'REJECTED' },
  ]);
  await assert.rejects(
    publishPackage(options, transport),
    /Unexpected submission state/,
  );
});

test('missing configuration fails before any remote mutation', async () => {
  for (const changes of [
    { token: '' },
    { publisherId: '' },
    { extensionId: '' },
    { operation: 'invalid' },
  ]) {
    const transport = fixture([]);
    await assert.rejects(publishPackage({ ...options, ...changes }, transport));
    assert.equal(transport.calls.length, 0);
  }
});
