import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hasPdfSignature,
  pdfName,
  readableSource,
  validatePdf,
} from '../../dist/shared/pdf.js';
import { MAX_PDF_BYTES, UserError } from '../../dist/shared/model.js';

const encode = (text) => new TextEncoder().encode(text);

test('PDF validation checks file bytes rather than trusting a supplied MIME type', async () => {
  await validatePdf(
    new Blob(['%PDF-1.7\n1 0 obj\n'], { type: 'application/octet-stream' }),
  );
  await assert.rejects(
    validatePdf(
      new Blob(['<html>Login required</html>'], { type: 'application/pdf' }),
    ),
    UserError,
  );
  await assert.rejects(validatePdf(new Blob()), UserError);
  assert.equal(hasPdfSignature(encode('%PDF-not-a-version')), false);
});

test('PDF header scanning stays within the supported first 1024 bytes', () => {
  assert.equal(hasPdfSignature(encode(`${' '.repeat(1016)}%PDF-2.0`)), true);
  assert.equal(hasPdfSignature(encode(`${' '.repeat(1024)}%PDF-1.7`)), false);
});

test('PDF size limit accepts the boundary and rejects larger files', async () => {
  const file = new Blob(['%PDF-1.7', new Uint8Array(MAX_PDF_BYTES - 8)]);
  assert.equal(file.size, MAX_PDF_BYTES);
  await validatePdf(file);
  await assert.rejects(validatePdf(new Blob([file, 'x'])), /zu groß/);
});

test('filenames prefer server metadata and remove path and control characters', () => {
  assert.equal(
    pdfName(
      'https://files.example/download',
      "attachment; filename*=UTF-8''Rechnung%20M%C3%A4rz.pdf",
    ),
    'Rechnung März.pdf',
  );
  assert.equal(
    pdfName(
      'https://files.example/download',
      'attachment; filename="folder/evil\\name\u0000.pdf"',
    ),
    'folder_evil_name_.pdf',
  );
  assert.equal(
    pdfName('https://files.example/Rechnung%20Juli.PDF?download=1'),
    'Rechnung Juli.PDF',
  );
  assert.equal(
    pdfName('https://files.example/', 'attachment; filename="50%.pdf"'),
    '50%.pdf',
  );
});

test('PDF names preserve explicit filenames without treating URL routes as filenames', () => {
  const url = 'https://files.example/download?id=42';
  assert.equal(
    pdfName(url, 'attachment; filename="Invoice 2026"'),
    'Invoice 2026.pdf',
  );
  assert.equal(
    pdfName(url, 'attachment; filename="invoice.html"'),
    'invoice.html.pdf',
  );
  assert.equal(pdfName(url), 'Dokument.pdf');
});

test('long PDF filenames are truncated before the suffix', () => {
  const stem = 'a'.repeat(181);
  assert.equal(
    pdfName(`https://files.example/${stem}.PDF`),
    `${stem.slice(0, 176)}.PDF`,
  );
  assert.equal(
    pdfName('https://files.example/', `attachment; filename="${stem}"`),
    `${stem.slice(0, 176)}.pdf`,
  );
});

test('names use explicit filename parameters or a distinct source-based fallback', () => {
  assert.equal(
    pdfName('https://files.example/download?filename=Rechnung%20April.pdf'),
    'Rechnung April.pdf',
  );
  assert.equal(
    pdfName('blob:https://files.example/id', '', 'abcdef0123456789'),
    'PDF von files.example – abcdef01.pdf',
  );
  assert.equal(
    pdfName(
      'https://files.example/download?token=secret.pdf',
      '',
      '1234567890abcdef',
    ),
    'PDF von files.example – 12345678.pdf',
  );
});

test('source URLs only allow directly retrievable schemes and omit PDF viewer fragments', () => {
  assert.equal(
    readableSource('https://files.example/invoice.pdf?download=1#page=2'),
    'https://files.example/invoice.pdf?download=1',
  );
  assert.equal(
    readableSource('file:///C:/Users/User/invoice.pdf#page=2'),
    'file:///C:/Users/User/invoice.pdf',
  );
  for (const url of [
    undefined,
    '',
    'not a URL',
    'blob:https://files.example/id',
    'data:application/pdf;base64,JVBERg==',
    'chrome://extensions/',
    'chrome-extension://other/viewer.html',
  ]) {
    assert.equal(readableSource(url), undefined);
  }
});
