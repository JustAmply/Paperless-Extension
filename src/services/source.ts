import { MAX_PDF_BYTES, UserError } from '../shared/model.js';
import {
  hasPdfSignature,
  knownPdfName,
  pdfFingerprint,
  pdfName,
} from '../shared/pdf.js';

const manualUpload =
  'Lade die PDF aus dem geöffneten PDF-Viewer herunter und wähle sie hier aus oder ziehe sie hinein.';

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
      `Die PDF lässt sich nicht erneut abrufen. ${manualUpload}`,
    );
  }
  if (!response.ok) {
    const reason =
      response.status === 404 || response.status === 410
        ? 'Die ursprüngliche PDF-Adresse ist nicht mehr verfügbar. Der Link kann abgelaufen oder nur einmal gültig sein.'
        : response.status === 401 || response.status === 403
          ? 'Die Website verweigert den Zugriff auf die PDF. Möglicherweise ist die Anmeldung abgelaufen.'
          : 'Die Website konnte die PDF nicht liefern.';
    throw new UserError(
      `${reason} (HTTP ${response.status}) Es wurde nichts an Paperless gesendet. ${manualUpload}`,
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
          'Die PDF ist zu groß. Pro Datei sind bis zu 50 MiB möglich.',
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
    const sourceUrl = response.url || url;
    const disposition = response.headers.get('content-disposition') ?? '';
    const name = knownPdfName(sourceUrl, disposition) ?? knownPdfName(url);
    return {
      file,
      name: name ?? pdfName(sourceUrl, '', await pdfFingerprint(file)),
    };
  } catch (error) {
    if (error instanceof UserError) throw error;
    throw new UserError(
      `Der Abruf der PDF wurde unterbrochen. ${manualUpload}`,
    );
  } finally {
    // An errored stream also rejects cancellation; preserve the read error above.
    await reader.cancel().catch(() => undefined);
  }
}
