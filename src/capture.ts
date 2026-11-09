import { capturePdf } from './data/sources.js';
import { errorMessage, UserError } from './shared/model.js';
import {
  documentSource,
  pdfFingerprint,
  pdfName,
  validatePdf,
} from './shared/pdf.js';
import { request } from './shared/messaging.js';

function showError(error: unknown): void {
  const status = document.getElementById('status');
  if (status) {
    status.hidden = false;
    status.textContent = errorMessage(error);
  }
}

async function capture(): Promise<void> {
  const stream = await chrome.mimeHandler.getStreamInfo();
  const url = documentSource(stream.originalUrl);
  if (!url) throw new UserError('Diese PDF-Adresse wird nicht unterstützt.');
  const streamDisposition = Object.entries(stream.responseHeaders).find(
    ([name]) => name.toLowerCase() === 'content-disposition',
  )?.[1];
  let disposition =
    typeof streamDisposition === 'string' ? streamDisposition : '';
  if (!disposition && /^https?:/.test(url)) {
    const response = await request({
      target: 'background',
      type: 'pdf-disposition',
      url,
    }).catch(() => undefined);
    disposition = response?.disposition ?? '';
  }
  const metadata = {
    tabId: stream.tabId,
    url,
    name: pdfName(url, disposition),
    createdAt: Date.now(),
    fingerprint: crypto.randomUUID(),
  };
  await capturePdf(metadata).catch(showError);
  let file: Blob;
  try {
    const response = await fetch(stream.streamUrl);
    if (!response.ok) throw new Error('Missing PDF stream');
    disposition ||= response.headers.get('content-disposition') ?? '';
    metadata.name = pdfName(url, disposition);
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
    const fingerprint = await pdfFingerprint(file);
    metadata.name = pdfName(url, disposition, fingerprint);
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
