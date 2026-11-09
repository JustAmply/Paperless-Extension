import { enqueue } from './data/jobs.js';
import { request } from './shared/messaging.js';
import {
  errorMessage,
  isActive,
  sourceKey,
  UserError,
  type Job,
  type Source,
  type SourceInfo,
  type State,
} from './shared/model.js';
import { documentSource } from './shared/pdf.js';
import { normalizeServer } from './shared/settings.js';
import {
  canAccessFileTabs,
  isPdfTab,
  windowSources,
} from './browser/pdf-tabs.js';
import {
  canDismissJob,
  canRetryImport,
  DEFAULT_SUCCESS_DISPLAY_SECONDS,
  hasImportWork,
  isPreviousUpload,
  isJobVisible,
  successDisplaySeconds,
} from './shared/job-state.js';

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element: ${id}`);
  return node as T;
}

const ui = {
  settings: element('settings-panel'),
  settingsTitle: element('settings-title'),
  setupHint: element('setup-hint'),
  connectionTitle: element('connection-title'),
  upload: element('upload-panel'),
  toggle: element<HTMLButtonElement>('settings-toggle'),
  form: element<HTMLFormElement>('settings-form'),
  url: element<HTMLInputElement>('server-url'),
  token: element<HTMLInputElement>('api-token'),
  save: element<HTMLButtonElement>('save-settings'),
  settingsStatus: element('settings-status'),
  displaySettings: element('display-settings'),
  displayDuration: element<HTMLSelectElement>('success-display'),
  displayStatus: element('display-status'),
  httpWarning: element('http-warning'),
  tokenHelp: element('token-help'),
  send: element<HTMLButtonElement>('send-current'),
  sendLabel: element('send-current-label'),
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
  connectionAccess: element('connection-access-note'),
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
let displaySeconds: number = DEFAULT_SUCCESS_DISPLAY_SECONDS;
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
  ui.connectionAccess.hidden = allWebAccess;
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
  if (open) {
    const firstField = currentState.settings.configured
      ? ui.displayDuration
      : ui.url;
    firstField.focus();
  }
}

const icons = {
  check: 'm5 12 4 4L19 6',
  clock: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  upload: 'M12 16V4m-5 5 5-5 5 5M5 16v4h14v-4',
  warning:
    'M12 8v5m0 3v.1M10.4 4.8 3 18a1 1 0 0 0 .9 1.5h16.2A1 1 0 0 0 21 18L13.6 4.8a1.8 1.8 0 0 0-3.2 0Z',
  open: 'M13 5h6v6m0-6-8 8m6 1v5H5V7h5',
  retry: 'M20 4v6h-6m6 0a8 8 0 1 0 0 5',
} as const;

function icon(name: keyof typeof icons): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', icons[name]);
  svg.append(path);
  return svg;
}

function jobPresentation(
  job: Job,
  serverUrl: string,
): {
  symbol: keyof typeof icons;
  tone: 'progress' | 'success' | 'warning';
  label: string;
} {
  if (job.status === 'accepted') {
    const result = job.importTask?.result;
    if (result?.status === 'success')
      return { symbol: 'check', tone: 'success', label: 'Importiert' };
    if (result?.status === 'duplicate')
      return { symbol: 'check', tone: 'success', label: 'Bereits vorhanden' };
    if (job.importTask && job.importTask.serverUrl !== serverUrl)
      return {
        symbol: 'warning',
        tone: 'warning',
        label: 'Import gehört zu einem anderen Paperless-Server.',
      };
    if (result?.status === 'failure' || result?.status === 'unavailable')
      return { symbol: 'warning', tone: 'warning', label: result.message };
    if (job.importTask)
      return { symbol: 'clock', tone: 'progress', label: 'Wird importiert …' };
    return { symbol: 'check', tone: 'success', label: 'Übertragen' };
  }
  if (isActive(job)) {
    const label =
      job.status === 'queued'
        ? 'Wartet'
        : job.status === 'downloading'
          ? 'Wird geladen …'
          : 'Wird hochgeladen …';
    return {
      symbol: job.status === 'uploading' ? 'upload' : 'clock',
      tone: 'progress',
      label,
    };
  }
  return { symbol: 'warning', tone: 'warning', label: job.message };
}

function renderJob(job: Job, serverUrl: string): HTMLLIElement {
  const row = document.createElement('li');
  row.dataset['status'] = job.status;
  row.dataset['jobId'] = job.id;
  const { symbol, tone, label } = jobPresentation(job, serverUrl);
  row.dataset['tone'] = tone;
  const indicator = document.createElement('span');
  indicator.className = 'job-indicator';
  indicator.append(icon(symbol));
  const name = document.createElement('span');
  name.className = 'job-name';
  name.textContent = job.name;
  name.title = job.name;
  const message = document.createElement('span');
  message.className = 'job-message';
  message.textContent = label;
  const task = job.importTask;
  const result = task?.result;
  if (result) message.dataset['importStatus'] = result.status;
  row.append(indicator, name, message);
  if (task && result?.documentId) {
    const link = document.createElement('a');
    link.className = 'document-link';
    link.href = new URL(
      `documents/${result.documentId}/details`,
      task.serverUrl,
    ).href;
    link.title = 'In Paperless öffnen';
    link.setAttribute('aria-label', `${job.name} in Paperless öffnen`);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.append(icon('open'));
    row.append(link);
  } else if (canRetryImport(job, serverUrl)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'job-retry';
    button.title = 'Importstatus erneut prüfen';
    button.setAttribute('aria-label', `${job.name}: ${button.title}`);
    button.append(icon('retry'));
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await request({
          target: 'background',
          type: 'retry-import',
          jobId: job.id,
        });
        await refresh();
      } catch (error) {
        showUploadError(error);
      } finally {
        button.disabled = false;
      }
    });
    row.append(button);
  }
  return row;
}

function render(state: State): void {
  currentState = state;
  const active = state.jobs.some(isActive) || staged;
  ui.toggle.hidden = !state.settings.configured;
  ui.displaySettings.hidden = !state.settings.configured;
  ui.settingsTitle.textContent = state.settings.configured
    ? 'Einstellungen'
    : 'Mit Paperless verbinden';
  ui.setupHint.hidden = state.settings.configured;
  ui.connectionTitle.hidden = !state.settings.configured;
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
      isPreviousUpload(job, state.settings.url) &&
      sourceKey(job.source) === sourceKey(currentSource),
  );
  ui.send.disabled =
    active ||
    !state.settings.configured ||
    !currentSource ||
    (captured !== undefined && captured.availability !== 'ready') ||
    (isLocal && !localFileAccess) ||
    sourceJob !== undefined;
  ui.sendLabel.textContent =
    sourceJob?.status === 'accepted'
      ? 'Bereits an Paperless übertragen'
      : sourceJob?.status === 'uncertain'
        ? 'Übertragung unbestätigt'
        : 'Aktuelle PDF hochladen';
  const engaged = new Set(
    Array.from(
      ui.jobs.querySelectorAll<HTMLLIElement>('li:hover, li:focus-within'),
    ).map((row) => row.dataset['jobId']),
  );
  const now = Date.now();
  const visibleJobs = state.jobs.filter((job) =>
    isJobVisible(job, now, displaySeconds, engaged.has(job.id)),
  );
  ui.summary.hidden = !visibleJobs.length;
  ui.dismiss.hidden =
    !uploadError && !uploadNotice && !visibleJobs.some(canDismissJob);
  ui.dismiss.disabled = active;
  const jobsKey = JSON.stringify([visibleJobs, state.settings.url]);
  if (jobsKey !== renderedJobs) {
    const focusedId = ui.jobs.contains(document.activeElement)
      ? document.activeElement?.closest('li')?.dataset['jobId']
      : undefined;
    renderedJobs = jobsKey;
    const rows = visibleJobs.map((job) => renderJob(job, state.settings.url));
    ui.jobs.replaceChildren(...rows);
    if (focusedId)
      rows
        .find((row) => row.dataset['jobId'] === focusedId)
        ?.querySelector<HTMLElement>('a, button')
        ?.focus();
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
    await enqueue(input, currentState.settings.url);
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
ui.displayDuration.addEventListener('change', () => {
  const seconds = successDisplaySeconds(Number(ui.displayDuration.value));
  ui.displayDuration.disabled = true;
  ui.displayStatus.textContent = '';
  void chrome.storage.local
    .set({ successDisplaySeconds: seconds })
    .then(() => {
      displaySeconds = seconds;
      render(currentState);
    })
    .catch(() => {
      ui.displayDuration.value = String(displaySeconds);
      ui.displayStatus.textContent =
        'Die Auswahl konnte nicht gespeichert werden.';
    })
    .finally(() => {
      ui.displayDuration.disabled = false;
    });
});
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
  const serverUrl = currentState.settings.url;
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
        serverUrl,
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
ui.upload.addEventListener('dragover', (event) => {
  if (!ui.drop.disabled && event.dataTransfer?.types.includes('Files'))
    ui.upload.classList.add('dragging');
});
ui.upload.addEventListener('dragleave', (event) => {
  if (
    !(event.relatedTarget instanceof Node) ||
    !ui.upload.contains(event.relatedTarget)
  )
    ui.upload.classList.remove('dragging');
});
document.addEventListener('dragover', (event) => event.preventDefault());
document.addEventListener('drop', (event) => event.preventDefault());
ui.upload.addEventListener('drop', (event) => {
  event.preventDefault();
  ui.upload.classList.remove('dragging');
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
  const url = documentSource(currentTab?.url);
  if (url && currentTab?.id !== undefined)
    activeSource = { url, tabId: currentTab.id };
  if (currentTab) await updateWindowTabs(currentTab.windowId);
  await updateWebAccess();
  const preferences = await chrome.storage.local.get('successDisplaySeconds');
  displaySeconds = successDisplaySeconds(preferences['successDisplaySeconds']);
  ui.displayDuration.value = String(displaySeconds);
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
