import { enqueue } from './data/jobs.js';
import { request } from './shared/messaging.js';
import {
  errorMessage,
  isActive,
  UserError,
  type Source,
  type State,
} from './shared/model.js';
import { readableSource } from './shared/pdf.js';
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
  fileAccess: element<HTMLButtonElement>('file-access'),
  drop: element<HTMLButtonElement>('drop-zone'),
  sendWindow: element<HTMLButtonElement>('send-window'),
  input: element<HTMLInputElement>('file-input'),
  status: element('upload-status'),
  jobs: element('job-list'),
  fatal: element('fatal-error'),
};

let currentState: State;
let currentTab: chrome.tabs.Tab | undefined;
let currentUrl: string | undefined;
let staged = false;
let polling = false;
let uploadError = '';
let uploadNotice = '';
let windowTabs: Source[] = [];

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
  ui.send.disabled = active;
  ui.toggle.disabled = active;
  ui.jobs.replaceChildren();
  const sourceJob = state.jobs.find((job) => job.source?.url === currentUrl);
  ui.send.hidden = active || sourceJob?.status !== 'failed';
  const visible = state.jobs.filter((job) => job.status !== 'skipped');
  for (const job of visible) {
    const row = document.createElement('li');
    row.dataset['status'] = job.status;
    const indicator = document.createElement('span');
    indicator.className = 'job-indicator';
    indicator.textContent =
      job.status === 'accepted' ? '✓' : isActive(job) ? '↥' : '!';
    const name = document.createElement('span');
    name.className = 'job-name';
    name.textContent = job.name;
    name.title = job.name;
    const message = document.createElement('span');
    message.className = 'job-message';
    message.textContent = job.message;
    row.append(indicator, name, message);
    ui.jobs.append(row);
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
}

async function refresh(): Promise<void> {
  const result = await request({ target: 'background', type: 'state' });
  if (result.state) render(result.state);
}

async function start(
  input: File[] | { url: string; tabId: number },
): Promise<void> {
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
      await maybeUploadCurrent();
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
        type: 'upload-window',
        windowId,
      });
      uploadNotice = response.message ?? '';
    } catch (error) {
      showUploadError(error);
    } finally {
      staged = false;
      windowTabs = await windowSources(windowId);
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
  if (currentUrl && currentTab?.id !== undefined)
    void start({ url: currentUrl, tabId: currentTab.id }).catch(
      showUploadError,
    );
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
      ui.fileAccess.hidden = true;
      await maybeUploadCurrent();
    })
    .catch(showUploadError);
});

async function maybeUploadCurrent(): Promise<void> {
  if (
    !currentState.settings.configured ||
    !currentUrl ||
    currentTab?.id === undefined ||
    currentState.jobs.some(isActive)
  )
    return;
  if (currentUrl.startsWith('file:')) {
    const allowed =
      (await chrome.extension.isAllowedFileSchemeAccess()) &&
      (await chrome.permissions.contains({ origins: ['file:///*'] }));
    if (!allowed) {
      ui.fileAccess.hidden = false;
      return;
    }
  }
  const previous = currentState.jobs.some(
    (job) => job.source?.url === currentUrl,
  );
  if (!previous) await start({ url: currentUrl, tabId: currentTab.id });
  else if (currentState.jobs.some(isActive))
    await request({ target: 'background', type: 'process' });
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
  await maybeUploadCurrent();
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

void initialize().catch((error: unknown) => {
  ui.fatal.textContent = errorMessage(error);
  ui.fatal.hidden = false;
});
