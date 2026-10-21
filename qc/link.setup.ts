import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { median, runDir } from './timing'
import type { QcHook } from './global-setup'

// The first hop, watched for the whole run (a qc/global-setup.ts hook).
// One `ping` every 100 ms to the default gateway. On a Wi-Fi host the
// link to the access point freezes now and then (200–600 ms, sometimes a
// few seconds of 50–130 ms), and every request in flight, to every
// deployment, waits it out: a slow sample with the gateway slow too
// measured the room, not the app (factory/out/builder-qcstall.md).
//
// Context only, like the RTT: the reporter puts each sample's worst
// first-hop round trip on its history line (`linkMs`) and lists the
// over-budget samples that overlapped a stall, but judges nothing on it.
// Best effort: with no default route, no `ping`, or a ping that dies or
// never gets an answer, the run goes on, `link.json` says the link wasn't
// watched and why, and the reporter says so, so a missing LINK banner
// never reads as a clean link.

export const LINK_FILE = 'link.json'

export interface LinkFile {
  gateway: string | null
  /** False: nothing usable was measured; `why` says what went wrong. */
  watched: boolean
  why?: string
  /** [sent at (epoch ms), round trip ms], replies only, in send order. */
  pings: Array<[number, number]>
  /**
   * Echo requests never answered: [sent at, link back at], where "back"
   * is the first reply to arrive after it (or the end of the run).
   */
  lost: Array<[number, number]>
}

const INTERVAL_MS = 100

function defaultGateway(): string | null {
  try {
    const out = execFileSync('ip', ['-4', 'route', 'show', 'default'], {
      encoding: 'utf8',
    })
    return /\bvia (\S+)/.exec(out)?.[1] ?? null
  } catch {
    return null
  }
}

function writeLink(file: LinkFile) {
  const dir = runDir()
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, LINK_FILE), JSON.stringify(file) + '\n')
}

export const linkHook: QcHook = {
  name: 'link monitor',
  async setup() {
    const gateway = defaultGateway()
    if (!gateway) {
      const why = 'no default gateway'
      console.warn(`qc: ${why}; first-hop link not watched`)
      return async () => {
        writeLink({ gateway, watched: false, why, pings: [], lost: [] })
      }
    }
    // -O reports an unanswered request one interval after it went out.
    const replies = new Map<number, [number, number]>()
    const unanswered = new Map<number, number>()
    let died: string | null = null
    let stderr = ''
    let buf = ''
    const child = spawn(
      'ping',
      ['-D', '-n', '-O', '-i', String(INTERVAL_MS / 1000), gateway],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    child.on('error', (err) => {
      died ??= `ping failed to start: ${err.message}`
      console.warn(`qc: ${died}; first-hop link not watched`)
    })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-500)
    })
    child.on('exit', (code, signal) => {
      if (signal === 'SIGTERM') return
      const last = stderr.trim().split('\n').at(-1) ?? ''
      died ??= `ping exited (${signal ?? `code ${code}`})${last ? `: ${last}` : ''}`
      console.warn(`qc: ${died}; first-hop link not watched from here on`)
    })
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      buf += chunk
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        // [1792412052.386740] 64 bytes from …: icmp_seq=12 ttl=64 time=2.31 ms
        // [1792412052.386740] no answer yet for icmp_seq=13
        const m = /^\[(\d+\.\d+)\].*icmp_seq=(\d+)(?:.*time=([\d.]+) ms)?/.exec(
          line,
        )
        if (!m) continue
        const at = Number(m[1]) * 1000
        const seq = Number(m[2])
        if (line.includes(' time=')) {
          const rtt = Number(m[3])
          // -D stamps the reply; the request went out rtt earlier.
          replies.set(seq, [Math.round(at - rtt), rtt])
          unanswered.delete(seq)
        } else if (line.includes('no answer yet')) {
          unanswered.set(seq, Math.round(at - INTERVAL_MS))
        }
      }
    })
    const stopAll = () => child.kill('SIGTERM')
    process.on('exit', stopAll)
    return async () => {
      process.off('exit', stopAll)
      child.kill('SIGTERM')
      const end = Date.now()
      const pings = [...replies.values()].sort((a, b) => a[0] - b[0])
      const backs = pings.map(([s, r]) => s + r).sort((a, b) => a - b)
      const lost = [...unanswered.values()]
        .sort((a, b) => a - b)
        .map((sent): [number, number] => [
          sent,
          backs.find((b) => b > sent) ?? end,
        ])
      const why = pings.length
        ? undefined
        : (died ?? `no reply from ${gateway}`)
      writeLink({
        gateway,
        watched: pings.length > 0,
        ...(why && { why }),
        pings,
        lost,
      })
      if (why) {
        console.warn(`qc: first hop not watched: ${why}`)
        return
      }
      const ms = pings.map(([, r]) => r)
      const stalls = ms.filter((r) => r >= STALL_MS).length
      console.log(
        `first hop ${gateway}: ${pings.length} pings, p50 ${median(ms).toFixed(1)} ms, ` +
          `max ${Math.max(...ms).toFixed(0)} ms, ${stalls} at or over ${STALL_MS} ms, ${lost.length} unanswered` +
          (died ? ` (${died})` : ''),
      )
    }
  },
}

/** A first-hop round trip this slow is a link stall, not the app. */
export const STALL_MS = 50

/**
 * The worst first-hop round trip in flight during [from, to] (epoch ms):
 * a ping sent before the window ends whose reply came after it began. An
 * unanswered one counts from its send until the link answered again.
 * Null when no ping covers the window (no monitor, or a gap).
 */
export function linkDuring(
  link: Pick<LinkFile, 'pings'> & Partial<Pick<LinkFile, 'lost'>>,
  from: number,
  to: number,
): number | null {
  let worst: number | null = null
  const spans = [
    ...link.pings.map(([sent, rtt]): [number, number] => [sent, sent + rtt]),
    ...(link.lost ?? []),
  ]
  for (const [sent, back] of spans) {
    if (sent <= to && back >= from) worst = Math.max(worst ?? 0, back - sent)
  }
  return worst
}
