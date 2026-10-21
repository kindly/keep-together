import recorded from './blame.fixture.json'
import type { BlameSample, Probe, ServerCall } from './blame'

// Recorded slow samples (qc-results of runs tn9ttz4a, tn9g1x25 and
// tn9vwfeq), each with every Convex call on the pool within 600 ms of it
// and every RTT probe of its worker in that run. The first four predate
// `fns`, so their fixtures add the function the flow calls (the one call
// of it in the window); tn9vwfeq recorded its own.
export interface Case {
  run: string
  flow: string
  budgetMs: number
  sample: BlameSample
  calls: Array<ServerCall>
  probes: Array<Probe>
}
export const cases = recorded as unknown as Record<
  'normal' | 'slowFunction' | 'linkStall' | 'slowSpell' | 'stallElsewhere',
  Case
>
// They also predate `subs`: give each page the queries that re-ran on its
// instance between its commit and its Transition, as the tap would.
for (const c of Object.values(cases)) {
  const s = c.sample
  const commit = s.at + s.commitMs!
  c.sample = {
    ...s,
    subs: [
      ...new Set(
        c.calls
          .filter(
            (x) =>
              x.instance === s.instance &&
              x.type === 'Query' &&
              x.at - x.ms >= commit - 10 &&
              x.at <= s.at + s.transitionMs! + 10,
          )
          .map((x) => x.fn),
      ),
    ],
  }
}
