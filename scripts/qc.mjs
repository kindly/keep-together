#!/usr/bin/env node
// Prepare the QC pool and run the suite (ADR 0018; migration-rust F3).
//
//   node scripts/qc.mjs [--instances N] [--target staging] [--no-wait] [--no-build] [-- <command…>]
//
// `pnpm qc [playwright args]` runs it with `-- playwright test`; options
// may also come after the command (`pnpm qc --target staging`).
//
// Local (the gate):
// 1. Takes `.qc.lock` in the main checkout: the pool's ports are the
//    machine's, so runs from different worktrees queue. A lock whose pid
//    is dead is taken over; --no-wait (or QC_NO_WAIT=1) fails fast.
// 2. Builds the release `api` (rs/) and the SPA into dist-qc/.
// 3. Starts N = --instances (QC_INSTANCES, default 3) apis, each on
//    KEEP_PORT 8801+i with an empty data dir qc-data/<i>, dev auth and the
//    QC seed on, bound to 127.0.0.1.
// 4. Checks the RTT to each api against qc/rtt.json: QC times the app at
//    the hosted round trip, which `tc netem` on loopback adds
//    (scripts/qc-netem.sh, which needs root: the human runs it). Without
//    it an assert run fails; QC_NO_NETEM=1 runs anyway (local RTT, the
//    samples say so in history: `rttMs`).
// 5. Writes qc/.instances.json for playwright.config.ts (which serves the
//    build once per instance through qc/serve.mjs), runs <command…>, and
//    stops the apis when it exits.
//
// --target staging (the nightly): no build, no pool, no netem; one
// instance, the hosted `keep-staging` (QC_STAGING_URL), history lines
// marked `env: staging`. Staging must run with dev auth and the QC seed
// until A4 and B3 (it resets to the seed on every deploy).
//
// Runs outside the Claude sandbox: it binds ports and writes to the main
// checkout (the lock).
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { newToken, releaseLock, tryLock as tryLockFile } from './lockfile.mjs'

const API_PORT = 8801
const SERVE_PORT = 4301
const STAGING =
  process.env.QC_STAGING_URL ?? 'https://staging.keep-together.org.uk'

const root = path.resolve(import.meta.dirname, '..')
const mainCheckout = path.dirname(
  execFileSync(
    'git',
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    { cwd: root, encoding: 'utf8' },
  ).trim(),
)
const lockPath = path.join(mainCheckout, '.qc.lock')
// A lock older than this is stale even if its pid looks alive.
const LOCK_MAX_AGE_MS = 2 * 60 * 60 * 1000

const children = new Set()
let wrapped = null

function track(child) {
  children.add(child)
  child.on('close', () => children.delete(child))
  return child
}

function signalChildren(sig) {
  for (const child of children) {
    try {
      process.kill(-child.pid, sig)
    } catch {
      /* already gone */
    }
  }
}

export function parseArgs(argv, env = process.env) {
  const opts = {
    instances: Number(env.QC_INSTANCES ?? 3),
    target: 'local',
    wait: !env.QC_NO_WAIT,
    build: true,
    command: [],
  }
  const rest = []
  let inCommand = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    // Our own options are taken from anywhere, so `pnpm qc --target
    // staging` (appended after `-- playwright test`) works.
    if (a === '--target') opts.target = argv[++i]
    else if (a.startsWith('--target=')) opts.target = a.slice(9)
    else if (a === '--') inCommand = true
    else if (inCommand) rest.push(a)
    else if (a === '--no-wait') opts.wait = false
    else if (a === '--no-build') opts.build = false
    else if (a === '--instances') opts.instances = Number(argv[++i])
    else throw new Error(`unknown argument ${a}`)
  }
  opts.command = rest
  if (!Number.isInteger(opts.instances) || opts.instances < 1)
    throw new Error('--instances must be a positive integer')
  if (!['local', 'staging'].includes(opts.target))
    throw new Error(`--target is local or staging, not ${opts.target}`)
  return opts
}

const ms = (start) => `${Math.round(performance.now() - start)} ms`

// ── lock ────────────────────────────────────────────────────────────────

const lockToken = newToken()

async function acquireLock(wait) {
  let announced = false
  for (;;) {
    const holder = tryLockFile(
      lockPath,
      {
        pid: process.pid,
        worktree: root,
        startedAt: new Date().toISOString(),
        token: lockToken,
      },
      { maxAgeMs: LOCK_MAX_AGE_MS, label: 'QC lock' },
    )
    if (!holder) break
    const who = `pid ${holder.pid}, ${holder.worktree ?? '?'}, since ${holder.startedAt ?? '?'}`
    if (!wait) throw new Error(`QC lock is held (${who}): ${lockPath}`)
    if (!announced) console.log(`▸ waiting for QC lock (${who})`)
    announced = true
    await new Promise((r) => setTimeout(r, 2000))
  }
  const release = () => {
    signalChildren('SIGTERM')
    releaseLock(lockPath, (lock) => lock?.token === lockToken)
  }
  process.on('exit', release)
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      signalChildren(sig)
      if (wrapped) return
      release()
      process.exit(128 + os.constants.signals[sig])
    })
  }
}

