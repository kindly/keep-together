import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from 'node:fs'
import path from 'node:path'
import { runDir } from './timing'
import type { HistoryLine } from './reporter'

// Set-up retries (qc/fixtures.ts): a set-up call that got no answer in
// time and was sent again. The retry keeps one stuck connection from
// failing a test (staging, 2026-10-25), but a hang that comes back must
// not hide behind it: each retry is written here, one file per worker
// process, and the reporter lists them in a SETUP RETRIES banner, marks a
// route retried on the run before too, and puts the counts on the run's
// history lines (`setupRetries`), whence the nightly's runs.log
// (`retries=`).

/** One retried set-up call. */
export interface SetupRetry {
  /** The route, e.g. `/api/qc/session`. */
  route: string
  instance: string
  /** The test it was for, or `worker setup`. */
  where: string
  /** Why the first try failed: the error's name (`TimeoutError`, `TypeError` …). */
  why: string
  /** Epoch ms of the first try's failure. */
  at: number
}

const PREFIX = 'retries-'

export function recordRetry(retry: SetupRetry): void {
  const dir = runDir()
  mkdirSync(dir, { recursive: true })
  appendFileSync(
    path.join(dir, `${PREFIX}${process.pid}.jsonl`),
    JSON.stringify(retry) + '\n',
  )
}

export function readRetries(dir: string): Array<SetupRetry> {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.startsWith(PREFIX) && f.endsWith('.jsonl'))
    .flatMap((f) =>
      readFileSync(path.join(dir, f), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as SetupRetry),
    )
}

/** Retries by route, for history (`setupRetries`). */
export function retryCounts(
  retries: Array<SetupRetry>,
): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const r of retries) counts[r.route] = (counts[r.route] ?? 0) + 1
  return counts
}

/**
 * The SETUP RETRIES banner: every retry of this run, by route, and which
 * routes the previous run of the same env (`past`, oldest first) retried
 * too. Nothing when no call was retried. Never fails the run.
 */
export function retryBanner(
  retries: Array<SetupRetry>,
  past: Array<Pick<HistoryLine, 'runId' | 'env' | 'setupRetries'>>,
  env: HistoryLine['env'],
): Array<string> {
  if (!retries.length) return []
  const prev = past
    .filter((l) => (l.env ?? 'local') === (env ?? 'local'))
    .at(-1)
  const before = prev?.setupRetries ?? {}
  const byRoute = new Map<string, Array<SetupRetry>>()
  for (const r of retries)
    byRoute.set(r.route, [...(byRoute.get(r.route) ?? []), r])
  const bar = '!'.repeat(72)
  return [
    bar,
    `!! SETUP RETRIES: ${retries.length} set-up call${retries.length === 1 ? '' : 's'} got no answer in time and ${retries.length === 1 ? 'was' : 'were'} sent again (qc/fixtures.ts). Passing, but a hang that recurs is a bug to chase:`,
    ...[...byRoute.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([route, rs]) => [
        `!! ${route}: ${rs.length}×${before[route] ? ` · ALSO RETRIED ON THE RUN BEFORE (${prev!.runId}: ${before[route]}×)` : ''}`,
        ...rs.map(
          (r) =>
            `!!   ${r.why} at ${new Date(r.at).toISOString().slice(11, 23)} UTC, ${r.instance}, ${r.where}`,
        ),
      ]),
    bar,
  ]
}
