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

function decodeName(name: string): string {
  try {
    return decodeURIComponent(name).trim();
  } catch {
    // Servers sometimes send a literal percent sign in an unencoded filename.
    return name.trim();
  }
}

export function pdfName(url: string, disposition = ''): string {
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(disposition)?.[1];
  const plain = /filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;]+)/i.exec(
    disposition,
  );
  const provided = decodeName(encoded ?? plain?.[1] ?? plain?.[2] ?? '');
  const name =
    provided || decodeName(new URL(url).pathname.split('/').pop() ?? '');
  const hasSuffix = name.toLowerCase().endsWith('.pdf');
  const stem = hasSuffix ? name.slice(0, -4) : name;
  if (!stem || (!provided && !hasSuffix)) return 'Dokument.pdf';
  const suffix = hasSuffix ? name.slice(-4) : '.pdf';
  const safeStem = stem
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '_')
    .slice(0, 180 - suffix.length);
  return safeStem + suffix;
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
