import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hostPermission,
  normalizeServer,
  validateSettings,
} from '../../dist/shared/settings.js';
import { UserError } from '../../dist/shared/model.js';

test('server addresses retain installation subpaths and normalize trailing slashes', () => {
  assert.equal(
    normalizeServer(' paperless.example/paperless/// '),
    'https://paperless.example/paperless/',
  );
  assert.equal(
    normalizeServer('http://localhost:8000'),
    'http://localhost:8000/',
  );
  assert.equal(
    hostPermission('https://paperless.example/paperless/'),
    'https://paperless.example/*',
  );
});

test('server configuration rejects credentials, URL parameters and non-web schemes', () => {
  for (const address of [
    '',
    'https://user:password@paperless.example/',
    'https://paperless.example/?token=secret',
    'https://paperless.example/#documents',
    'file:///tmp/paperless',
    'ftp://paperless.example/',
    'https://',
  ]) {
    assert.throws(() => normalizeServer(address), UserError, address);
  }
});

test('tokens are trimmed while invalid header values are rejected before any request', () => {
  assert.deepEqual(validateSettings('paperless.example', '  api-token  '), {
    url: 'https://paperless.example/',
    token: 'api-token',
  });
  for (const token of [
    '',
    '   ',
    'first second',
    'one\r\nOther: header',
    'nul\u0000token',
    'del\u007ftoken',
    'x'.repeat(513),
  ]) {
    assert.throws(
      () => validateSettings('paperless.example', token),
      UserError,
    );
  }
});
