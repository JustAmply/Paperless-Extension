import assert from 'node:assert/strict';
import test from 'node:test';
import { windowPdfs, windowSources } from '../../dist/browser/pdf-tabs.js';

function browser(t, tabs, results) {
  const queries = [];
  const inspections = [];
  const permissions = [];
  const previous = globalThis.chrome;
  globalThis.chrome = {
    tabs: {
      query: async (query) => {
        queries.push(query);
        return tabs;
      },
    },
    permissions: {
      contains: async (query) => {
        permissions.push(query);
        return true;
      },
    },
    extension: { isAllowedFileSchemeAccess: async () => true },
    scripting: {
      executeScript: async ({ target }) => {
        inspections.push(target.tabId);
        const result = results.get(target.tabId);
        if (result instanceof Error) throw result;
        return [{ result }];
      },
    },
  };
  t.after(() => {
    globalThis.chrome = previous;
  });
  return { queries, inspections, permissions };
}

test('window enumeration excludes protected URLs and scopes the query to one window', async (t) => {
  const calls = browser(
    t,
    [
      { id: 1, url: 'https://files.example/download?id=1#page=3' },
      { id: 2, url: 'file:///C:/Invoice.pdf' },
      { id: 3, url: 'chrome://settings/' },
      { id: 4, url: 'blob:https://files.example/123' },
      { id: 5 },
    ],
    new Map(),
  );
  assert.deepEqual(await windowSources(7), [
    { tabId: 1, url: 'https://files.example/download?id=1' },
    { tabId: 2, url: 'file:///C:/Invoice.pdf' },
    { tabId: 4, url: 'blob:https://files.example/123' },
  ]);
  assert.deepEqual(calls.queries, [{ windowId: 7 }]);
});

test('window upload only uses blob tabs with matching captured data', async (t) => {
  const url = 'blob:https://files.example/123';
  const cached = { tabId: 1, url, fingerprint: 'captured' };
  const calls = browser(
    t,
    [
      { id: 1, url: `${url}#page=2` },
      { id: 2, url: 'blob:https://files.example/uncaptured' },
      { id: 3, url: 'blob:https://files.example/navigated' },
    ],
    new Map(),
  );
  assert.deepEqual(await windowPdfs(7, [cached, { ...cached, tabId: 3 }]), {
    sources: [cached],
    skippedLocalTabs: false,
  });
  assert.deepEqual(calls.inspections, []);
  assert.deepEqual(calls.permissions, []);
});

test('window PDFs use the rendered MIME type, deduplicate URLs, and ignore navigation races', async (t) => {
  const url = 'https://files.example/download?id=1';
  const calls = browser(
    t,
    [
      { id: 1, url },
      { id: 2, url: `${url}#page=2` },
      { id: 3, url: 'https://files.example/not-really.pdf' },
      { id: 4, url: 'https://files.example/old' },
      { id: 5, url: 'https://files.example/closed' },
    ],
    new Map([
      [1, { type: 'application/pdf', url }],
      [2, { type: 'application/pdf', url: `${url}#page=2` }],
      [3, { type: 'text/html', url: 'https://files.example/not-really.pdf' }],
      [4, { type: 'application/pdf', url: 'https://files.example/new' }],
      [5, new Error('No tab with id: 5')],
    ]),
  );
  const { sources, skippedLocalTabs } = await windowPdfs(7);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].url, url);
  assert.equal(skippedLocalTabs, false);
  assert.equal(calls.inspections.length, 5);
  assert.deepEqual(calls.permissions, [
    { origins: ['https://files.example/*'] },
  ]);
});

test('window inspection stops before reading any document when origin access is missing', async (t) => {
  const calls = browser(
    t,
    [{ id: 1, url: 'https://files.example/download' }],
    new Map(),
  );
  globalThis.chrome.permissions.contains = async () => false;
  await assert.rejects(windowPdfs(7), /Webseitenzugriff fehlt/);
  assert.deepEqual(calls.inspections, []);
});

test('inaccessible local tabs do not block web PDFs in the same window', async (t) => {
  const url = 'https://files.example/download';
  const local = 'file:///C:/Invoice.pdf';
  const calls = browser(
    t,
    [
      { id: 1, url: local },
      { id: 2, url },
    ],
    new Map([
      [1, { type: 'application/pdf', url: local }],
      [2, { type: 'application/pdf', url }],
    ]),
  );
  globalThis.chrome.extension.isAllowedFileSchemeAccess = async () => false;
  assert.deepEqual(await windowPdfs(7), {
    sources: [{ tabId: 2, url }],
    skippedLocalTabs: true,
  });
  assert.deepEqual(calls.inspections, [2]);
  assert.deepEqual(calls.permissions, [
    { origins: ['https://files.example/*'] },
  ]);

  globalThis.chrome.extension.isAllowedFileSchemeAccess = async () => true;
  assert.deepEqual(await windowPdfs(7), {
    sources: [
      { tabId: 1, url: local },
      { tabId: 2, url },
    ],
    skippedLocalTabs: false,
  });
});

test('window scans inspect bounded batches concurrently and retain tab order', async (t) => {
  const tabs = Array.from({ length: 10 }, (_, index) => ({
    id: index + 1,
    url: `https://files.example/document/${index + 1}`,
  }));
  browser(t, tabs, new Map());
  const pending = [];
  globalThis.chrome.scripting.executeScript = ({ target }) =>
    new Promise((resolve) => {
      pending.push(() =>
        resolve([
          {
            result: {
              type: 'application/pdf',
              url: tabs[target.tabId - 1].url,
            },
          },
        ]),
      );
    });

  const scan = windowPdfs(7);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.length, 8);
  for (const finish of pending.splice(0).reverse()) finish();

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.length, 2);
  for (const finish of pending.splice(0).reverse()) finish();

  assert.deepEqual(
    (await scan).sources,
    tabs.map(({ id, url }) => ({ tabId: id, url })),
  );
});
