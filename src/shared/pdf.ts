import { MAX_PDF_BYTES, UserError } from './model.js';

export function hasPdfSignature(bytes: Uint8Array): boolean {
  const header = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  return /%PDF-\d\.\d/.test(header);
}

export async function validatePdf(file: Blob): Promise<void> {
  if (file.size > MAX_PDF_BYTES) {
    throw new UserError(
      'Die PDF ist zu groß. Pro Datei sind bis zu 50 MB möglich.',
    );
  }
  if (
    !hasPdfSignature(new Uint8Array(await file.slice(0, 1024).arrayBuffer()))
  ) {
    throw new UserError(
      'Diese Datei ist keine PDF. Bitte wähle eine PDF-Datei aus.',
    );
  }
}

export function pdfName(url: string, disposition = ''): string {
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(disposition)?.[1];
  const plain = /filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;]+)/i.exec(
    disposition,
  );
  let name =
    encoded ??
    plain?.[1] ??
    plain?.[2] ??
    new URL(url).pathname.split('/').pop() ??
    '';
  try {
    name = decodeURIComponent(name.trim());
  } catch {
    // Servers sometimes send a literal percent sign in an unencoded filename.
  }
  name = name.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '_').slice(0, 180);
  return name.toLowerCase().endsWith('.pdf') ? name : 'Dokument.pdf';
}

export function readableSource(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (!['https:', 'http:', 'file:'].includes(parsed.protocol))
      return undefined;
    parsed.hash = '';
    return parsed.href;
  } catch {
    return undefined;
  }
}
