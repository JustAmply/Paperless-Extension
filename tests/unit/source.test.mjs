import assert from 'node:assert/strict';
import test from 'node:test';
import german from '../../_locales/de/messages.json' with { type: 'json' };
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
  await assert.rejects(downloadPdf('https://files.example/large.pdf'), {
    userMessage: { key: 'pdfTooLarge' },
  });
  assert.equal(cancelled, true);
});

test('source HTTP and network failures explain the manual upload path', async (t) => {
  const fetchMock = t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(null, { status: 403 }),
  );
  await assert.rejects(downloadPdf('https://files.example/private.pdf'), {
    userMessage: { key: 'sourceDenied', substitutions: ['403'] },
  });
  fetchMock.mock.mockImplementation(async () => {
    throw new TypeError('Failed to fetch');
  });
  await assert.rejects(downloadPdf('https://files.example/private.pdf'), {
    userMessage: { key: 'sourceFetchFailed' },
  });
  assert.match(german.sourceFetchFailed.message, /herunter.*hinein/);
});

test('expired PDF links explain that nothing was sent to Paperless', async (t) => {
  const fetchMock = t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(null, { status: 404 }),
  );
  await assert.rejects(downloadPdf('https://files.example/once'), {
    userMessage: { key: 'sourceExpired', substitutions: ['404'] },
  });
  assert.match(
    german.sourceExpired.message,
    /abgelaufen oder nur einmal gültig/,
  );
  assert.match(german.sourceExpired.message, /nichts an Paperless gesendet/);
  assert.match(german.sourceExpired.message, /PDF-Viewer/);
  assert.equal(fetchMock.mock.callCount(), 1);
});

test('a broken response stream keeps actionable guidance even when cancellation rejects', async (t) => {
  let reads = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (reads++ === 0) controller.enqueue(encode('%PDF-1.7\n'));
      else controller.error(new TypeError('Connection interrupted'));
    },
  });
  t.mock.method(globalThis, 'fetch', async () => new Response(stream));
  await assert.rejects(downloadPdf('https://files.example/interrupted.pdf'), {
    userMessage: { key: 'sourceInterrupted' },
  });
  assert.match(
    german.sourceInterrupted.message,
    /Abruf der PDF wurde unterbrochen/,
  );
  assert.match(german.sourceInterrupted.message, /PDF-Viewer/);
});
