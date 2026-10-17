import { MAX_PDF_BYTES, UserError } from '../shared/model.js';
import { hasPdfSignature, pdfName } from '../shared/pdf.js';

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
    throw new UserError(
      'Die PDF lässt sich nicht erneut abrufen. Lade sie herunter und ziehe sie hier hinein.',
    );
  }
  if (!response.ok) {
    throw new UserError(
      `Die PDF konnte nicht geladen werden (HTTP ${response.status}). Lade sie herunter und ziehe sie hier hinein.`,
    );
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
      if (size > MAX_PDF_BYTES)
        throw new UserError(
          'Die PDF ist zu groß. Pro Datei sind bis zu 50 MB möglich.',
        );
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
    return {
      file,
      name: pdfName(url, response.headers.get('content-disposition') ?? ''),
    };
  } finally {
    await reader.cancel();
  }
}
