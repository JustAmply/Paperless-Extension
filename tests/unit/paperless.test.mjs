import assert from 'node:assert/strict';
import test from 'node:test';
import { uploadPdf, verifyConnection } from '../../dist/services/paperless.js';
import { UserError } from '../../dist/shared/model.js';

const settings = {
  url: 'https://paperless.example/archive/',
  token: 'private-api-token',
};
const pdf = new Blob(['%PDF-1.7\n'], { type: 'application/pdf' });
const taskId = '12345678-1234-4567-89ab-123456789abc';

test('connection verification authenticates against the profile endpoint and preserves installation subpaths', async (t) => {
  let request;
  const fetchMock = t.mock.method(globalThis, 'fetch', async (input, init) => {
    request = new Request(input, init);
    return Response.json({ email: '', auth_token: settings.token });
  });
  await verifyConnection(settings);
  assert.equal(request.url, 'https://paperless.example/archive/api/profile/');
  assert.equal(request.headers.get('authorization'), `Token ${settings.token}`);
  assert.equal(request.credentials, 'omit');
  assert.equal(request.redirect, 'manual');
  fetchMock.mock.mockImplementation(
    async () =>
      new Response('<html>Log in</html>', {
        headers: { 'content-type': 'text/html' },
      }),
  );
  await assert.rejects(verifyConnection(settings), /keine Paperless-API/);
  fetchMock.mock.mockImplementation(async () =>
    Response.json({ auth_token: 'different-fixture-token' }),
  );
  await assert.rejects(verifyConnection(settings), /keine Paperless-API/);
});

test('connection verification rejects invalid tokens rather than accepting the public API root', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ detail: 'Invalid token.' }, { status: 401 }),
  );
  await assert.rejects(verifyConnection(settings), /API-Token ist ungültig/);
  assert.equal(fetchMock.mock.callCount(), 1);
});

test('connection verification reports redirects without following them or sending the token elsewhere', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () =>
    Response.redirect('https://login.example/', 302),
  );
  await assert.rejects(
    verifyConnection(settings),
    /leitet die API-Anfrage weiter/,
  );
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.equal(fetchMock.mock.calls[0].arguments[1].redirect, 'manual');
});

test('upload confines the token to the configured destination and sends the named PDF as multipart', async (t) => {
  let request;
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    request = new Request(input, init);
    return Response.json(taskId);
  });
  assert.deepEqual(await uploadPdf(settings, pdf, 'Rechnung März.pdf'), {
    status: 'accepted',
    taskId,
  });
  assert.equal(
    request.url,
    'https://paperless.example/archive/api/documents/post_document/',
  );
  assert.equal(request.method, 'POST');
  assert.equal(request.headers.get('authorization'), `Token ${settings.token}`);
  assert.equal(request.credentials, 'omit');
  assert.equal(request.redirect, 'error');
  assert.match(
    request.headers.get('content-type'),
    /^multipart\/form-data; boundary=/,
  );
  assert.equal(request.url.includes(settings.token), false);
  const form = await request.formData();
  assert.deepEqual([...form.keys()], ['document']);
  const document = form.get('document');
  assert.equal(document.name, 'Rechnung März.pdf');
  assert.equal(document.type, 'application/pdf');
  assert.equal(await document.text(), await pdf.text());
});

test('known HTTP rejections remain actionable failures and never trigger a retry', async (t) => {
  for (const [status, message] of [
    [401, /Token/],
    [403, /Berechtigung/],
    [413, /Dateigröße/],
    [429, /Zu viele/],
    [404, /HTTP 404/],
  ]) {
    const fetchMock = t.mock.method(
      globalThis,
      'fetch',
      async () => new Response(null, { status }),
    );
    await assert.rejects(
      uploadPdf(settings, pdf, 'invoice.pdf'),
      (error) => error instanceof UserError && message.test(error.message),
    );
    assert.equal(fetchMock.mock.callCount(), 1);
    fetchMock.mock.restore();
  }
});

test('ambiguous upload outcomes are uncertain and are never automatically repeated', async (t) => {
  const outcomes = [
    () => new Response(null, { status: 500 }),
    () => new Response(null, { status: 502 }),
    () => {
      throw new TypeError('Connection dropped after server accepted bytes');
    },
    () => Response.json({ task: taskId }),
    () => Response.json('not-a-task-id'),
    () => new Response('<html>proxy response</html>'),
  ];
  for (const outcome of outcomes) {
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => outcome());
    assert.deepEqual(await uploadPdf(settings, pdf, 'invoice.pdf'), {
      status: 'uncertain',
    });
    assert.equal(fetchMock.mock.callCount(), 1);
    fetchMock.mock.restore();
  }
});

test('connection errors do not expose server response bodies or credential values', async (t) => {
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(`proxy: ${settings.token}`, { status: 403 }),
  );
  await assert.rejects(
    verifyConnection(settings),
    (error) =>
      error instanceof UserError && !error.message.includes(settings.token),
  );
});
