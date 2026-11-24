const pdfMime = 'application/pdf';
const disabledForCompatibility = 'pdfCaptureDisabledForCompatibility';

export function supportsBufferedPdfFallback(): boolean {
  // Chrome 157 first shipped the navigation interceptor that serves the
  // buffered response before another request reaches the original URL.
  const version = /Chrome\/(\d+)/.exec(navigator.userAgent);
  return Number(version?.[1]) >= 157;
}

export async function configureNativePdfHandling(): Promise<void> {
  if (!chrome.mimeHandler) return;

  if (supportsBufferedPdfFallback()) {
    const stored = await chrome.storage.local.get(disabledForCompatibility);
    if (stored[disabledForCompatibility] === true) {
      await chrome.mimeHandler.setMimeHandlerOptions(pdfMime, {
        enabled: true,
      });
      await chrome.storage.local.remove(disabledForCompatibility);
    }
    return;
  }

  const options = await chrome.mimeHandler.getMimeHandlerOptions(pdfMime);
  if (!options.enabled) return;
  // Record ownership before disabling. If Chrome interrupts the worker,
  // either operation can be repeated on the next startup.
  await chrome.storage.local.set({ [disabledForCompatibility]: true });
  await chrome.mimeHandler.setMimeHandlerOptions(pdfMime, { enabled: false });
}
