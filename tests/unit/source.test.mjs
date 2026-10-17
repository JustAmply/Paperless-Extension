import assert from 'node:assert/strict';
import test from 'node:test';
import { downloadPdf } from '../../dist/services/source.js';
import { MAX_PDF_BYTES } from '../../dist/shared/model.js';

const encode = (text) => new TextEncoder().encode(text);

test('source fetch preserves authenticated document access without an API token or probe request', async (t) => {
  let request;
  const fetchMock = t.mock.method(globalThis, 'fetch', async (input, init) => {
    request = new Request(input, init);
    return new Response('%PDF-1.7\nactual bytes', {
      headers: {
        'content-type': 'application/octet-stream',
        'content-disposition': 'attachment; filename="invoice.pdf"',
      },
    });
  });
  const result = await downloadPdf('https://bank.example/document?id=once');
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.equal(request.method, 'GET');
  assert.equal(request.credentials, 'include');
  assert.equal(request.headers.has('authorization'), false);
  assert.equal(result.name, 'invoice.pdf');
  assert.equal(await result.file.text(), '%PDF-1.7\nactual bytes');
});

test('streamed PDF headers are recognized across network chunk boundaries', async (t) => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encode('%P'));
      controller.enqueue(encode('DF-1.7\n'));
      controller.enqueue(new Uint8Array(1200));
      controller.close();
    },
  });
  t.mock.method(globalThis, 'fetch', async () => new Response(stream));
  const result = await downloadPdf('https://files.example/download');
  assert.equal(result.file.type, 'application/pdf');
  assert.equal(result.file.size, 1209);
});

test('non-PDF bodies are rejected and the remaining network stream is cancelled', async (t) => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encode('<html>'.padEnd(1100, ' ')));
    },
    cancel() {
      cancelled = true;
    },
  });
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(stream, { headers: { 'content-type': 'application/pdf' } }),
  );
  assert.equal(
    await downloadPdf('https://files.example/spoofed.pdf'),
    undefined,
  );
  assert.equal(cancelled, true);
});

test('streaming stops at the size limit even without a trustworthy content length', async (t) => {
  let cancelled = false;
  const largeChunk = new Uint8Array(MAX_PDF_BYTES);
  largeChunk.set(encode('%PDF-1.7'));
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(largeChunk);
      controller.enqueue(encode('x'));
    },
    cancel() {
      cancelled = true;
    },
  });
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(stream, { headers: { 'content-length': '1' } }),
  );
  await assert.rejects(
    downloadPdf('https://files.example/large.pdf'),
    /zu groß/,
  );
  assert.equal(cancelled, true);
});

test('source HTTP and network failures explain the manual upload path', async (t) => {
  const fetchMock = t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(null, { status: 403 }),
  );
  await assert.rejects(
    downloadPdf('https://files.example/private.pdf'),
    /HTTP 403/,
  );
  fetchMock.mock.mockImplementation(async () => {
    throw new TypeError('Failed to fetch');
  });
  await assert.rejects(
    downloadPdf('https://files.example/private.pdf'),
    /herunter.*hinein/,
  );
});
