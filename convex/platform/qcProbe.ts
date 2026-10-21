/**
 * The QC harness's round-trip probe (qc/timing.ts: probeRtt and the
 * per-worker RTT monitor). Public, reads nothing and returns nothing, so
 * after its first call Convex answers it from the query cache and the
 * round trip measures the socket, not the server. Its own name keeps the
 * probes out of the app's rows in QC's server timings
 * (qc/server-timings.ts drops it like its liveness pings).
 */
import { query } from '../_generated/server'

export const rtt = query({
  args: {},
  handler: () => null,
})
