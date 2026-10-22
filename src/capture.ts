import { capturePdf } from './data/sources.js';
import { errorMessage, UserError } from './shared/model.js';
import { pdfName, readableSource, validatePdf } from './shared/pdf.js';

function showError(error: unknown): void {
  const status = document.getElementById('status');
  if (status) {
    status.hidden = false;
    status.textContent = errorMessage(error);
  }
}

async function capture(): Promise<void> {
  const stream = await chrome.mimeHandler.getStreamInfo();
  const url = readableSource(stream.originalUrl);
  if (!url) throw new UserError('Diese PDF-Adresse wird nicht unterstützt.');
  const disposition = Object.entries(stream.responseHeaders).find(
    ([name]) => name.toLowerCase() === 'content-disposition',
  )?.[1];
  const metadata = {
    tabId: stream.tabId,
    url,
    name: pdfName(url, typeof disposition === 'string' ? disposition : ''),
    createdAt: Date.now(),
    fingerprint: crypto.randomUUID(),
  };
  await capturePdf(metadata).catch(showError);
  let file: Blob;
  try {
    const response = await fetch(stream.streamUrl);
    if (!response.ok) throw new Error('Missing PDF stream');
    // Let the browser assemble a Blob without copying the document into a
    // JavaScript byte array. The viewer also supports PDFs above the upload cap.
    file = await response.blob();
  } catch (error) {
    await capturePdf({ ...metadata, error: errorMessage(error) }).catch(
      showError,
    );
    throw error;
  }
  const status = document.getElementById('status');
  if (status) status.hidden = true;
  try {
    await validatePdf(file);
    const digest = await crypto.subtle.digest(
      'SHA-256',
      await file.arrayBuffer(),
    );
    const fingerprint = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    await capturePdf({ ...metadata, fingerprint, file });
  } catch (error) {
    await capturePdf({ ...metadata, error: errorMessage(error) }).catch(
      showError,
    );
    showError(error);
  }
  const viewer = document.createElement('iframe');
  viewer.title = metadata.name;
  // Embedded PDFs use Chrome's native viewer because our MIME handler only
  // claims top-level documents. A blob URL never replays the source request.
  const tab = await chrome.tabs.get(stream.tabId);
  const fragment = new URL(tab.url ?? stream.originalUrl).hash;
  viewer.src = URL.createObjectURL(file) + fragment;
  document.title = metadata.name;
  document.body.append(viewer);
}

void capture().catch(showError);
