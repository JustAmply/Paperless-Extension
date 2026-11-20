import assert from 'node:assert/strict';
import test from 'node:test';
import { checkImport } from '../../dist/services/import-task.js';

const settings = {
  url: 'https://fixture.invalid/paperless/',
  token: 'fixture-token',
};
const taskId = '12345678-1234-4567-89ab-123456789abc';

test('task lookup stays on the configured server and supports legacy string document IDs', async (t) => {
  let request;
  const fetch = t.mock.method(globalThis, 'fetch', async (url, init) => {
    request = new Request(url, init);
    return Response.json([
      { task_id: 'other-task', status: 'SUCCESS', related_document: '99' },
      { task_id: taskId, status: 'SUCCESS', related_document: '42' },
    ]);
  });
  assert.deepEqual(await checkImport(settings, taskId), {
    status: 'success',
    message: { key: 'importSuccess' },
    documentId: 42,
  });
  assert.equal(request.url, `${settings.url}api/tasks/?task_id=${taskId}`);
  assert.equal(request.headers.get('authorization'), 'Token fixture-token');
  assert.equal(request.credentials, 'omit');
  assert.equal(request.redirect, 'error');
  assert.equal(request.method, 'GET');
  assert.equal(fetch.mock.callCount(), 1);
});

test('API v10 paginated task results confirm success and duplicates from structured fields', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () =>
    Response.json({
      results: [
        {
          task_id: taskId,
          status: 'success',
          result_data: { document_id: 12 },
        },
      ],
    }),
  );
  assert.equal((await checkImport(settings, taskId)).documentId, 12);
  fetch.mock.mockImplementation(async () =>
    Response.json({
      results: [
        {
          task_id: taskId,
          status: 'failure',
          result_data: { duplicate_of: 18 },
        },
      ],
    }),
  );
  const result = await checkImport(settings, taskId);
  assert.equal(result.status, 'duplicate');
  assert.equal(result.documentId, 18);
});

test('legacy duplicate results and ongoing tasks have distinct outcomes', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () =>
    Response.json([
      { task_id: taskId, status: 'FAILURE', related_document: '7' },
    ]),
  );
  assert.equal((await checkImport(settings, taskId)).status, 'duplicate');
  for (const status of ['PENDING', 'STARTED', 'RETRY', 'pending', 'started']) {
    fetch.mock.mockImplementation(async () =>
      Response.json([{ task_id: taskId, status }]),
    );
    assert.equal((await checkImport(settings, taskId)).status, 'pending');
  }
});

test('unknown or malformed responses never claim an import or expose server details', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch');
  for (const body of [
    null,
    { detail: 'private server message' },
    [],
    [{ task_id: 'different', status: 'SUCCESS', related_document: 5 }],
    [{ task_id: taskId, status: 'SUCCESS' }],
    [{ task_id: taskId, status: 'SUCCESS', related_document: '../secret' }],
    [{ task_id: taskId, status: 'SUCCESS', related_document: -1 }],
    [
      {
        task_id: taskId,
        status: 'SUCCESS',
        related_document: Number.MAX_SAFE_INTEGER + 1,
      },
    ],
    [{ task_id: taskId, status: 'unknown', result: 'private server message' }],
  ]) {
    fetch.mock.mockImplementation(async () => Response.json(body));
    const result = await checkImport(settings, taskId);
    assert.equal(result.status, 'unavailable');
    assert.equal(result.documentId, undefined);
    assert.doesNotMatch(
      JSON.stringify(result.message),
      /private server message/,
    );
  }
});

test('failure text is not interpreted as a duplicate or shown to users', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json([
      { task_id: taskId, status: 'FAILURE', result: 'duplicate secret token' },
    ]),
  );
  const result = await checkImport(settings, taskId);
  assert.equal(result.status, 'failure');
  assert.deepEqual(result.message, { key: 'importFailed' });
});

test('network, HTTP, and invalid JSON errors leave upload acceptance untouched', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch');
  for (const status of [401, 403, 404, 429, 500]) {
    fetch.mock.mockImplementation(
      async () => new Response('private detail', { status }),
    );
    assert.equal((await checkImport(settings, taskId)).status, 'unavailable');
    assert.equal(
      (await checkImport(settings, taskId)).retryable === true,
      status === 429 || status >= 500,
    );
  }
  fetch.mock.mockImplementation(
    async () => new Response('<html>Sign in</html>'),
  );
  assert.equal((await checkImport(settings, taskId)).status, 'unavailable');
  fetch.mock.mockImplementation(async () => {
    throw new TypeError('Failed to fetch');
  });
  assert.equal((await checkImport(settings, taskId)).status, 'unavailable');
});
