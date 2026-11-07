import { enqueue } from './data/jobs.js';
import { request } from './shared/messaging.js';
import {
  errorMessage,
  isActive,
  sourceKey,
  UserError,
  type Source,
  type SourceInfo,
  type State,
} from './shared/model.js';
import { readableSource } from './shared/pdf.js';
import { normalizeServer } from './shared/settings.js';
import {
  canAccessFileTabs,
  isPdfTab,
  windowSources,
} from './browser/pdf-tabs.js';
import { canDismissJob, hasImportWork } from './shared/job-state.js';

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element: ${id}`);
  return node as T;
}

const ui = {
  settings: element('settings-panel'),
  upload: element('upload-panel'),
  toggle: element<HTMLButtonElement>('settings-toggle'),
  form: element<HTMLFormElement>('settings-form'),
  url: element<HTMLInputElement>('server-url'),
  token: element<HTMLInputElement>('api-token'),
  save: element<HTMLButtonElement>('save-settings'),
  settingsStatus: element('settings-status'),
  httpWarning: element('http-warning'),
  tokenHelp: element('token-help'),
  send: element<HTMLButtonElement>('send-current'),
  currentStatus: element('current-status'),
  fileAccess: element<HTMLButtonElement>('file-access'),
  drop: element<HTMLButtonElement>('drop-zone'),
  sendWindow: element<HTMLButtonElement>('send-window'),
  input: element<HTMLInputElement>('file-input'),
  status: element('upload-status'),
  jobs: element('job-list'),
  summary: element('batch-summary'),
  dismiss: element<HTMLButtonElement>('dismiss-results'),
  webAccess: element('web-access-note'),
  fatal: element('fatal-error'),
};

let currentState: State;
let currentTab: chrome.tabs.Tab | undefined;
let activeSource: Source | undefined;
let inspectedPdf = false;
let localFileAccess = false;
let staged = false;
let polling = false;
let uploadError = '';
let uploadNotice = '';
let windowTabs: Source[] = [];
let renderedJobs = '';
const webOrigins = ['https://*/*', 'http://*/*'];
let allWebAccess = false;

function hasFileTabs(): boolean {
  return windowTabs.some((source) => source.url.startsWith('file:'));
}

async function updateWindowTabs(windowId: number): Promise<void> {
  windowTabs = await windowSources(windowId);
  localFileAccess = hasFileTabs() && (await canAccessFileTabs());
}

async function updateWebAccess(): Promise<void> {
  allWebAccess = await chrome.permissions.contains({ origins: webOrigins });
  ui.webAccess.hidden = allWebAccess;
}

function selectedSource(state: State): Source | SourceInfo | undefined {
  const source = activeSource;
  if (!source) return undefined;
  return (
    state.sources.find(
      (pdf) => pdf.tabId === source.tabId && pdf.url === source.url,
    ) ?? (inspectedPdf ? source : undefined)
  );
}

function showSettings(open: boolean): void {
  ui.settings.hidden = !open;
  ui.upload.hidden = open;
  ui.toggle.setAttribute('aria-expanded', String(open));
  if (open) ui.url.focus();
}

function render(state: State): void {
  currentState = state;
  const active = state.jobs.some(isActive) || staged;
  ui.toggle.hidden = !state.settings.configured;
  ui.drop.disabled = active;
  ui.sendWindow.disabled = active || !windowTabs.length;
  ui.toggle.disabled = active;
  const currentSource = selectedSource(state);
  const captured =
    currentSource && 'availability' in currentSource
      ? currentSource
      : undefined;
  const isLocal = activeSource?.url.startsWith('file:');
  ui.send.hidden = !currentSource;
  ui.fileAccess.hidden = !hasFileTabs() || localFileAccess;
  ui.currentStatus.textContent =
    captured?.error ??
    (captured?.availability === 'loading' ? 'PDF wird geladen …' : '');
  ui.currentStatus.hidden = !ui.currentStatus.textContent;
  ui.currentStatus.classList.toggle(
    'error',
    captured?.availability === 'unavailable',
  );
  const sourceJob = state.jobs.find(
    (job) =>
      currentSource &&
      job.source &&
      sourceKey(job.source) === sourceKey(currentSource),
  );
  ui.send.disabled =
    active ||
    !state.settings.configured ||
    !currentSource ||
    (captured !== undefined && captured.availability !== 'ready') ||
    (isLocal && !localFileAccess) ||
    (sourceJob !== undefined &&
      ['accepted', 'uncertain'].includes(sourceJob.status));
  ui.send.textContent =
    sourceJob?.status === 'accepted'
      ? 'Bereits an Paperless übertragen'
      : sourceJob?.status === 'uncertain'
        ? 'Übertragung unbestätigt'
        : 'Aktuelle PDF hochladen';
  const completed = state.jobs.filter((job) => !isActive(job)).length;
  const visibleJobs = state.jobs.filter((job) => !job.dismissed);
  ui.summary.hidden = !visibleJobs.length;
  ui.summary.textContent = active
    ? `${completed} von ${state.jobs.length} abgeschlossen`
    : 'Letzte Übertragung';
  ui.dismiss.hidden =
    !uploadError && !uploadNotice && !state.jobs.some(canDismissJob);
  ui.dismiss.disabled = active;
  const jobsKey = JSON.stringify([visibleJobs, state.settings.url]);
  if (jobsKey !== renderedJobs) {
    renderedJobs = jobsKey;
    ui.jobs.replaceChildren();
    for (const job of visibleJobs) {
      const row = document.createElement('li');
      row.dataset['status'] = job.status;
      const indicator = document.createElement('span');
      indicator.className = 'job-indicator';
      indicator.textContent =
        job.status === 'accepted'
          ? hasImportWork(job)
            ? '↥'
            : job.importTask?.result?.status === 'failure'
              ? '!'
              : job.importTask?.result?.status === 'unavailable'
                ? '?'
                : '✓'
          : isActive(job)
            ? '↥'
            : job.status === 'skipped'
              ? '–'
              : '!';
      const name = document.createElement('span');
      name.className = 'job-name';
      name.textContent = job.name;
      name.title = job.name;
      const message = document.createElement('span');
      message.className = 'job-message';
      message.textContent = job.message;
      row.append(indicator, name, message);
      if (job.importTask?.result?.status === 'failure')
        indicator.classList.add('error');
      if (job.importTask) {
        const result = job.importTask.result;
        const detail = document.createElement('span');
        detail.className = 'import-result';
        detail.textContent =
          result?.message ?? 'Import wird automatisch geprüft …';
        if (result) detail.dataset['importStatus'] = result.status;
        row.append(detail);
        if (result?.documentId) {
          const link = document.createElement('a');
          link.className = 'document-link';
          link.href = new URL(
            `documents/${result.documentId}/details`,
            job.importTask.serverUrl,
          ).href;
          link.textContent =
            result.status === 'duplicate'
              ? 'Vorhandenes Dokument öffnen ↗'
              : 'Dokument öffnen ↗';
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          row.append(link);
        } else if (job.importTask.serverUrl !== state.settings.url) {
          detail.textContent =
            'Importstatus gehört zu einem anderen Paperless-Server.';
        }
      }
      ui.jobs.append(row);
    }
  }
  ui.status.classList.toggle('error', Boolean(uploadError));
  ui.status.textContent =
    uploadError ||
    uploadNotice ||
    (staged
      ? 'Vorbereitung … Fenster kurz geöffnet lassen.'
      : active
        ? 'Du kannst dieses Fenster schließen.'
        : '');
}

function showUploadError(error: unknown): void {
  uploadNotice = '';
  uploadError = errorMessage(error);
  ui.status.textContent = uploadError;
  ui.status.classList.add('error');
  ui.dismiss.hidden = false;
}

async function refresh(): Promise<void> {
  const result = await request({ target: 'background', type: 'state' });
  if (result.state) render(result.state);
}

async function start(input: File[] | Source): Promise<void> {
  if (staged || currentState.jobs.some(isActive)) return;
  uploadError = '';
  uploadNotice = '';
  staged = true;
  render(currentState);
  try {
    await enqueue(input);
    await request({ target: 'background', type: 'process' });
  } catch (error) {
    staged = false;
    await refresh();
    showUploadError(error);
    return;
  }
  staged = false;
  await refresh();
}

function updateTokenField(): void {
  const savedUrl = currentState.settings.url;
  let sameServer = false;
  if (savedUrl) {
    try {
      sameServer = normalizeServer(ui.url.value) === savedUrl;
    } catch {
      // An incomplete address cannot reuse the saved token.
    }
  }
  ui.token.required = !sameServer;
  ui.token.placeholder = sameServer
    ? 'Gespeicherten Token beibehalten'
    : 'Dein API-Token';
  ui.tokenHelp.textContent = sameServer
    ? 'Leer lassen, um den gespeicherten Token zu behalten.'
    : savedUrl
      ? 'Gib für die neue Paperless-Adresse einen API-Token ein.'
      : 'In Paperless unter „Mein Profil“ → „API-Token“.';
}

ui.form.addEventListener('submit', (event) => {
  event.preventDefault();
  const token = ui.token.value;
  let url: string;
  let permission: Promise<boolean>;
  try {
    url = normalizeServer(ui.url.value);
    // Chrome requires the permission request in the original user gesture.
    permission = allWebAccess
      ? Promise.resolve(true)
      : chrome.permissions.request({ origins: webOrigins });
  } catch (error) {
    ui.settingsStatus.textContent = errorMessage(error);
    ui.settingsStatus.classList.add('error');
    return;
  }
  ui.save.disabled = true;
  ui.settingsStatus.classList.remove('error');
  ui.settingsStatus.textContent = 'Verbindung wird geprüft …';
  void (async () => {
    try {
      if (!(await permission))
        throw new UserError(
          'Der Webseitenzugriff wurde nicht erlaubt. Bitte bestätige die Freigabe in Chrome.',
        );
      const result = await request({
        target: 'background',
        type: 'save',
        url,
        token,
      });
      await updateWebAccess();
      ui.token.value = '';
      if (result.state) render(result.state);
      ui.settingsStatus.textContent = '';
      ui.save.textContent = 'Verbindung speichern';
      updateTokenField();
      showSettings(false);
    } catch (error) {
      ui.settingsStatus.textContent = errorMessage(error);
      ui.settingsStatus.classList.add('error');
    } finally {
      ui.save.disabled = false;
    }
  })();
});

ui.url.addEventListener('input', () => {
  ui.httpWarning.hidden = !ui.url.value.trim().startsWith('http://');
  updateTokenField();
});
ui.toggle.addEventListener('click', () =>
  showSettings(ui.settings.hidden === true),
);
ui.drop.addEventListener('click', () => ui.input.click());
ui.dismiss.addEventListener('click', () => {
  if (staged || currentState.jobs.some(isActive)) return;
  void (async () => {
    const result = await request({
      target: 'background',
      type: 'dismiss-results',
    });
    uploadError = '';
    uploadNotice = '';
    if (result.state) render(result.state);
  })().catch(showUploadError);
});
ui.sendWindow.addEventListener('click', () => {
  if (staged || currentState.jobs.some(isActive) || !currentTab) return;
  const windowId = currentTab.windowId;
  // Request broad web access once, directly inside the click gesture.
  const permission = allWebAccess
    ? Promise.resolve(true)
    : chrome.permissions.request({ origins: webOrigins });
  uploadError = '';
  uploadNotice = '';
  staged = true;
  render(currentState);
  void (async () => {
    try {
      if (!(await permission))
        throw new UserError(
          'Der Zugriff auf die PDF-Tabs wurde nicht erlaubt.',
        );
      const response = await request({
        target: 'background',
        type: 'upload-window',
        windowId,
      });
      await updateWebAccess();
      uploadNotice = response.message ?? '';
    } catch (error) {
      showUploadError(error);
    } finally {
      staged = false;
      await updateWindowTabs(windowId);
      await refresh();
    }
  })().catch(showUploadError);
});
ui.input.addEventListener('change', () => {
  const files = Array.from(ui.input.files ?? []);
  ui.input.value = '';
  if (files.length) void start(files).catch(showUploadError);
});
for (const type of ['dragenter', 'dragover']) {
  ui.drop.addEventListener(type, (event) => {
    event.preventDefault();
    if (!ui.drop.disabled) ui.drop.classList.add('dragging');
  });
}
ui.drop.addEventListener('dragleave', () =>
  ui.drop.classList.remove('dragging'),
);
document.addEventListener('dragover', (event) => event.preventDefault());
document.addEventListener('drop', (event) => event.preventDefault());
ui.drop.addEventListener('drop', (event) => {
  event.preventDefault();
  ui.drop.classList.remove('dragging');
  const files = Array.from(event.dataTransfer?.files ?? []);
  if (files.length) void start(files).catch(showUploadError);
});
ui.send.addEventListener('click', () => {
  const source = selectedSource(currentState);
  if (!ui.send.disabled && source) void start(source).catch(showUploadError);
});
ui.fileAccess.addEventListener('click', () => {
  void chrome.permissions
    .request({ origins: ['file:///*'] })
    .then(async (granted) => {
      if (!granted)
        throw new UserError('Der Zugriff auf lokale PDFs wurde nicht erlaubt.');
      if (!(await chrome.extension.isAllowedFileSchemeAccess())) {
        throw new UserError(
          'Aktiviere unter chrome://extensions → Paperless Upload → Details den „Zugriff auf Datei-URLs“. Alternativ kannst du die PDF hier hineinziehen.',
        );
      }
      localFileAccess = true;
      await updateCurrentPdf();
    })
    .catch(showUploadError);
});

async function updateCurrentPdf(): Promise<void> {
  if (
    activeSource &&
    (!activeSource.url.startsWith('file:') || localFileAccess) &&
    !selectedSource(currentState)
  ) {
    inspectedPdf = await isPdfTab(activeSource);
  }
  render(currentState);
}

async function initialize(): Promise<void> {
  [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = readableSource(currentTab?.url);
  if (url && currentTab?.id !== undefined)
    activeSource = { url, tabId: currentTab.id };
  if (currentTab) await updateWindowTabs(currentTab.windowId);
  await updateWebAccess();
  await refresh();
  await updateCurrentPdf();
  ui.url.value = currentState.settings.url;
  ui.httpWarning.hidden = !ui.url.value.startsWith('http://');
  updateTokenField();
  if (currentState.settings.configured)
    ui.save.textContent = 'Verbindung speichern';
  showSettings(!currentState.settings.configured);
  if (currentState.jobs.some((job) => isActive(job) || hasImportWork(job)))
    await request({ target: 'background', type: 'process' });
  window.setInterval(() => {
    if (polling || staged) return;
    polling = true;
    void refresh()
      .catch(showUploadError)
      .finally(() => {
        polling = false;
      });
  }, 500);
}

chrome.permissions.onAdded.addListener(() => {
  void updateWebAccess().catch(showUploadError);
});
chrome.permissions.onRemoved.addListener(() => {
  void updateWebAccess().catch(showUploadError);
});

void initialize().catch((error: unknown) => {
  ui.fatal.textContent = errorMessage(error);
  ui.fatal.hidden = false;
});
