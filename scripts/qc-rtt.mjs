#!/usr/bin/env node
// The round trip QC runs at (qc/rtt.json): the median of 50 TCP connects
// from this machine to keep-staging (migration-rust F3). A connect is one
// round trip, with no TLS or server time in it.
//
//   node scripts/qc-rtt.mjs [--host staging.keep-together.org.uk] [--write]
import { writeFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? dflt : process.argv[i + 1]
}
const host = arg('host', 'staging.keep-together.org.uk')
const port = Number(arg('port', 443))

const connect = () =>
  new Promise((resolve, reject) => {
    const t = performance.now()
    const s = net.connect({ host, port }, () => {
      resolve(performance.now() - t)
      s.destroy()
    })
    s.setTimeout(5000, () => s.destroy(new Error('timeout')))
    s.on('error', reject)
  })

const times = []
// The first resolves DNS: not counted.
await connect()
for (let i = 0; i < 50; i++) times.push(await connect())
times.sort((a, b) => a - b)
const rttMs = Math.round(times[25] * 10) / 10
console.log(`${host}:${port}: median TCP connect ${rttMs} ms over 50`)
if (process.argv.includes('--write')) {
  const file = path.join(import.meta.dirname, '..', 'qc', 'rtt.json')
  writeFileSync(
    file,
    JSON.stringify(
      {
        rttMs,
        source: `median of 50 TCP connects to ${host}:${port}, ${new Date().toISOString().slice(0, 10)} (scripts/qc-rtt.mjs)`,
      },
      null,
      2,
    ) + '\n',
  )
  console.log(`written to ${file}`)
}
