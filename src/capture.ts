import { localizeDocument, resolveMessage } from './shared/i18n.js';
import {
  capturePdf,
  finishPdfCapture,
  type CapturedPdf,
} from './data/sources.js';
import { errorMessage } from './shared/model.js';
import {
  documentSource,
  pdfFingerprint,
  pdfName,
  validatePdf,
} from './shared/pdf.js';
import { request } from './shared/messaging.js';
import {
  isLocalPdfViewer,
  writeLocalPdf,
  deleteLocalPdf,
} from './browser/local-pdf.js';
import { supportsBufferedPdfFallback } from './browser/native-fallback.js';

// Chromium drops its native handoff buffer above this size (MimeHandlerBodyCache).
const MAX_NATIVE_REPLAY_BYTES = 100 * 1024 * 1024;

localizeDocument();

function showError(error: unknown): void {
  const status = document.getElementById('status');
  if (status) {
    status.hidden = false;
    status.textContent = resolveMessage(errorMessage(error));
  }
}

async function uploadMetadata(
  pending: CapturedPdf,
  file: Blob,
  disposition: string,
): Promise<CapturedPdf> {
  try {
    await validatePdf(file);
    const fingerprint = await pdfFingerprint(file);
    return {
      ...pending,
      file,
      fingerprint,
      name: pdfName(pending.url, disposition, fingerprint),
    };
  } catch (error) {
    return { ...pending, error: errorMessage(error) };
  }
}

function offerLocalCopy(
  file: Blob,
  name: string,
  fragment: string,
  openViewer?: () => Promise<unknown>,
): void {
  const url = URL.createObjectURL(file);
  const open = document.querySelector<HTMLAnchorElement>('#open-pdf')!;
  const download = document.querySelector<HTMLAnchorElement>('#download-pdf')!;
  open.href = url + fragment;
  if (openViewer)
    open.addEventListener('click', (event) => {
      event.preventDefault();
      void openViewer().catch(showError);
    });
  download.href = url;
  download.download = name;
  document.title = name;
  document.getElementById('status')!.hidden = true;
  document.getElementById('local-file')!.hidden = false;
  open.focus();
}

async function capture(): Promise<void> {
  const stream = await chrome.mimeHandler.getStreamInfo();
  // A local copy opened below remains readable from its original tab, even
  // if Chrome has to reload it. Never wrap the local viewer recursively.
  if (
    stream.originalUrl.startsWith(`blob:${location.origin}/`) ||
    isLocalPdfViewer(stream.originalUrl)
  ) {
    await chrome.mimeHandler.abortAndFallbackToNativeHandler();
    return;
  }
  const url = documentSource(stream.originalUrl);
  const header = Object.entries(stream.responseHeaders).find(
    ([name]) => name.toLowerCase() === 'content-disposition',
  )?.[1];
  let disposition = typeof header === 'string' ? header : '';
  let pending: (CapturedPdf & { documentId: string }) | undefined;
  if (url) {
    try {
      const context = await request({
        target: 'background',
        type: 'capture-context',
        url,
      });
      if (!context.documentId) throw new Error('Missing capture document ID');
      disposition ||= context.disposition ?? '';
      const metadata = {
        tabId: stream.tabId,
        documentId: context.documentId,
        embedded: stream.embedded,
        url,
        name: pdfName(url, disposition),
        createdAt: Date.now(),
        fingerprint: crypto.randomUUID(),
      };
      await capturePdf(metadata);
      pending = metadata;
    } catch (error) {
      showError(error);
    }
  }

  // Chrome can reuse the original navigation only after its stream is drained.
  // Do this even if indexing failed or this source is ineligible for upload.
  let file: Blob;
  try {
    const response = await fetch(stream.streamUrl);
    if (!response.ok) throw new Error('Missing PDF stream');
    file = await response.blob();
    disposition ||= response.headers.get('content-disposition') ?? '';
  } catch (error) {
    if (pending)
      await finishPdfCapture(
        { ...pending, error: errorMessage(error) },
        pending.fingerprint,
      );
    throw error;
  }

  // A same-tab Blob URL can lose its creator as soon as the PDF opens.
  // A response beyond Chromium's buffer can only be replayed locally.
  const needsLocalCopy =
    (!stream.embedded && url?.startsWith('blob:')) ||
    file.size > MAX_NATIVE_REPLAY_BYTES ||
    !supportsBufferedPdfFallback();
  let viewerUrl: string | undefined;
  let name = url ? pdfName(url, disposition) : 'PDF.pdf';
  if (pending) {
    const metadata = await uploadMetadata(pending, file, disposition);
    name = metadata.name;
    if (needsLocalCopy && !stream.embedded) {
      try {
        viewerUrl = await writeLocalPdf(pending.documentId, name, file);
        metadata.viewerUrl = viewerUrl;
      } catch (error) {
        await deleteLocalPdf(pending.documentId).catch(showError);
        showError(error);
      }
    }
    try {
      if (!(await finishPdfCapture(metadata, pending.fingerprint))) {
        if (viewerUrl) await deleteLocalPdf(pending.documentId);
        return;
      }
    } catch (error) {
      if (viewerUrl) await deleteLocalPdf(pending.documentId).catch(showError);
      viewerUrl = undefined;
      showError(error);
    }
  }
  if (!needsLocalCopy) {
    await chrome.mimeHandler.abortAndFallbackToNativeHandler();
    return;
  }

  const tab = await chrome.tabs.get(stream.tabId);
  const current = stream.embedded
    ? stream.originalUrl
    : (tab.pendingUrl ?? tab.url);
  if (!current || (!stream.embedded && documentSource(current) !== url)) return;
  const fragment = new URL(current).hash;
  if (!viewerUrl) {
    // Preserve an embedding portal, or a PDF that exceeded local storage.
    offerLocalCopy(file, name, fragment);
    return;
  }

  // Chromium permits opening its private filesystem in a new tab. Keep
  // background document loads in the background and preserve the source tab.
  const target = viewerUrl + fragment;
  const openViewer = (active: boolean) =>
    chrome.tabs.create({
      url: target,
      windowId: tab.windowId,
      openerTabId: stream.tabId,
      index: tab.index + 1,
      active,
    });
  offerLocalCopy(file, name, fragment, () => openViewer(true));
  await openViewer(tab.active);
}

void capture().catch(showError);
