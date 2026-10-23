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
