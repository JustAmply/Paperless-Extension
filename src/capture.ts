import { localizeDocument, resolveMessage } from './shared/i18n.js';
import {
  capturePdf,
  finishPdfCapture,
  type CapturedPdf,
} from './data/sources.js';
import { errorMessage } from './shared/model.js';
import { inspectPdfTab } from './browser/pdf-tabs.js';
import {
  documentSource,
  pdfFingerprint,
  pdfName,
  validatePdf,
} from './shared/pdf.js';
import { request } from './shared/messaging.js';

localizeDocument();

function showError(error: unknown): void {
  const status = document.getElementById('status');
  if (status) {
    status.hidden = false;
    status.textContent = resolveMessage(errorMessage(error));
  }
}

async function capture(): Promise<void> {
  const stream = await chrome.mimeHandler.getStreamInfo();
  const url = documentSource(stream.originalUrl);
  // Delegate unsupported schemes and the preview's own Blob to Chrome.
  // The portal's HTTP response must never enter the fallback reload path.
  if (
    !url ||
    (stream.embedded &&
      stream.originalUrl.startsWith(`blob:${location.origin}/`))
  ) {
    await chrome.mimeHandler.abortAndFallbackToNativeHandler();
    return;
  }
  const streamDisposition = Object.entries(stream.responseHeaders).find(
    ([name]) => name.toLowerCase() === 'content-disposition',
  )?.[1];
  let disposition =
    typeof streamDisposition === 'string' ? streamDisposition : '';
  const metadata: CapturedPdf = {
    tabId: stream.tabId,
    embedded: stream.embedded,
    url,
    name: pdfName(url, disposition),
    createdAt: Date.now(),
    fingerprint: crypto.randomUUID(),
  };
  let registered = false;
  try {
    const context = await request({
      target: 'background',
      type: 'capture-context',
      url,
    });
    if (!context.documentId) throw new Error('Missing viewer document ID');
    metadata.documentId = context.documentId;
    disposition ||= context.disposition ?? '';
    await capturePdf(metadata);
    registered = true;
  } catch (error) {
    showError(error);
  }
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
    if (registered) {
      await finishPdfCapture(
        { ...metadata, error: errorMessage(error) },
        metadata.fingerprint,
      ).catch(showError);
    }
    throw error;
  }
  if (registered) {
    try {
      await validatePdf(file);
      const fingerprint = await pdfFingerprint(file);
      metadata.name = pdfName(url, disposition, fingerprint);
      await finishPdfCapture(
        { ...metadata, fingerprint, file },
        metadata.fingerprint,
      );
      const status = document.getElementById('status');
      if (status) status.hidden = true;
    } catch (error) {
      await finishPdfCapture(
        { ...metadata, error: errorMessage(error) },
        metadata.fingerprint,
      ).catch(showError);
      showError(error);
    }
  }
  const viewer = document.createElement('iframe');
  viewer.title = metadata.name;
  // The preview and download share a local Blob URL. Neither needs to repeat
  // the portal request that generated this document.
  const tab = await chrome.tabs.get(stream.tabId);
  const fragment = new URL(
    stream.embedded ? stream.originalUrl : (tab.url ?? stream.originalUrl),
  ).hash;
  const objectUrl = URL.createObjectURL(file);
  viewer.src = objectUrl + fragment;
  document.title = metadata.name;
  const download = document.createElement('a');
  download.download = metadata.name;
  download.href = objectUrl;
  window.addEventListener('keydown', (event) => {
    if (
      event.isTrusted &&
      !event.defaultPrevented &&
      event.key.toLowerCase() === 's' &&
      event.ctrlKey !== event.metaKey &&
      !event.altKey &&
      !event.shiftKey
    ) {
      event.preventDefault();
      if (!event.repeat) download.click();
    }
  });
  document.body.append(viewer);
  if (!stream.embedded) {
    // A new PDF tab initially focuses Chrome's generated HTML document.
    window.focus();
  } else if (metadata.documentId) {
    const channel = `save-pdf:${metadata.documentId}`;
    const host = await inspectPdfTab(stream.tabId, url, channel);
    if (host?.acceptsSaveShortcut) {
      const port = chrome.tabs.connect(stream.tabId, {
        documentId: host.documentId,
        name: channel,
      });
      port.onMessage.addListener((message: unknown) => {
        if (message === 'save') download.click();
      });
    }
  }
}

void capture().catch(showError);
