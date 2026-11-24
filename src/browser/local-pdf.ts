const directory = 'paperless-pdf';
const documentIdPattern =
  /^(?:[\da-f]{32}|[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})$/i;

function prefix(): string {
  // Chromium exposes its origin-private filesystem at this URL to its
  // native PDF viewer and downloader, including after the creator closes.
  return `filesystem:${chrome.runtime.getURL(`temporary/${directory}/`)}`;
}

export function localPdfUrl(documentId: string, name: string): string {
  if (!documentIdPattern.test(documentId))
    throw new Error('Invalid PDF document ID');
  return `${prefix()}${documentId}/${encodeURIComponent(name)}`;
}

export function isLocalPdfViewer(url: string): boolean {
  const base = prefix();
  if (!url.startsWith(base)) return false;
  const [id, name, extra] = url.slice(base.length).split('#')[0]!.split('/');
  return (
    id !== undefined &&
    documentIdPattern.test(id) &&
    name !== undefined &&
    /^[^?]+\.pdf$/i.test(name) &&
    extra === undefined
  );
}

export async function writeLocalPdf(
  documentId: string,
  name: string,
  file: Blob,
): Promise<string> {
  const url = localPdfUrl(documentId, name);
  const files = await viewerDirectory(true);
  const doc = await files.getDirectoryHandle(documentId, { create: true });
  const entry = await doc.getFileHandle(name, { create: true });
  await file.stream().pipeTo(await entry.createWritable());
  return url;
}

async function viewerDirectory(
  create = false,
): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(directory, { create });
}

function ignoreMissing(error: unknown): undefined {
  if (!(error instanceof DOMException && error.name === 'NotFoundError'))
    throw error;
}

export async function listLocalPdfIds(): Promise<string[]> {
  const files = await viewerDirectory().catch(ignoreMissing);
  const ids: string[] = [];
  if (files) {
    for await (const entry of files.values()) {
      if (entry.kind === 'directory' && documentIdPattern.test(entry.name))
        ids.push(entry.name);
    }
  }
  return ids;
}

export async function deleteLocalPdf(documentId: string): Promise<void> {
  if (!documentIdPattern.test(documentId)) return;
  const files = await viewerDirectory().catch(ignoreMissing);
  await files
    ?.removeEntry(documentId, { recursive: true })
    .catch(ignoreMissing);
}
