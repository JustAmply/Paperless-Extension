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
  type Job,
} from './shared/model.js';
import { pdfName, readableSource } from './shared/pdf.js';
import { hostPermission, normalizeServer } from './shared/settings.js';
import { sourcePermission, windowSources } from './browser/pdf-tabs.js';

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
  documentName: element('document-name'),
  documentOrigin: element('document-origin'),
  documentAvailability: element('document-availability'),
  fileAccess: element<HTMLButtonElement>('file-access'),
  drop: element<HTMLButtonElement>('drop-zone'),
  sendWindow: element<HTMLButtonElement>('send-window'),
  selection: element('window-selection'),
  options: element('window-options'),
  sendSelected: element<HTMLButtonElement>('send-selected'),
  cancelSelection: element<HTMLButtonElement>('cancel-selection'),
  input: element<HTMLInputElement>('file-input'),
  status: element('upload-status'),
  jobs: element('job-list'),
  summary: element('batch-summary'),
  dismiss: element<HTMLButtonElement>('dismiss-failures'),
  checkImports: element<HTMLButtonElement>('check-imports'),
  stopImports: element<HTMLButtonElement>('stop-import-checks'),
  importHint: element('import-hint'),
  fatal: element('fatal-error'),
};

let currentState: State;
let currentTab: chrome.tabs.Tab | undefined;
let currentUrl: string | undefined;
let localFileAccess = false;
let staged = false;
let polling = false;
let uploadError = '';
let uploadNotice = '';
let windowTabs: Source[] = [];
let selection: SourceInfo[] = [];
let renderedJobs = '';
let checkingImports = false;
let trackImportsUntil = 0;
let nextImportCheck = 0;

function canCheckImport(job: Job): boolean {
  return (
    job.status === 'accepted' &&
    job.importTask !== undefined &&
    job.importTask.serverUrl === currentState.settings.url &&
    (!job.importTask.result ||
      ['pending', 'unavailable'].includes(job.importTask.result.status))
  );
}

async function refreshImports(manual: boolean): Promise<void> {
  if (checkingImports) return;
  checkingImports = true;
  render(currentState);
  try {
    for (const job of currentState.jobs.filter(canCheckImport)) {
      if (!manual && job.importTask?.result?.status !== 'pending') continue;
      if (Date.now() >= trackImportsUntil) break;
      const response = await request({
        target: 'background',
        type: 'check-import',
        jobId: job.id,
      });
      if (response.state) render(response.state);
    }
  } finally {
    checkingImports = false;
    nextImportCheck = Date.now() + 5_000;
    if (
      !currentState.jobs.some(
        (job) =>
          canCheckImport(job) && job.importTask?.result?.status === 'pending',
      )
    )
      trackImportsUntil = 0;
    render(currentState);
  }
}

function updateSelection(): void {
  const active = staged || currentState.jobs.some(isActive);
  let count = 0;
  for (const [index, source] of selection.entries()) {
    const checkbox = ui.options.querySelector<HTMLInputElement>(
      `input[data-index="${index}"]`,
    );
    if (!checkbox) continue;
    const job = currentState.jobs.find(
      (item) => item.source && sourceKey(item.source) === sourceKey(source),
    );
    const completed = job && ['accepted', 'uncertain'].includes(job.status);
    const available = ['ready', 'unchecked'].includes(source.availability);
    checkbox.disabled = active || Boolean(completed) || !available;
    if (completed) checkbox.checked = true;
    if (!available) checkbox.checked = false;
    if (checkbox.checked && !checkbox.disabled) count++;
    const detail = checkbox.parentElement?.querySelector('.selection-detail');
    if (detail)
      detail.textContent = completed
        ? job.message
        : (source.error ??
          (source.availability === 'loading'
            ? 'PDF wird noch geladen. Auswahl bitte erneut öffnen.'
            : new URL(source.url).hostname || 'Lokale Datei'));
  }
  ui.sendSelected.disabled = active || !count;
  ui.sendSelected.textContent = count
    ? `Auswahl hochladen (${count})`
    : 'Auswahl hochladen';
  ui.cancelSelection.disabled = active;
}

function showSelection(sources: SourceInfo[]): void {
  selection = sources;
  ui.options.replaceChildren();
  for (const [index, source] of sources.entries()) {
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset['index'] = String(index);
    checkbox.checked = true;
    const name = document.createElement('span');
    name.textContent = source.name;
    const detail = document.createElement('span');
    detail.className = 'selection-detail';
    label.append(checkbox, name, detail);
    ui.options.append(label);
  }
  ui.selection.hidden = false;
  updateSelection();
}

