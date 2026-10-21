import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
} from 'node:fs'
import path from 'node:path'
import { blame, SPELL } from './blame'
import type {
  Blame,
  BlameContext,
  BlameSample,
  Probe,
  ServerCall,
} from './blame'
import { LIVE_LINK_FILE, linkDuring } from './link.setup'
import { LIVE_CALLS_FILE } from './server-timings'

// Blame while the run is still going, in the worker, so a slow sample can
// be judged before the test moves on (human, 2026-10-21). The run's
// collectors append as they go (server-timings.ts, link.setup.ts); this
// tails those files. `convex logs` lags, so before reading, the worker
// pings every pool instance with the probe query and waits until each
// stream has shown a call that completed after the sample's window (the
// spell rule looks SPELL.windowMs past it). A stream that doesn't catch up
// in time leaves calls missing: the function goes unmatched, the verdict
// unclear, and unclear counts as ours. Waiting can only cost time, never
// excuse a sample.

/** How long a slow sample may wait for the log streams to catch up. */
export const CATCH_UP_TIMEOUT_MS = 8_000
const POLL_MS = 100
const PROBE = 'platform/qcProbe:rtt'

type LiveCall = ServerCall & { mark?: true }

/** Lines appended to a file since the last read, parsed; torn lines wait. */
class Tail<T> {
  private offset = 0
  private rest = ''
  readonly items: Array<T> = []
  skipped = 0
  constructor(private file: string) {}

  read(): Array<T> {
    if (!existsSync(this.file)) return this.items
    const fd = openSync(this.file, 'r')
    try {
      const size = fstatSync(fd).size
      if (size > this.offset) {
        const buf = Buffer.alloc(size - this.offset)
        readSync(fd, buf, 0, buf.length, this.offset)
        this.offset = size
        const lines = (this.rest + buf.toString('utf8')).split('\n')
        // The last piece has no newline yet: a line still being written.
        this.rest = lines.pop() ?? ''
        for (const l of lines) {
          if (!l) continue
          try {
            this.items.push(JSON.parse(l) as T)
          } catch {
            this.skipped++
          }
        }
      }
    } finally {
      closeSync(fd)
    }
    return this.items
  }
}

interface PoolInstance {
  name: string
  url: string
}

export class LiveRun {
  private calls: Tail<LiveCall>
  private link: Tail<[seq: number, sent: number, rtt: number | null]>
  private probes = new Map<string, Tail<Probe>>()

  /** `dir`: the run directory (runDir() in a worker). */
  constructor(
    private dir: string,
    private pool: Array<PoolInstance> = readPool(),
  ) {
    this.calls = new Tail(path.join(dir, LIVE_CALLS_FILE))
    this.link = new Tail(path.join(dir, LIVE_LINK_FILE))
  }

  /** The latest call (or mark) each instance's stream has shown, server clock. */
  private reached(): Map<string, number> {
    const out = new Map<string, number>()
    for (const c of this.calls.read())
      out.set(c.instance, Math.max(out.get(c.instance) ?? 0, c.at))
    return out
  }

  /**
   * Ping every instance and wait until each stream has passed `until`
   * (epoch ms). True when all did within the timeout.
   */
  async catchUp(until: number, timeoutMs = CATCH_UP_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs
    const behind = () =>
      this.pool.filter((i) => (this.reached().get(i.name) ?? 0) < until)
    let lastPing = 0
    while (behind().length) {
      if (Date.now() > deadline) return false
      // A ping completes after `until` once the clock has passed it.
      if (Date.now() >= until && Date.now() - lastPing > 1_000) {
        lastPing = Date.now()
        await Promise.all(behind().map((i) => ping(i.url)))
      }
      await new Promise((r) => setTimeout(r, POLL_MS))
    }
    return true
  }

  /** Wait until the first hop has answered a ping sent after `until`. */
  async linkPast(until: number, timeoutMs = 2_000) {
    if (!existsSync(path.join(this.dir, LIVE_LINK_FILE))) return
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (
        this.link.read().some(([, sent, rtt]) => rtt !== null && sent > until)
      )
        return
      await new Promise((r) => setTimeout(r, POLL_MS))
    }
  }

  /** The worst first-hop round trip in [from, to], or null without a monitor. */
  linkMs(from: number, to: number): number | null {
    const all = this.link.read()
    if (!all.length) return null
    const pings = all.flatMap(([, sent, rtt]): Array<[number, number]> =>
      rtt === null ? [] : [[sent, rtt]],
    )
    const backs = pings.map(([s, r]) => s + r).sort((a, b) => a - b)
    // An echo reported unanswered and answered later is in both: the
    // reply wins. Still unanswered: lost until the link answered again.
    const answered = new Set(
      all.flatMap(([seq, , rtt]) => (rtt === null ? [] : [seq])),
    )
    const lost = all.flatMap(([seq, sent, rtt]): Array<[number, number]> =>
      rtt !== null || answered.has(seq)
        ? []
        : [[sent, backs.find((b) => b > sent) ?? Date.now()]],
    )
    return linkDuring({ pings, lost }, from, to)
  }

  context(): BlameContext {
    for (const f of existsSync(this.dir) ? readdirSync(this.dir) : []) {
      if (f.startsWith('rtt-') && f.endsWith('.jsonl') && !this.probes.has(f))
        this.probes.set(f, new Tail(path.join(this.dir, f)))
    }
    const probes = [...this.probes.values()].flatMap((t) => t.read())
    const calls = this.calls.read().filter((c) => !c.mark)
    const skipped =
      this.calls.skipped +
      [...this.probes.values()].reduce((n, t) => n + t.skipped, 0)
    return { calls, probes, skipped }
  }

  /**
   * Blame one sample now: wait for the streams and the link, then read.
   * `caughtUp: false` means calls may be missing (the verdict leans ours).
   */
  async blame(
    s: BlameSample,
  ): Promise<{ blame: Blame; caughtUp: boolean; waitedMs: number }> {
    const t = Date.now()
    const end = s.at + s.endMs
    const [caughtUp] = await Promise.all([
      this.catchUp(end + SPELL.windowMs),
      this.linkPast(end),
    ])
    const linkMs = this.linkMs(s.at, end)
    return {
      blame: blame({ ...s, linkMs }, this.context()),
      caughtUp,
      waitedMs: Date.now() - t,
    }
  }
}

function readPool(): Array<PoolInstance> {
  try {
    return (
      JSON.parse(
        readFileSync('qc/.instances.json', 'utf8'),
      ) as Array<PoolInstance>
    ).map(({ name, url }) => ({ name, url }))
  } catch {
    return []
  }
}

/** The probe query over HTTP: it shows in the log stream, and nothing else counts it. */
async function ping(url: string) {
  try {
    await fetch(`${url}/api/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: PROBE, args: {}, format: 'json' }),
      signal: AbortSignal.timeout(3_000),
    })
  } catch {
    // The stream decides; catchUp pings again.
  }
}
