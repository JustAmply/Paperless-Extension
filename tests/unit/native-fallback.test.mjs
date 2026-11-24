import assert from 'node:assert/strict';
import test from 'node:test';
import { configureNativePdfHandling } from '../../dist/browser/native-fallback.js';

test('upgrading Chrome restores only MIME handling disabled for compatibility', async (t) => {
  let version = 156;
  t.mock.getter(navigator, 'userAgent', () => `Chrome/${version}.0.0.0`);
  const stored = {};
  const changes = [];
  let enabled = true;
  const previous = globalThis.chrome;
  t.after(() => {
    globalThis.chrome = previous;
  });
  globalThis.chrome = {
    mimeHandler: {
      getMimeHandlerOptions: async () => ({ enabled }),
      setMimeHandlerOptions: async (mime, options) => {
        assert.equal(mime, 'application/pdf');
        enabled = options.enabled;
        changes.push(enabled);
      },
    },
    storage: {
      local: {
        get: async () => stored,
        set: async (entries) => Object.assign(stored, entries),
        remove: async (key) => delete stored[key],
      },
    },
  };

  await configureNativePdfHandling();
  await configureNativePdfHandling();
  assert.deepEqual(changes, [false]);
  version = 157;
  await configureNativePdfHandling();
  await configureNativePdfHandling();
  assert.deepEqual(changes, [false, true]);

  enabled = false;
  version = 151;
  await configureNativePdfHandling();
  version = 158;
  await configureNativePdfHandling();
  assert.deepEqual(changes, [false, true]);
  assert.equal(enabled, false);
});
