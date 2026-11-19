import { MAX_PDF_BYTES, UserError } from './model.js';

export function hasPdfSignature(bytes: Uint8Array): boolean {
  const header = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  return /%PDF-\d\.\d/.test(header);
}

export async function validatePdf(file: Blob): Promise<void> {
  if (file.size > MAX_PDF_BYTES) {
    throw new UserError(
      'Die PDF ist zu groß. Pro Datei sind bis zu 50 MiB möglich.',
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

export async function pdfFingerprint(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    await file.arrayBuffer(),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

export function knownPdfName(
  url: string,
  disposition = '',
): string | undefined {
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(disposition)?.[1];
  const plain = /filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;]+)/i.exec(
    disposition,
  );
  const provided = decodeName(encoded ?? plain?.[1] ?? plain?.[2] ?? '');
  const parsed = new URL(url);
  const basename = decodeName(parsed.pathname.split('/').pop() ?? '');
  const queryName = (
    parsed.searchParams.get('filename') ??
    parsed.searchParams.get('fileName') ??
    ''
  ).trim();
  const name =
    provided ||
    (basename.toLowerCase().endsWith('.pdf') ? basename : '') ||
    (!/[/\\]/.test(queryName) && queryName.toLowerCase().endsWith('.pdf')
      ? queryName
      : '');
  const hasSuffix = name.toLowerCase().endsWith('.pdf');
  const stem = hasSuffix ? name.slice(0, -4) : name;
  if (!stem) return undefined;
  const suffix = hasSuffix ? name.slice(-4) : '.pdf';
  const safeStem = stem
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '_')
    .slice(0, 180 - suffix.length);
  return safeStem + suffix;
}

export function pdfName(
  url: string,
  disposition = '',
  fingerprint?: string,
): string {
  const name = knownPdfName(url, disposition);
  if (name) return name;
  if (!fingerprint) return 'Dokument.pdf';
  const { origin } = new URL(url);
  const host = origin === 'null' ? '' : new URL(origin).hostname;
  const label = host
    ? `PDF von ${host.replace(/:/g, '_').slice(0, 150)}`
    : 'PDF';
  return `${label} – ${fingerprint.slice(0, 8)}.pdf`;
}

export function readableSource(url: string | undefined): string | undefined {
  const source = documentSource(url);
  return source?.startsWith('blob:') ? undefined : source;
}

// Blob URLs identify captured documents, but are not download targets.
export function documentSource(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (!['https:', 'http:', 'file:', 'blob:'].includes(parsed.protocol))
      return undefined;
    parsed.hash = '';
    return parsed.href;
  } catch {
    return undefined;
  }
}