// ── build and pool ──────────────────────────────────────────────────────

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = track(
      spawn(cmd, args, {
        cwd: opts.cwd ?? root,
        env: opts.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      }),
    )
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0
        ? resolve(out)
        : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}:\n${out}`)),
    )
  })
}

async function timed(label, fn) {
  const start = performance.now()
  await fn()
  console.log(`  ${label} ${ms(start)}`)
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** Median of 10 kept-alive `GET /api/me` round trips (answered 401). */
async function rtt(api) {
  const times = []
  for (let i = 0; i <= 10; i++) {
    const t = performance.now()
    await (await fetch(`${api}/api/me`)).arrayBuffer()
    if (i > 0) times.push(performance.now() - t)
  }
  return Math.round(median(times) * 10) / 10
}

async function startApi(i, bin) {
  const port = API_PORT + i
  const dataDir = path.join(root, 'qc-data', String(i))
  rmSync(dataDir, { recursive: true, force: true })
  mkdirSync(dataDir, { recursive: true })
  const child = track(
    spawn(bin, [], {
      cwd: root,
      env: {
        ...process.env,
        KEEP_PORT: String(port),
        KEEP_DATA_DIR: dataDir,
        KEEP_DEV_AUTH: '1',
        KEEP_QC_SEED: '1',
        RUST_LOG: process.env.RUST_LOG ?? 'warn',
      },
      stdio: ['ignore', 'inherit', 'inherit'],
      detached: true,
    }),
  )
  const api = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 30_000
  for (;;) {
    if (child.exitCode !== null)
      throw new Error(`api qc-${i + 1} exited ${child.exitCode}`)
    try {
      await fetch(`${api}/api/me`)
      return api
    } catch {
      if (Date.now() > deadline)
        throw new Error(`api qc-${i + 1} not up on ${api} after 30 s`)
      await new Promise((r) => setTimeout(r, 100))
    }
  }
}

async function localPool(opts) {
  const bin = path.join(root, 'rs', 'target', 'release', 'api')
  if (opts.build) {
    console.log('▸ building the release api and the SPA in parallel')
    const vite = path.join(root, 'node_modules/.bin/vite')
    await Promise.all([
      timed('cargo build --release -p api', () =>
        run('cargo', ['build', '--release', '-p', 'api'], {
          cwd: path.join(root, 'rs'),
        }),
      ),
      timed('vite build', () =>
        run(vite, ['build', '--outDir', 'dist-qc', '--emptyOutDir']),
      ),
    ])
  }
  const ids = Array.from({ length: opts.instances }, (_, i) => i)
  const apis = await Promise.all(ids.map((i) => startApi(i, bin)))
  const pool = ids.map((i) => ({
    name: `qc-${i + 1}`,
    api: apis[i],
    baseURL: `http://localhost:${SERVE_PORT + i}`,
    servePort: SERVE_PORT + i,
    serveDir: 'dist-qc',
  }))

  // The round trip QC is meant to run at (qc/rtt.json), against what
  // loopback gives now.
  const { rttMs: want } = JSON.parse(
    readFileSync(path.join(root, 'qc', 'rtt.json'), 'utf8'),
  )
  const got = await Promise.all(pool.map((p) => rtt(p.api)))
  console.log(
    `▸ RTT to the apis: ${got.map((x, i) => `${pool[i].name} ${x} ms`).join(', ')} (target ${want} ms, qc/rtt.json)`,
  )
  const netem = got.every((x) => x >= want * 0.8)
  if (!netem) {
    const msg = `netem is off: the apis answer in ${median(got)} ms, not ~${want} ms. Run \`sudo scripts/qc-netem.sh on ${opts.instances}\` (the human), or QC_NO_NETEM=1 to time at loopback.`
    if (!process.env.QC_NO_NETEM && process.env.QC_MODE !== 'record')
      throw new Error(msg)
    console.log(`!! ${msg} Running anyway.`)
  }
  return pool
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const total = performance.now()
  let pool
  if (opts.target === 'staging') {
    pool = [{ name: 'staging', api: STAGING, baseURL: STAGING }]
    console.log(`▸ target: staging, ${STAGING} (no netem, no local pool)`)
  } else {
    await acquireLock(opts.wait)
    pool = await localPool(opts)
  }
  writeFileSync(
    path.join(root, 'qc/.instances.json'),
    JSON.stringify(pool, null, 2) + '\n',
  )
  console.log(
    `✔ pool ready in ${ms(total)}: ${pool.map((p) => `${p.name}=${p.api}`).join(' ')}`,
  )
  if (!opts.command.length) {
    // Holding the pool for manual runs: until interrupted.
    if (opts.target === 'local') {
      console.log('  apis running; Ctrl-C stops them')
      await new Promise(() => {})
    }
    return
  }
  const [cmd, ...args] = opts.command
  const child = (wrapped = track(
    spawn(cmd, args, {
      cwd: root,
      stdio: 'inherit',
      detached: true,
      env: {
        ...process.env,
        QC_TARGET: opts.target,
        PATH: `${path.join(root, 'node_modules/.bin')}:${process.env.PATH}`,
      },
    }),
  ))
  const code = await new Promise((resolve) => {
    child.on('error', (err) => {
      console.error(err.message)
      resolve(1)
    })
    child.on('close', (c) => resolve(c ?? 1))
  })
  process.exit(code)
}

if (import.meta.main ?? process.argv[1] === import.meta.filename)
  main().catch((err) => {
    console.error(`qc: ${err.message}`)
    process.exit(1)
  })
