import { capturedSources, deleteCaptures } from '../data/sources.js';
import type { SourceInfo } from '../shared/model.js';
import { documentSource } from '../shared/pdf.js';
import { hostPermission } from '../shared/settings.js';
import { isLocalPdfViewer } from './local-pdf.js';

const nativeViewer =
  'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html';
const storageKey = 'pdfViewers';

interface Viewer {
  tabId: number;
  frameId: number;
  captureId: string;
  originalDocumentId: string;
  nativeDocumentId?: string;
}

// Chrome replaces the PDF embedder document during fallback. Its frame ID
// stays the same; the new native viewer identifies the replacement document.
// Session storage survives worker suspension but expires with the browser.
let viewers: Viewer[] | undefined;
let previous: Promise<unknown> = Promise.resolve();

function withViewers<T>(
  operation: (current: Viewer[]) => Promise<T>,
): Promise<T> {
  const result = previous.then(async () => {
    viewers ??=
      ((await chrome.storage.session.get(storageKey))[storageKey] as
        Viewer[] | undefined) ?? [];
    return operation(viewers);
  });
  previous = result.catch(() => undefined);
  return result;
}

function persist(current: Viewer[]): Promise<void> {
  return chrome.storage.session.set({ [storageKey]: current });
}

export function listenForPdfViewers(): void {
  const captureUrl = chrome.runtime.getURL('capture.html');
  chrome.webNavigation.onCommitted.addListener(
    (event) => {
      const owner = event.parentDocumentId;
      if (!owner || event.parentFrameId < 0) return;
      void withViewers(async (current) => {
        const index = current.findIndex(
          (entry) =>
            entry.tabId === event.tabId &&
            entry.frameId === event.parentFrameId,
        );
        if (event.url === captureUrl) {
          const viewer: Viewer = {
            tabId: event.tabId,
            frameId: event.parentFrameId,
            captureId: event.documentId,
            originalDocumentId: owner,
          };
          if (index < 0) current.push(viewer);
          else current[index] = viewer;
        } else {
          const viewer = current[index];
          if (
            !viewer ||
            viewer.nativeDocumentId ||
            viewer.originalDocumentId === owner
          )
            return;
          viewer.nativeDocumentId = owner;
        }
        await persist(current);
      });
    },
    { url: [{ urlEquals: captureUrl }, { urlEquals: nativeViewer }] },
  );
}

export function forgetPdfViewers(tabId: number): Promise<void> {
  return withViewers(async (current) => {
    await sweepCaptures(current, tabId, true);
  });
}

async function inspectOwner(viewer: Viewer) {
  const [frame] = await chrome.scripting
    .executeScript({
      target: { tabId: viewer.tabId, frameIds: [viewer.frameId] },
      injectImmediately: true,
      func: () => ({ url: document.URL, type: document.contentType }),
    })
    .catch(() => []); // The frame can disappear or lack a host grant.
  return frame?.result && { documentId: frame.documentId, ...frame.result };
}

async function originalView(
  source: SourceInfo,
  viewer: Viewer | undefined,
): Promise<SourceInfo | 'inaccessible' | undefined> {
  if (!viewer) return undefined;
  const navigation = await chrome.webNavigation
    .getFrame({
      tabId: viewer.tabId,
      frameId: viewer.frameId,
    })
    .catch(() => null); // The tab may already have closed.
  // webNavigation reports blob frame commits but omits them from lookups.
  const hiddenBlob = !navigation && source.url.startsWith('blob:');
  const inspection = hiddenBlob ? await inspectOwner(viewer) : undefined;
  if (hiddenBlob && !inspection) {
    const origin = new URL(source.url).origin;
    if (
      !/^https?:/.test(origin) ||
      !(await chrome.permissions.contains({
        origins: [hostPermission(origin)],
      }))
    )
      return 'inaccessible'; // Recheck after the user grants host access.
  }
  const frame = navigation ?? inspection;
  if (!frame || documentSource(frame.url) !== source.url) return undefined;
  if (frame.documentId === viewer.nativeDocumentId) return source;
  if (viewer.nativeDocumentId) return undefined;
  // The native child commits after the parent load completes. An interrupted
  // handoff can instead navigate to HTML at the same URL.
  const inspected = inspection ?? (await inspectOwner(viewer));
  if (
    !inspected ||
    (inspected.documentId === frame.documentId &&
      inspected.type === 'application/pdf')
  )
    return { ...source, availability: 'loading' };
  return undefined;
}

async function sweepCaptures(
  current: Viewer[],
  tabId?: number,
  tabClosed = false,
): Promise<SourceInfo[]> {
  // A native tab can outlive its portal. Its ID is different from the tab ID
  // in IndexedDB, so even a scoped sweep must include shared local viewer files.
  const captures = (await capturedSources()).filter(
    (source) =>
      tabId === undefined || source.tabId === tabId || source.viewerUrl,
  );
  const contexts = captures.length
    ? await chrome.runtime.getContexts({
        documentUrls: [chrome.runtime.getURL('capture.html')],
      })
    : [];
  const liveIds = new Set(contexts.map((context) => context.documentId));
  const liveTabs = new Set(contexts.map((context) => context.tabId));
  const owners = await Promise.all(
    captures.map((source) => {
      if (tabClosed && source.tabId === tabId) return undefined;
      if (
        source.documentId
          ? liveIds.has(source.documentId)
          : liveTabs.has(source.tabId)
      )
        return source;
      return originalView(
        source,
        current.find((entry) => entry.captureId === source.documentId),
      );
    }),
  );

  // Snapshot tabs after the original owners. A handler can open the native tab
  // and close itself during a sweep; the new view now holds the same file.
  const shared = captures.some((source) => source.viewerUrl);
  const tabs = shared ? await chrome.tabs.query({}) : [];
  const byTab = new Map<number, SourceInfo | undefined>();
  const closed: SourceInfo[] = [];
  function offer(source: SourceInfo) {
    byTab.set(source.tabId, byTab.has(source.tabId) ? undefined : source);
  }
  for (const [index, source] of captures.entries()) {
    let owner = owners[index];
    let sharedView = false;
    if (source.viewerUrl && isLocalPdfViewer(source.viewerUrl)) {
      for (const tab of tabs) {
        if (tab.id === undefined || (tabClosed && tab.id === tabId)) continue;
        const displaying = tab.url?.split('#')[0] === source.viewerUrl;
        const opening = tab.pendingUrl?.split('#')[0] === source.viewerUrl;
        if (!displaying && !opening) continue;
        sharedView = true;
        if (tab.id === source.tabId) owner = undefined;
        offer({
          ...source,
          tabId: tab.id,
          embedded: false,
          availability: displaying ? source.availability : 'loading',
        });
      }
    }
    if (owner && owner !== 'inaccessible') offer(owner);
    if (!owner && !sharedView) closed.push(source);
  }
  await deleteCaptures(closed);
  const closedIds = new Set(closed.map((source) => source.documentId));
  const retained = current.filter(
    (entry) =>
      !(tabClosed && entry.tabId === tabId) && !closedIds.has(entry.captureId),
  );
  if (retained.length !== current.length) {
    viewers = retained;
    await persist(retained);
  }
  return [...byTab.values()].filter(
    (source): source is SourceInfo =>
      !!source && (tabId === undefined || source.tabId === tabId),
  );
}

export function liveCaptures(tabId?: number): Promise<SourceInfo[]> {
  return withViewers((current) => sweepCaptures(current, tabId));
}