function selectedSource(state: State): Source | undefined {
  if (!currentUrl || currentTab?.id === undefined) return undefined;
  return (
    state.sources.find(
      (source) => source.tabId === currentTab?.id && source.url === currentUrl,
    ) ?? { url: currentUrl, tabId: currentTab.id }
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
  updateSelection();
  const tracking = Date.now() < trackImportsUntil;
  ui.checkImports.hidden = !state.jobs.some(canCheckImport);
  ui.checkImports.disabled = checkingImports || tracking;
  ui.stopImports.hidden = !tracking;
  ui.importHint.hidden = ui.checkImports.hidden && !tracking;
  ui.importHint.textContent = tracking
    ? 'Prüft wartende Importe alle 5 Sekunden, höchstens 2 Minuten. Schließen des Popups beendet die Prüfung.'
    : 'Optional: Prüft den Import in Paperless, ohne die PDF erneut zu senden.';
  const currentSource = selectedSource(state);
  const captured = state.sources.find(
    (source) => source.tabId === currentTab?.id && source.url === currentUrl,
  );
  ui.documentName.textContent =
    captured?.name ??
    (currentUrl ? pdfName(currentUrl) : 'Kein abrufbares Dokument');
  ui.documentOrigin.textContent = currentUrl
    ? currentUrl.startsWith('file:')
      ? 'Lokale Datei'
      : new URL(currentUrl).hostname
    : 'Öffne eine PDF oder wähle eine Datei aus.';
  ui.documentAvailability.textContent = captured
    ? captured.availability === 'ready'
      ? `Bereit zum Hochladen · ${new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 }).format((captured.size ?? 0) / 1024)} KB`
      : (captured.error ?? 'PDF wird noch geladen …')
    : currentUrl
      ? 'Verfügbarkeit wird beim Hochladen geprüft.'
      : '';
  ui.documentAvailability.classList.toggle(
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
    !currentUrl ||
    currentTab?.id === undefined ||
    (captured !== undefined && captured.availability !== 'ready') ||
    (currentUrl.startsWith('file:') && !localFileAccess) ||
    (sourceJob !== undefined &&
      ['accepted', 'uncertain'].includes(sourceJob.status));
  const completed = state.jobs.filter((job) => !isActive(job)).length;
  const accepted = state.jobs.filter((job) => job.status === 'accepted').length;
  ui.summary.hidden = !state.jobs.length;
  ui.summary.textContent = active
    ? `${completed} von ${state.jobs.length} abgeschlossen`
    : `Letzte Übertragung: ${accepted} von ${state.jobs.length} zur Verarbeitung angenommen`;
  ui.dismiss.hidden =
    !uploadError &&
    !uploadNotice &&
    !state.jobs.some((job) => ['failed', 'skipped'].includes(job.status));
  ui.dismiss.disabled = active;
  const jobsKey = JSON.stringify([state.jobs, state.settings.url]);
  if (jobsKey !== renderedJobs) {
    renderedJobs = jobsKey;
    ui.jobs.replaceChildren();
    for (const job of state.jobs) {
      const row = document.createElement('li');
      row.dataset['status'] = job.status;
      const indicator = document.createElement('span');
      indicator.className = 'job-indicator';
      indicator.textContent =
        job.status === 'accepted'
          ? '✓'
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
      if (job.importTask) {
        const result = job.importTask.result;
        const detail = document.createElement('span');
        detail.className = 'import-result';
        detail.textContent = result?.message ?? 'Import noch nicht geprüft';
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

ui.form.addEventListener('submit', (event) => {
  event.preventDefault();
  let url: string;
  let permission: Promise<boolean>;
  try {
    url = normalizeServer(ui.url.value);
    // Chrome requires the permission request in the original user gesture.
    permission = chrome.permissions.request({ origins: [hostPermission(url)] });
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
        throw new UserError('Der Zugriff auf den Server wurde nicht erlaubt.');
      const result = await request({
        target: 'background',
        type: 'save',
        url,
        token: ui.token.value,
      });
      ui.token.value = '';
      if (result.state) render(result.state);
      ui.settingsStatus.textContent = '';
      ui.save.textContent = 'Verbindung speichern';
      ui.token.placeholder = 'Gespeicherten Token beibehalten';
      ui.token.required = false;
      ui.tokenHelp.textContent =
        'Leer lassen, um den gespeicherten Token zu behalten.';
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
});
ui.toggle.addEventListener('click', () =>
  showSettings(ui.settings.hidden === true),
);
ui.drop.addEventListener('click', () => ui.input.click());
ui.checkImports.addEventListener('click', () => {
  trackImportsUntil = Date.now() + 120_000;
  void refreshImports(true).catch(showUploadError);
});
ui.stopImports.addEventListener('click', () => {
  trackImportsUntil = 0;
  render(currentState);
});
ui.dismiss.addEventListener('click', () => {
  if (staged || currentState.jobs.some(isActive)) return;
  void (async () => {
    const result = await request({
      target: 'background',
      type: 'dismiss-failures',
    });
    uploadError = '';
    uploadNotice = '';
    if (result.state) render(result.state);
  })().catch(showUploadError);
});
ui.sendWindow.addEventListener('click', () => {
  if (staged || currentState.jobs.some(isActive) || !currentTab) return;
  const windowId = currentTab.windowId;
  const permission = chrome.permissions.request({
    origins: [
      ...new Set(windowTabs.map((source) => sourcePermission(source.url))),
    ],
  });
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
        type: 'scan-window',
        windowId,
      });
      showSelection(response.sources ?? []);
      uploadNotice = response.sources?.length ? '' : 'Keine PDF-Tabs gefunden.';
    } catch (error) {
      showUploadError(error);
    } finally {
      staged = false;
      windowTabs = await windowSources(windowId);
      await refresh();
    }
  })().catch(showUploadError);
});
ui.options.addEventListener('change', updateSelection);
ui.cancelSelection.addEventListener('click', () => {
  ui.selection.hidden = true;
  selection = [];
});
ui.sendSelected.addEventListener('click', () => {
  if (ui.sendSelected.disabled || !currentTab) return;
  const sources = selection.filter(
    (_source, index) =>
      ui.options.querySelector<HTMLInputElement>(`input[data-index="${index}"]`)
        ?.checked,
  );
  const windowId = currentTab.windowId;
  staged = true;
  uploadError = '';
  uploadNotice = '';
  render(currentState);
  void (async () => {
    try {
      await request({
        target: 'background',
        type: 'upload-window',
        windowId,
        sources,
      });
      ui.selection.hidden = true;
      selection = [];
    } catch (error) {
      showUploadError(error);
    } finally {
      staged = false;
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
      ui.fileAccess.hidden = true;
      render(currentState);
    })
    .catch(showUploadError);
});

async function updateCurrentAccess(): Promise<void> {
  if (currentUrl?.startsWith('file:')) {
    localFileAccess =
      (await chrome.extension.isAllowedFileSchemeAccess()) &&
      (await chrome.permissions.contains({ origins: ['file:///*'] }));
    ui.fileAccess.hidden = localFileAccess;
  }
  render(currentState);
}

async function initialize(): Promise<void> {
  [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentUrl = readableSource(currentTab?.url);
  if (currentTab) windowTabs = await windowSources(currentTab.windowId);
  await refresh();
  ui.url.value = currentState.settings.url;
  ui.httpWarning.hidden = !ui.url.value.startsWith('http://');
  ui.token.required = !currentState.settings.configured;
  if (currentState.settings.configured) {
    ui.save.textContent = 'Verbindung speichern';
    ui.token.placeholder = 'Gespeicherten Token beibehalten';
    ui.tokenHelp.textContent =
      'Leer lassen, um den gespeicherten Token zu behalten.';
  }
  showSettings(!currentState.settings.configured);
  if (currentState.jobs.some(isActive))
    await request({ target: 'background', type: 'process' });
  await updateCurrentAccess();
  window.setInterval(() => {
    if (polling || staged) return;
    if (
      Date.now() < trackImportsUntil &&
      Date.now() >= nextImportCheck &&
      !checkingImports
    ) {
      void refreshImports(false).catch(showUploadError);
    }
    polling = true;
    void refresh()
      .catch(showUploadError)
      .finally(() => {
        polling = false;
      });
  }, 500);
}

void initialize().catch((error: unknown) => {
  ui.fatal.textContent = errorMessage(error);
  ui.fatal.hidden = false;
});
