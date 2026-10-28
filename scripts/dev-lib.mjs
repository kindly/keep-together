// The pure parts of `pnpm dev` (scripts/dev.mjs): which slot a checkout
// gets and the ports that follow from it.
//
// Every checkout of the repo (the main one and each worktree) has a slot
// n, kept in the main checkout's git dir (`keep-dev-slots.json`), so the
// same worktree gets the same ports every time and two never share one.
// The main checkout is always 0; a worktree takes the lowest free n from
// 1. A slot whose checkout is gone is free again.

/** The api's port is 8787 + n (`KEEP_PORT`, CLAUDE.md "Local only"). */
export const API_BASE = 8787
/** Vite's port is 3000 + n. */
export const VITE_BASE = 3000
/**
 * The tailnet's https port (`tailscale serve`) is 9100 + n. The machine's
 * serve config is shared with other projects (443 is the preview's,
 * 8443–8450 others'): keep-together's dev entries stay in this range.
 */
export const HTTPS_BASE = 9100

// Ports other tools own: QC's pool (8801 + i, scripts/qc.mjs) and the
// stall bench (8800, scripts/perf-stall). A slot whose api port lands here
// is never handed out.
const TAKEN = { from: 8800, to: 8819 }

export function reserved(n) {
  const api = API_BASE + n
  return api >= TAKEN.from && api <= TAKEN.to
}

export function portsFor(n) {
  return { api: API_BASE + n, vite: VITE_BASE + n, https: HTTPS_BASE + n }
}

/**
 * The slot for `checkout` in `slots` (checkout path → n), and the slots
 * to write back: `checkout`'s own (new or kept), the main checkout's 0,
 * and every other entry whose checkout still `exists`.
 */
export function slotFor(slots, checkout, mainCheckout, exists) {
  const kept = {}
  for (const [p, n] of Object.entries(slots)) {
    if (p === checkout || exists(p)) kept[p] = n
  }
  if (checkout === mainCheckout) {
    kept[checkout] = 0
    return { n: 0, slots: kept }
  }
  if (Number.isInteger(kept[checkout]) && kept[checkout] > 0) {
    return { n: kept[checkout], slots: kept }
  }
  const used = new Set(
    Object.entries(kept)
      .filter(([p]) => p !== checkout)
      .map(([, n]) => n),
  )
  let n = 1
  while (used.has(n) || reserved(n)) n++
  kept[checkout] = n
  return { n, slots: kept }
}

/**
 * What `tailscale serve status --json` serves on https `port`: null when
 * nothing, else `{ ours }`, true only when the port does exactly what
 * `pnpm dev` would make it do (proxy / to `target`). Anything else on the
 * port belongs to someone else: never replaced, never removed.
 */
export function servedOn(status, port, target) {
  const tcp = status?.TCP?.[String(port)]
  const webKey = Object.keys(status?.Web ?? {}).find((k) =>
    k.endsWith(`:${port}`),
  )
  if (!tcp && !webKey) return null
  const handlers = webKey ? (status.Web[webKey].Handlers ?? {}) : {}
  const paths = Object.keys(handlers)
  const ours =
    paths.length === 1 && paths[0] === '/' && handlers['/'].Proxy === target
  return { ours }
}
