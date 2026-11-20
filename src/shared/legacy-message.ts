import type { LocalizedMessage, MessageKey } from './i18n.js';

// These are persisted 0.3.x values. Keep their spelling independent of future copy edits.
const manualUpload =
  'Lade die PDF aus dem geöffneten PDF-Viewer herunter und wähle sie hier aus oder ziehe sie hinein.';
const staticMessages = new Map<string, MessageKey>([
  ['Wartet auf Übertragung', 'waitingForTransfer'],
  [
    'Die PDF im Tab hat sich geändert oder wurde geschlossen. Bitte öffne die Erweiterung erneut.',
    'tabPdfChanged',
  ],
  [
    'Die PDF wird noch geladen. Bitte warte kurz und versuche es erneut.',
    'tabPdfLoading',
  ],
  [
    'Die zwischengespeicherte PDF ist nicht mehr verfügbar. Speichere sie im PDF-Viewer und ziehe sie hier hinein.',
    'cacheUnavailable',
  ],
  [
    'Die Aktion konnte nicht abgeschlossen werden. Bitte versuche es erneut.',
    'actionFailed',
  ],
  ['Zugriff verweigert.', 'accessDenied'],
  ['Die PDF ist zu groß. Pro Datei sind bis zu 50 MiB möglich.', 'pdfTooLarge'],
  ['Diese Datei ist keine PDF. Bitte wähle eine PDF-Datei aus.', 'invalidPdf'],
  [
    'Der API-Token ist ungültig. Bitte prüfe ihn in den Einstellungen.',
    'apiInvalidToken',
  ],
  [
    'Keine Berechtigung. Prüfe die Rechte des Tokens und den Serverzugriff.',
    'apiDenied',
  ],
  [
    'Der Server lehnt die Dateigröße ab. Prüfe sein Upload-Limit.',
    'apiTooLarge',
  ],
  ['Zu viele Anfragen. Bitte versuche es später erneut.', 'apiRateLimited'],
  [
    'Importstatus nicht verfügbar. Die PDF wurde übertragen; prüfe den Import in Paperless.',
    'importUnavailable',
  ],
  [
    'Importstatus vorübergehend nicht verfügbar. Wird automatisch erneut geprüft …',
    'importRetrying',
  ],
  [
    'Kein Zugriff auf den Importstatus. Prüfe den API-Token und die Aufgaben-Berechtigung in Paperless.',
    'importStatusDenied',
  ],
  ['Paperless verarbeitet die PDF …', 'importProcessing'],
  ['In Paperless importiert', 'importSuccess'],
  [
    'Paperless konnte die PDF nicht importieren. Prüfe die Aufgabe in Paperless.',
    'importFailed',
  ],
  ['Bereits vorhanden: Paperless hat ein Duplikat erkannt.', 'importDuplicate'],
  ['Der Import wurde in Paperless abgebrochen.', 'importCancelled'],
  [
    'Keine Bestätigung erhalten. Prüfe zuerst den Paperless-Posteingang, bevor du die Datei erneut sendest.',
    'uploadUncertain',
  ],
  [
    'Der Abruf wurde unterbrochen. Bitte versuche es erneut.',
    'downloadInterrupted',
  ],
  ['Bitte richte deinen Paperless-Server ein.', 'setupServer'],
  [
    'Das Upload-Ziel hat sich geändert oder fehlt. Wähle die PDF erneut aus.',
    'destinationChanged',
  ],
  ['Geöffnete PDF wird abgerufen …', 'fetchingOpenPdf'],
  [
    'Keine PDF erhalten. Die Website liefert möglicherweise eine Anmeldeseite. Speichere die PDF im Viewer und wähle sie hier aus.',
    'sourceNotPdf',
  ],
  [
    'Die Datei ist nicht mehr verfügbar. Bitte wähle sie erneut aus.',
    'fileUnavailable',
  ],
  ['Wird an Paperless übertragen …', 'sendingToPaperless'],
  ['An Paperless übertragen', 'uploadAccepted'],
  [
    'Die PDF wurde übertragen. Der Import dauert länger; prüfe den Status in Paperless.',
    'importTakingLonger',
  ],
  [
    'Dieser Upload gehört zu einem anderen Paperless-Server.',
    'uploadOtherServer',
  ],
  ['Die Aktion konnte nicht abgeschlossen werden.', 'actionFailed'],
  [
    `Die PDF lässt sich nicht erneut abrufen. ${manualUpload}`,
    'sourceFetchFailed',
  ],
  [
    `Der Abruf der PDF wurde unterbrochen. ${manualUpload}`,
    'sourceInterrupted',
  ],
]);

const sourceHttpSuffix = ` (HTTP $status$) Es wurde nichts an Paperless gesendet. ${manualUpload}`;
const httpMessages = new Map<string, MessageKey>([
  [
    `Die ursprüngliche PDF-Adresse ist nicht mehr verfügbar. Der Link kann abgelaufen oder nur einmal gültig sein.${sourceHttpSuffix}`,
    'sourceExpired',
  ],
  [
    `Die Website verweigert den Zugriff auf die PDF. Möglicherweise ist die Anmeldung abgelaufen.${sourceHttpSuffix}`,
    'sourceDenied',
  ],
  [
    `Die Website konnte die PDF nicht liefern.${sourceHttpSuffix}`,
    'sourceHttpError',
  ],
  [
    'Paperless hat die Anfrage abgelehnt (HTTP $status$). Prüfe die Adresse und gegebenenfalls die Paperless-Protokolle.',
    'apiRejected',
  ],
]);

export function legacyMessage(text: string): LocalizedMessage | undefined {
  const key = staticMessages.get(text);
  if (key) return { key };
  const httpStatus = /\(HTTP (\d{3})\)/.exec(text);
  if (!httpStatus?.[1]) return undefined;
  const httpKey = httpMessages.get(
    text.replace(httpStatus[0], '(HTTP $status$)'),
  );
  return httpKey ? { key: httpKey, substitutions: [httpStatus[1]] } : undefined;
}
