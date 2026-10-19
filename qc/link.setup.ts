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
// Best effort: with no default route or no `ping`, the run goes on
// without it and says so.

export const LINK_FILE = 'link.json'

export interface LinkFile {
  gateway: string
  /** [sent at (epoch ms), round trip ms], replies only. */
  pings: Array<[number, number]>
  /** Echo requests with no reply by the end. */
  lost: number
}

const INTERVAL_S = 0.1

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

export const linkHook: QcHook = {
  name: 'link monitor',
  async setup() {
    const gateway = defaultGateway()
    if (!gateway) {
      console.warn('qc: no default gateway; first-hop link not watched')
      return
    }
    const pings: Array<[number, number]> = []
    let lastSeq = 0
    let buf = ''
    const child = spawn(
      'ping',
      ['-D', '-n', '-i', String(INTERVAL_S), gateway],
      {
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    )
    child.on('error', () => {
      console.warn(
        `qc: ping ${gateway} failed to start; first-hop link not watched`,
      )
    })
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      buf += chunk
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        // [1792412052.386740] 64 bytes from …: icmp_seq=12 ttl=64 time=2.31 ms
        const m = /^\[(\d+\.\d+)\].*icmp_seq=(\d+).*time=([\d.]+) ms/.exec(line)
        if (!m) continue
        const rtt = Number(m[3])
        // -D stamps the reply; the request went out rtt earlier.
        pings.push([Math.round(Number(m[1]) * 1000 - rtt), rtt])
        lastSeq = Math.max(lastSeq, Number(m[2]))
      }
    })
    const stopAll = () => child.kill('SIGTERM')
    process.on('exit', stopAll)
    return async () => {
      process.off('exit', stopAll)
      child.kill('SIGTERM')
      if (!pings.length) return
      const file: LinkFile = { gateway, pings, lost: lastSeq - pings.length }
      const dir = runDir()
      mkdirSync(dir, { recursive: true })
      writeFileSync(path.join(dir, LINK_FILE), JSON.stringify(file) + '\n')
      const ms = pings.map(([, r]) => r)
      const stalls = ms.filter((r) => r >= STALL_MS).length
      console.log(
        `first hop ${gateway}: ${pings.length} pings, p50 ${median(ms).toFixed(1)} ms, ` +
          `max ${Math.max(...ms).toFixed(0)} ms, ${stalls} at or over ${STALL_MS} ms, ${file.lost} lost`,
      )
    }
  },
}

/** A first-hop round trip this slow is a link stall, not the app. */
export const STALL_MS = 50

/**
 * The worst first-hop round trip in flight during [from, to] (epoch ms):
 * a ping sent before the window ends whose reply came after it began.
 * Null when no ping covers the window (no monitor, or a gap).
 */
export function linkDuring(
  link: Pick<LinkFile, 'pings'>,
  from: number,
  to: number,
): number | null {
  let worst: number | null = null
  for (const [sent, rtt] of link.pings) {
    if (sent > to) break
    if (sent + rtt >= from) worst = Math.max(worst ?? 0, rtt)
  }
  return worst
}
