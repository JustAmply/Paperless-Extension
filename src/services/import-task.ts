import type { Settings, ImportResult } from '../shared/model.js';

const unavailable: ImportResult = {
  status: 'unavailable',
  message:
    'Importstatus nicht verfügbar. Die PDF wurde übertragen; prüfe den Import in Paperless.',
};
const retryable: ImportResult = {
  status: 'unavailable',
  retryable: true,
  message:
    'Importstatus vorübergehend nicht verfügbar. Wird automatisch erneut geprüft …',
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function documentId(value: unknown): number | undefined {
  // Legacy task serializers return document IDs as decimal strings.
  const id =
    typeof value === 'string' && /^[1-9]\d*$/.test(value)
      ? Number(value)
      : value;
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0
    ? id
    : undefined;
}

export async function checkImport(
  settings: Settings,
  taskId: string,
): Promise<ImportResult> {
  const url = new URL('api/tasks/', settings.url);
  url.searchParams.set('task_id', taskId);
  let body: unknown;
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Token ${settings.token}` },
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 401 || response.status === 403) {
      return {
        status: 'unavailable',
        message:
          'Kein Zugriff auf den Importstatus. Prüfe den API-Token und die Aufgaben-Berechtigung in Paperless.',
      };
    }
    if (!response.ok)
      return response.status >= 500 || response.status === 429
        ? retryable
        : unavailable;
    try {
      body = await response.json();
    } catch {
      return unavailable;
    }
  } catch {
    return retryable;
  }

  // API v10 uses a paginated list; earlier versions return the array directly.
  const tasks: unknown = Array.isArray(body)
    ? body
    : record(body)
      ? body['results']
      : undefined;
  if (!Array.isArray(tasks)) return unavailable;
  const task: unknown = tasks.find(
    (item: unknown) => record(item) && item['task_id'] === taskId,
  );
  if (task === undefined) return retryable;
  if (!record(task) || typeof task['status'] !== 'string') return unavailable;
  const status = task['status'].toLowerCase();
  if (['pending', 'started', 'retry'].includes(status)) {
    return { status: 'pending', message: 'Paperless verarbeitet die PDF …' };
  }

  const result = record(task['result_data']) ? task['result_data'] : undefined;
  if (status === 'success') {
    const id = documentId(result?.['document_id'] ?? task['related_document']);
    return id === undefined
      ? unavailable
      : {
          status: 'success',
          message: 'In Paperless importiert',
          documentId: id,
        };
  }
  if (status === 'failure') {
    // Legacy related_document on FAILURE identifies a duplicate. API v10
    // provides duplicate_of explicitly. Never infer duplicates from error text.
    const id = documentId(result?.['duplicate_of'] ?? task['related_document']);
    return id === undefined
      ? {
          status: 'failure',
          message:
            'Paperless konnte die PDF nicht importieren. Prüfe die Aufgabe in Paperless.',
        }
      : {
          status: 'duplicate',
          message: 'Bereits vorhanden: Paperless hat ein Duplikat erkannt.',
          documentId: id,
        };
  }
  if (status === 'revoked') {
    return {
      status: 'failure',
      message: 'Der Import wurde in Paperless abgebrochen.',
    };
  }
  return unavailable;
}
