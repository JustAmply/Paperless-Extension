import assert from 'node:assert/strict';
import test from 'node:test';
import { legacyMessage } from '../../dist/shared/legacy-message.js';
import { resolveMessage } from '../../dist/shared/i18n.js';

test('stored 0.3.x upload, capture and import explanations have stable message keys', () => {
  for (const [value, key] of [
    [
      'Keine Bestätigung erhalten. Prüfe zuerst den Paperless-Posteingang, bevor du die Datei erneut sendest.',
      'uploadUncertain',
    ],
    [
      'Die zwischengespeicherte PDF ist nicht mehr verfügbar. Speichere sie im PDF-Viewer und ziehe sie hier hinein.',
      'cacheUnavailable',
    ],
    [
      'Importstatus nicht verfügbar. Die PDF wurde übertragen; prüfe den Import in Paperless.',
      'importUnavailable',
    ],
    [
      'Bereits vorhanden: Paperless hat ein Duplikat erkannt.',
      'importDuplicate',
    ],
    [
      'Die PDF wurde übertragen. Der Import dauert länger; prüfe den Status in Paperless.',
      'importTakingLonger',
    ],
  ])
    assert.deepEqual(legacyMessage(value), { key });
});

test('old HTTP errors retain the status and match only the original explanation', () => {
  const manual =
    'Lade die PDF aus dem geöffneten PDF-Viewer herunter und wähle sie hier aus oder ziehe sie hinein.';
  for (const [reason, status, key] of [
    [
      'Die ursprüngliche PDF-Adresse ist nicht mehr verfügbar. Der Link kann abgelaufen oder nur einmal gültig sein.',
      '410',
      'sourceExpired',
    ],
    [
      'Die Website verweigert den Zugriff auf die PDF. Möglicherweise ist die Anmeldung abgelaufen.',
      '403',
      'sourceDenied',
    ],
    ['Die Website konnte die PDF nicht liefern.', '500', 'sourceHttpError'],
  ]) {
    const value = `${reason} (HTTP ${status}) Es wurde nichts an Paperless gesendet. ${manual}`;
    assert.deepEqual(legacyMessage(value), { key, substitutions: [status] });
    assert.equal(resolveMessage(value + ' Detail'), value + ' Detail');
  }
  assert.deepEqual(
    legacyMessage(
      'Paperless hat die Anfrage abgelehnt (HTTP 422). Prüfe die Adresse und gegebenenfalls die Paperless-Protokolle.',
    ),
    {
      key: 'apiRejected',
      substitutions: ['422'],
    },
  );
  assert.equal(
    resolveMessage('Rechnung (HTTP 404).pdf'),
    'Rechnung (HTTP 404).pdf',
  );
});
