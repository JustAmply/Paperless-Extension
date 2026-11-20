import { message } from '../shared/i18n.js';
import { MAX_PDF_BYTES, UserError } from '../shared/model.js';
import {
  hasPdfSignature,
  knownPdfName,
  pdfFingerprint,
  pdfName,
} from '../shared/pdf.js';

export async function downloadPdf(
  url: string,
): Promise<{ file: Blob; name: string } | undefined> {
  let response: Response;
  try {
    response = await fetch(url, {
      credentials: 'include',
      cache: 'no-store',
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new UserError(message('sourceFetchFailed'));
  }
  if (!response.ok) {
    const reason =
      response.status === 404 || response.status === 410
        ? 'sourceExpired'
        : response.status === 401 || response.status === 403
          ? 'sourceDenied'
          : 'sourceHttpError';
    throw new UserError(message(reason, String(response.status)));
  }
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  let verified = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_PDF_BYTES) throw new UserError(message('pdfTooLarge'));
      chunks.push(value);
      if (!verified) {
        if (size >= 1024) {
          const prefix = new Uint8Array(Math.min(size, 1024));
          let offset = 0;
          for (const chunk of chunks) {
            const part = chunk.subarray(0, prefix.length - offset);
            prefix.set(part, offset);
            offset += part.length;
            if (offset === prefix.length) break;
          }
          if (!hasPdfSignature(prefix)) return undefined;
          verified = true;
        }
      }
    }
    const file = new Blob(chunks, { type: 'application/pdf' });
    if (!verified && !hasPdfSignature(new Uint8Array(await file.arrayBuffer())))
      return undefined;
    const sourceUrl = response.url || url;
    const disposition = response.headers.get('content-disposition') ?? '';
    const name = knownPdfName(sourceUrl, disposition) ?? knownPdfName(url);
    return {
      file,
      name: name ?? pdfName(sourceUrl, '', await pdfFingerprint(file)),
    };
  } catch (error) {
    if (error instanceof UserError) throw error;
    throw new UserError(message('sourceInterrupted'));
  } finally {
    // An errored stream also rejects cancellation; preserve the read error above.
    await reader.cancel().catch(() => undefined);
  }
}
