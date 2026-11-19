let database: Promise<IDBDatabase> | undefined;

export function openDatabase(): Promise<IDBDatabase> {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('paperless-upload', 3);
    request.onupgradeneeded = (event) => {
      if (event.oldVersion < 1) {
        request.result.createObjectStore('jobs', { keyPath: 'id' });
        request.result.createObjectStore('files');
      }
      const db = request.result;
      const createSources = () => {
        const store = db.createObjectStore('sources');
        store.createIndex('tabId', 'tabId');
        return store;
      };
      if (event.oldVersion === 2) {
        // Version 2 keyed each capture by tab. Keep those numeric keys while
        // new captures use the unique document ID of the actual viewer.
        const old = request.transaction!.objectStore('sources').getAll();
        old.onsuccess = () => {
          db.deleteObjectStore('sources');
          const store = createSources();
          for (const record of old.result) store.put(record, record.tabId);
        };
      } else {
        createSources();
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return database;
}
