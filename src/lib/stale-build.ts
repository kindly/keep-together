/**
 * An open tab after a deploy. Every build renames its lazy chunks, so a
 * tab loaded before the deploy asks for files the server no longer has
 * (a 404: `server/crates/api/src/static_files.rs`). When that happens on
 * the way to a page, reload once: the URL is already the page the user
 * was going to, and the fresh `index.html` names the new chunks.
 *
 * - At most one automatic reload per `RELOAD_WINDOW_MS`, remembered in
 *   sessionStorage. If the reload didn't fix it, the failure reaches the
 *   router's normal error UI rather than looping.
 * - With unsaved work on the page, or no storage to hold the guard in,
 *   nothing reloads by itself: a banner offers the reload instead.
 * - A failed background preload (hovering a link) is left alone: the
 *   navigation, if it comes, fails the same way and recovers then.
 *
 * TanStack Router's `lazyRouteComponent` also reloads once per failed
 * module (its own `tanstack_router_reload:` key) when a route component
 * fails to render. That is bounded too, and only fires on a route the
 * user has already chosen to go to, after the page's leave guard.
 */

export const RELOAD_KEY = 'keep:stale-build-reload'
export const RELOAD_WINDOW_MS = 30_000

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>

/**
 * `ok`: no automatic reload in the window, and this one is recorded.
 * `recent`: one already happened; `unavailable`: storage threw, so a
 * reload couldn't be guarded against looping.
 */
export type Guard = 'ok' | 'recent' | 'unavailable'

export function claimReload(
  storage: () => Storage | null | undefined,
  now: number,
): Guard {
  try {
    const s = storage()
    if (!s) return 'unavailable'
    const last = Number(s.getItem(RELOAD_KEY))
    if (Number.isFinite(last) && last > 0 && now - last < RELOAD_WINDOW_MS)
      return 'recent'
    s.setItem(RELOAD_KEY, String(now))
    // A storage that drops writes can't guard either.
    if (s.getItem(RELOAD_KEY) !== String(now)) return 'unavailable'
    return 'ok'
  } catch {
    return 'unavailable'
  }
}

/** `reload` now; `ask` with the banner; `none`: leave it to the error UI. */
export type Decision = 'reload' | 'ask' | 'none'

export function decide(input: {
  navigating: boolean
  unsaved: boolean
  claim: () => Guard
}): Decision {
  if (!input.navigating) return 'none'
  if (input.unsaved) return 'ask'
  switch (input.claim()) {
    case 'ok':
      return 'reload'
    case 'unavailable':
      return 'ask'
    case 'recent':
      return 'none'
  }
}

// The banner's state: once a new version is known, it stays known.
let available = false
const listeners = new Set<() => void>()

export function newVersionAvailable(): boolean {
  return available
}

export function announceNewVersion() {
  if (available) return
  available = true
  for (const l of [...listeners]) l()
}

export function subscribeNewVersion(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Tests only. */
export function resetNewVersion() {
  available = false
}

const sessionStore = () => window.sessionStorage

/**
 * Listen for Vite's `vite:preloadError` (a lazy chunk, or one it
 * depends on, failed to load). The error still propagates to whoever
 * imported it; a reload replaces the page before it shows.
 */
export function installStaleBuildRecovery(deps: {
  navigating: () => boolean
  unsaved: () => boolean
  reload?: () => void
  now?: () => number
  storage?: () => Storage | null | undefined
}): () => void {
  const reload = deps.reload ?? (() => window.location.reload())
  const now = deps.now ?? Date.now
  const storage = deps.storage ?? sessionStore
  const onError = () => {
    const d = decide({
      navigating: deps.navigating(),
      unsaved: deps.unsaved(),
      claim: () => claimReload(storage, now()),
    })
    if (d === 'reload') reload()
    else if (d === 'ask') announceNewVersion()
  }
  window.addEventListener('vite:preloadError', onError)
  return () => window.removeEventListener('vite:preloadError', onError)
}
