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
  /**
   * The serialised world, as produced by the worker. `data` is a JSON string
   * whose top level carries `version: SNAPSHOT_VERSION`, and that number is
   * the only thing standing between a save file and a silently wrong animal.
   *
   * A snapshot is not a bag of numbers. It records the brain's input count,
   * its hidden width, its output count and every field that is *interpreted*
   * rather than merely stored — the verb list, the gene meanings, the item
   * indices. N_INPUTS alone has gone 45 -> 67, and N_OUTPUTS 16 -> 19 to make
   * room for gather/drop/combine. Load a v1 world after that change and a
   * weight vector of 2,368 is read as the first 2,368 of 5,587: not a brain
   * with bad memories, a different animal with a different set of senses and
   * three verbs that do not exist yet. Nothing errors. It just behaves like
   * something that learned on a different world, which is the most expensive
   * kind of bug to chase because every other number still looks right.
   *
   * So: a saved world is loadable ONLY under the same SNAPSHOT_VERSION it was
   * written with, and under nothing else. The constant lives in
   * sim/constants.ts rather than here because sim/, worker/ and tests/ all
   * have to agree on it, and it is the worker's `serialize()` that writes it —
   * see `SNAPSHOT_VERSION` in worker/sim.worker.ts.
   *
   * There is no load path yet. `loadWorld` below fetches a row and returns
   * the string; nothing in the app hands it to a Sim, and the `load` case in
   * the worker's message switch is still a placeholder. The version check
   * belongs at the point a deserialiser is actually written, because a check
   * on a string nobody parses is a check that never runs.
   */
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
