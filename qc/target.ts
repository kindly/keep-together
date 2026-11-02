import type { HistoryLine } from './reporter'

// Targets: tracked, never failed (human, 2026-10-23; ADR 0018 amendment).
// A flow with a `targetMs` (qc/budgets.ts) is flagged when its median is
// at or over the target, or when its median rose by DRIFT_MS or more
// against the median of its medians over its last DRIFT_RUNS runs in
// history (same flow, same kind, RTT under the ceiling). The run summary
// lists every flagged flow in a TARGET banner, and the trend report marks
// it. Pass and fail only ever depend on the failing line (`maxMs`).
//
// Node loads this file directly (scripts/qc-report.mjs via qc/trend.ts):
// type-only imports, nothing that needs transpiling.

/** About one frame at 60 Hz. */
export const DRIFT_MS = 16
/** Runs of history the drift is measured against. */
export const DRIFT_RUNS = 5

export interface TargetCheck {
  /** The median is at or over the target. */
  overTarget: boolean
  /** Median of the flow's medians over its last DRIFT_RUNS runs; null with none. */
  baselineMs: number | null
  /** This run's median less baselineMs; null with no history. */
  riseMs: number | null
  /** overTarget, or riseMs ≥ DRIFT_MS. Never fails the run. */
  flagged: boolean
}

function median(xs: Array<number>): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/**
 * Check one flow's line against its target and its history (`past`, in
 * file order, oldest first). Undefined for a flow with no target, or one
 * whose samples measured a slow link.
 */
export function checkTarget(
  line: Pick<HistoryLine, 'flow' | 'kind' | 'p50Ms' | 'rttOver' | 'runId'> & {
    targetMs?: number
  },
  past: Array<HistoryLine>,
): TargetCheck | undefined {
  if (line.targetMs === undefined || line.rttOver) return undefined
  const recent = past
    .filter(
      (l) =>
        l.flow === line.flow &&
        l.kind === line.kind &&
        l.runId !== line.runId &&
        !l.rttOver,
    )
    .slice(-DRIFT_RUNS)
  const baselineMs = recent.length ? median(recent.map((l) => l.p50Ms)) : null
  const riseMs = baselineMs === null ? null : line.p50Ms - baselineMs
  const overTarget = line.p50Ms >= line.targetMs
  return {
    overTarget,
    baselineMs,
    riseMs,
    flagged: overTarget || (riseMs !== null && riseMs >= DRIFT_MS),
  }
}

/** Why a flagged flow is flagged, in a few words. */
export function targetReason(
  l: Pick<HistoryLine, 'p50Ms' | 'targetMs' | 'target'>,
): string {
  const t = l.target!
  const r = Math.round
  return [
    ...(t.overTarget ? [`median ${r(l.p50Ms)} ≥ target ${l.targetMs}`] : []),
    ...(t.riseMs !== null && t.riseMs >= DRIFT_MS
      ? [
          `median ${r(l.p50Ms)} up ${r(t.riseMs)} on ${r(t.baselineMs!)} (last ${DRIFT_RUNS} runs)`,
        ]
      : []),
  ].join('; ')
}

// ── Where QC runs ───────────────────────────────────────────────────────
//
// The other kind of target: the app a run is pointed at (scripts/qc.mjs
// `--target`, which passes it on to Playwright and its workers as
// QC_TARGET):
//
// - `local`: the gate, a pool of local release apis (the default).
// - `staging`: keep-staging. Unused since the house nightly retired (plan
//   gocardless-sandbox-qc.sv, R1): staging has no QC token (S1b).
// - `qc`: keep-qc, QC's own app, from GitHub Actions (.github/workflows/
//   qc.yml; plan gocardless-sandbox-qc.sv, A2). Its origin is
//   QC_TARGET_URL. The runner isn't the house: its budgets are its own
//   (qc/budgets.ts, `targetBudgets`), and the first-hop watch is off.
//
// A hosted target has no dev auth: set-up goes through its token surface
// (`/api/qc/*`) with KEEP_QC_TOKEN, which stays in the env.

export type QcTarget = 'local' | 'staging' | 'qc'
export const QC_TARGETS: ReadonlyArray<QcTarget> = ['local', 'staging', 'qc']

/** The hosted targets: the env variable naming each one's origin, and its default. */
export const HOSTED = {
  staging: {
    urlEnv: 'QC_STAGING_URL',
    defaultUrl: 'https://staging.keep-together.org.uk',
  },
  qc: { urlEnv: 'QC_TARGET_URL', defaultUrl: 'https://keep-qc.fly.dev' },
} as const satisfies Record<
  Exclude<QcTarget, 'local'>,
  { urlEnv: string; defaultUrl: string }
>

export function isQcTarget(x: unknown): x is QcTarget {
  return QC_TARGETS.includes(x as QcTarget)
}

/** The target this process runs against (QC_TARGET; unset is `local`). */
export function qcTarget(
  env: Record<string, string | undefined> = process.env,
): QcTarget {
  const t = env.QC_TARGET ?? 'local'
  if (!isQcTarget(t))
    throw new Error(`QC_TARGET is ${QC_TARGETS.join(', ')}, not ${t}`)
  return t
}

/** A hosted target's origin: its env variable, else its default; no trailing slash. */
export function hostedUrl(
  target: Exclude<QcTarget, 'local'>,
  env: Record<string, string | undefined> = process.env,
): string {
  const { urlEnv, defaultUrl } = HOSTED[target]
  const url = (env[urlEnv] || defaultUrl).replace(/\/+$/, '')
  if (!/^https?:\/\/[^/\s]+$/.test(url))
    throw new Error(`${urlEnv} must be an origin (https://host), not ${url}`)
  return url
}

/**
 * Playwright's per-test limit on this process's target (playwright.config.ts).
 * Locally (house netem RTT, ~13 ms) Playwright's 30 s stays, so a hang shows
 * up fast. A hosted target is reached over a real link (keep-qc from
 * Actions: 90-190 ms), and a test whose samples each set up over sequential
 * round trips (a warm-up, 5 samples, 5 more on a re-measure) scales with it:
 * at over ~110 ms the claim steps and accept ticked ran out of 30 s with
 * every call answered (builder-stl, 2026-11-01). A test's own setTimeout
 * still wins.
 */
export const TEST_TIMEOUT_MS = { local: 30_000, hosted: 120_000 } as const

export function testTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  return qcTarget(env) === 'local'
    ? TEST_TIMEOUT_MS.local
    : TEST_TIMEOUT_MS.hosted
}
