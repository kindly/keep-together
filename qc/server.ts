import { BULK_ROUTES } from './budgets'
import type { ApiCall, FlowRecord } from './timing'

// The server rule (ADR 0018): every call a user waits on must take under
// 100 ms on the server, bar one spike per route. Server time comes from
// each response's `Server-Timing: total` (rs/README.md "Timing"), carried
// by the timed samples' calls (qc/timing.ts), so it covers exactly what
// the flows waited on: no log stream to keep alive, no clock to align.
//
// A route may have one call at or over 100 ms in a run, as long as it has
// other calls and all of them are under: the server form of the flows'
// one re-measure (a stall is one moment, and a call can't be replayed).
// A second slow call fails, and so does a route whose only call was slow.
// Bulk routes (BULK_ROUTES in ./budgets, exempt like their `bulk` flows)
// are held to their own limit instead.
//
// Not asserted: `/api/dev/*` (the stub sign-in and the QC seed, which no
// user waits on in production), and calls that never answered within the
// sample. A call that answered with no `Server-Timing` is listed: the api
// sets it on every response, so its absence is a bug.

export const SERVER_BUDGET_MS = 100

/** `GET /api/t/<slug>/contacts/<id>?q=x` → `GET /t/:slug/contacts/:id`. */
export function routeOf(c: Pick<ApiCall, 'method' | 'url'>): string {
  const p = c.url
    .split('?')[0]
    .replace(/^\/api/, '')
    .replace(/^\/t\/[^/]+/, '/t/:slug')
    .replace(/\/[0-9a-f]{32}(?=\/|$)/g, '/:id')
  return `${c.method} ${p}`
}

export interface RouteStats {
  route: string
  asserted: boolean
  /** The route's limit: 100 ms, or its bulk limit. */
  budgetMs: number
  n: number
  p50Ms: number
  p95Ms: number
  maxMs: number
  /** Calls at or over the limit. */
  over: number
  /** One call over, the rest under: passed. */
  spike?: true
}

export interface ServerSummary {
  pass: boolean
  failures: Array<string>
  spikes: Array<string>
  /** Answered calls with no Server-Timing header. */
  untimed: Array<string>
  routes: Array<RouteStats>
}

const pct = (xs: Array<number>, p: number) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)]
}

/** Every timed sample's calls, both sets of a re-measure included. */
export function serverSummary(records: Array<FlowRecord>): ServerSummary {
  const byRoute = new Map<string, Array<number>>()
  const untimed = new Set<string>()
  for (const r of records) {
    if (r.selfTest) continue
    for (const d of [...(r.firstDetail ?? []), ...r.detail]) {
      for (const c of d.calls) {
        if (c.endMs === null) continue
        const route = routeOf(c)
        if (c.serverMs === null) {
          untimed.add(route)
          continue
        }
        byRoute.set(route, [...(byRoute.get(route) ?? []), c.serverMs])
      }
    }
  }
  const failures: Array<string> = []
  const spikes: Array<string> = []
  const routes = [...byRoute.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([route, ms]): RouteStats => {
      const asserted = !route.split(' ')[1].startsWith('/dev/')
      const budgetMs = BULK_ROUTES[route] ?? SERVER_BUDGET_MS
      const over = ms.filter((x) => x >= budgetMs).length
      const maxMs = Math.max(...ms)
      const spike = asserted && over === 1 && ms.length > 1
      if (asserted && over > 0 && !spike)
        failures.push(
          `server ${route}: ${over} of ${ms.length} calls at or over ${budgetMs} ms (max ${maxMs})`,
        )
      if (spike)
        spikes.push(
          `${route}: one call ${maxMs} ms of ${ms.length}, the rest under ${budgetMs} ms`,
        )
      return {
        route,
        asserted,
        budgetMs,
        n: ms.length,
        p50Ms: pct(ms, 50),
        p95Ms: pct(ms, 95),
        maxMs,
        over,
        ...(spike && { spike: true as const }),
      }
    })
  const missing = [...untimed].sort()
  if (missing.length)
    failures.push(
      `server: answered with no Server-Timing: ${missing.join(', ')}`,
    )
  return {
    pass: failures.length === 0,
    failures,
    spikes,
    untimed: missing,
    routes,
  }
}

export function formatServer(s: ServerSummary): string {
  const head = ['route', 'n', 'p50', 'p95', 'max', 'limit', '']
  const rows = s.routes.map((r) => [
    r.route,
    String(r.n),
    r.p50Ms.toFixed(1),
    r.p95Ms.toFixed(1),
    r.maxMs.toFixed(1),
    r.asserted ? `<${r.budgetMs}` : '',
    !r.asserted
      ? 'not asserted'
      : r.spike
        ? 'ok (one spike)'
        : r.over
          ? 'OVER'
          : 'ok',
  ])
  const widths = head.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  )
  const fmt = (r: Array<string>) =>
    r
      .map((c, i) =>
        i === 0 || i === r.length - 1
          ? c.padEnd(widths[i])
          : c.padStart(widths[i]),
      )
      .join('  ')
      .trimEnd()
  return [
    'server time per route (Server-Timing total, ms; timed samples only):',
    fmt(head),
    ...rows.map(fmt),
  ].join('\n')
}
