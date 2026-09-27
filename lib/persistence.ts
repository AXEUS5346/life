/**
 * Local-only persistence. Worlds live in IndexedDB on this machine — there is
 * no server and nothing ever leaves the browser.
 *
 * Full snapshots are ~12 MB of JSON (600 brains x 2,368 params dominates), which
 * is why dead pixels are meant to be flushed out of RAM rather than kept there.
 */

const DB_NAME = 'pixels';
const DB_VERSION = 1;
const STORE = 'worlds';

export type SavedWorld = {
  key: string;
  seed: number;
  tick: number;
  savedAt: number;
  pop: number;
  generation: number;
  /** the serialised world, as produced by the worker */
  data: string;
};

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: 'key' });
        os.createIndex('savedAt', 'savedAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveWorld(w: SavedWorld): Promise<void> {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(w);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function listWorlds(): Promise<Omit<SavedWorld, 'data'>[]> {
  const db = await open();
  const out = await new Promise<Omit<SavedWorld, 'data'>[]>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => {
      const rows = (req.result as SavedWorld[])
        .map(({ data: _data, ...rest }) => rest)
        .sort((a, b) => b.savedAt - a.savedAt);
      resolve(rows);
    };
    req.onerror = () => reject(req.error);
  });
  db.close();
  return out;
}

export async function loadWorld(key: string): Promise<SavedWorld | null> {
  const db = await open();
  const out = await new Promise<SavedWorld | null>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve((req.result as SavedWorld) ?? null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return out;
}

export async function deleteWorld(key: string): Promise<void> {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

/** Rough on-disk size of everything we have stored, for the UI. */
export async function storageUsed(): Promise<number> {
  if (!navigator.storage?.estimate) return 0;
  const e = await navigator.storage.estimate();
  return e.usage ?? 0;
}
