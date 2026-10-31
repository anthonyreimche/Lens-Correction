// Lens Correction for Safelight — MIT licensed (see LICENSE).
// Tiny IndexedDB key/value helper. Used for two caches that the develop-time
// param-bag/sidecar APIs can't hold:
//   - "embedded": per-photo embedded RAW corrections (parsed at import, where the
//     directory handle is available, then read back by photo id at develop time).
//   - "lcp": the imported Adobe Lens Profile library, matched live like Lensfun.
//   - "lensfun": imported Lensfun XML files, laid over the bundled database.

const DB_NAME = "safelight-lens-correction";
const DB_VERSION = 2;
const STORES = ["embedded", "lcp", "lensfun"] as const;
export type StoreName = (typeof STORES)[number];

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
  return dbPromise;
}

export async function idbGet<T>(store: StoreName, key: string): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(store, "readonly");
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => resolve((req.result as T) ?? null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function idbSet(store: StoreName, key: string, value: unknown): Promise<void> {
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(store, "readwrite");
      tx.objectStore(store).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function idbGetAll<T>(store: StoreName): Promise<T[]> {
  const db = await openDb();
  if (!db) return [];
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(store, "readonly");
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => resolve((req.result as T[]) ?? []);
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

export async function idbHas(store: StoreName, key: string): Promise<boolean> {
  const db = await openDb();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(store, "readonly");
      const req = tx.objectStore(store).getKey(key);
      req.onsuccess = () => resolve(req.result !== undefined);
      req.onerror = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

/** Every [key, value] pair in a store, in key order. */
export async function idbEntries<T>(store: StoreName): Promise<[string, T][]> {
  const db = await openDb();
  if (!db) return [];
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(store, "readonly");
      const keys = tx.objectStore(store).getAllKeys();
      const values = tx.objectStore(store).getAll();
      tx.oncomplete = () => resolve(keys.result.map((k, i) => [String(k), values.result[i] as T]));
      tx.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

export async function idbDelete(store: StoreName, key: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(store, "readwrite");
      tx.objectStore(store).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}
