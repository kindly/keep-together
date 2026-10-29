/**
 * The outbox kept on the phone (IndexedDB), so pages survive the page
 * being thrown away: iOS Safari often discards it while the camera app is
 * in front, and never asks first. Each page not yet on the laptop is kept
 * with its ids until it lands; a reload of the same link sends them again
 * (recover.ts). Everything here may fail (private browsing, storage off,
 * quota) and then quietly keeps nothing: the page works as before.
 *
 * Pages are filed under a hash of the token, never the token itself.
 */

export interface SavedPage {
  /** SHA-256 of the pairing's token, hex. */
  key: string
  pageId: string
  scanId: string
  /** This page opens its scan: sent as the scan's first page. */
  opens: boolean
  /** Order taken, across scans. */
  seq: number
  bytes: ArrayBuffer
  savedAt: number
}

export interface Saved {
  pages: Array<SavedPage>
  /** The scan "Add page" adds to, if one was open. */
  current: string | null
}

export interface Persist {
  load: (key: string) => Promise<Saved>
  put: (page: SavedPage) => Promise<void>
  drop: (pageId: string) => Promise<void>
  setCurrent: (key: string, scanId: string | null) => Promise<void>
  clear: (key: string) => Promise<void>
}

/** Saved pages older than this belong to a link that has surely ended. */
const KEEP_MS = 3 * 60 * 60 * 1000

/** The token's SHA-256 in hex; null where WebCrypto isn't available. */
export async function pairingKey(token: string): Promise<string | null> {
  try {
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(token),
    )
    return Array.from(new Uint8Array(digest), (b) =>
      b.toString(16).padStart(2, '0'),
    ).join('')
  } catch {
    return null
  }
}

/** Keeps nothing. */
export const noPersist: Persist = {
  load: () => Promise.resolve({ pages: [], current: null }),
  put: () => Promise.resolve(),
  drop: () => Promise.resolve(),
  setCurrent: () => Promise.resolve(),
  clear: () => Promise.resolve(),
}

/** An in-memory Persist, for tests. */
export function memoryPersist(): Persist & {
  pages: Map<string, SavedPage>
  current: Map<string, string | null>
} {
  const pages = new Map<string, SavedPage>()
  const current = new Map<string, string | null>()
  return {
    pages,
    current,
    load: (key) =>
      Promise.resolve({
        pages: [...pages.values()].filter((p) => p.key === key),
        current: current.get(key) ?? null,
      }),
    put: (page) => {
      pages.set(page.pageId, { ...page })
      return Promise.resolve()
    },
    drop: (pageId) => {
      pages.delete(pageId)
      return Promise.resolve()
    },
    setCurrent: (key, scanId) => {
      current.set(key, scanId)
      return Promise.resolve()
    },
    clear: (key) => {
      for (const [id, p] of pages) if (p.key === key) pages.delete(id)
      current.delete(key)
      return Promise.resolve()
    },
  }
}

const DB = 'keep-together-scan'
const PAGES = 'pages'
const META = 'meta'

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB'))
  })
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('IndexedDB'))
  })
}

/** The IndexedDB Persist, or `noPersist` when it can't be opened. */
export async function openPersist(): Promise<Persist> {
  let db: IDBDatabase
  try {
    const open = indexedDB.open(DB, 1)
    open.onupgradeneeded = () => {
      const pages = open.result.createObjectStore(PAGES, { keyPath: 'pageId' })
      pages.createIndex('key', 'key')
      open.result.createObjectStore(META, { keyPath: 'key' })
    }
    db = await request(open)
  } catch {
    return noPersist
  }

  /** Runs `fn` in a transaction; any failure keeps nothing, quietly. */
  const run = async (
    mode: IDBTransactionMode,
    fn: (pages: IDBObjectStore, meta: IDBObjectStore) => void,
  ) => {
    try {
      const tx = db.transaction([PAGES, META], mode)
      fn(tx.objectStore(PAGES), tx.objectStore(META))
      await done(tx)
    } catch {
      // keep nothing
    }
  }

  // Pages of links that have ended long since.
  void run('readwrite', (pages) => {
    const cursor = pages.openCursor()
    cursor.onsuccess = () => {
      const c = cursor.result
      if (!c) return
      if ((c.value as SavedPage).savedAt < Date.now() - KEEP_MS) c.delete()
      c.continue()
    }
  })

  return {
    load: async (key) => {
      try {
        const tx = db.transaction([PAGES, META], 'readonly')
        const [pages, meta] = await Promise.all([
          request(tx.objectStore(PAGES).index('key').getAll(key)),
          request(tx.objectStore(META).get(key)),
        ])
        return {
          pages: pages as Array<SavedPage>,
          current:
            (meta as { current?: string | null } | undefined)?.current ?? null,
        }
      } catch {
        return { pages: [], current: null }
      }
    },
    put: (page) => run('readwrite', (pages) => pages.put(page)),
    drop: (pageId) => run('readwrite', (pages) => pages.delete(pageId)),
    setCurrent: (key, scanId) =>
      run('readwrite', (_, meta) =>
        meta.put({ key, current: scanId, savedAt: Date.now() }),
      ),
    clear: (key) =>
      run('readwrite', (pages, meta) => {
        const cursor = pages.index('key').openCursor(key)
        cursor.onsuccess = () => {
          const c = cursor.result
          if (!c) return
          c.delete()
          c.continue()
        }
        meta.delete(key)
      }),
  }
}
