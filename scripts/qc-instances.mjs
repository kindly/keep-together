#!/usr/bin/env node
// Prepare the QC pool (ADR 0018, factory/plans/qc-suite.sv step 2).
//
//   node scripts/qc-instances.mjs [--instances N] [--reset] [--no-wait] [-- <command…>]
//
// 1. Takes `.qc.lock` in the main checkout, so runs from different
//    worktrees queue instead of pushing different code to the same
//    instances. A lock whose pid is dead is taken over; --no-wait (or
//    QC_NO_WAIT=1, for `pnpm qc`) fails fast instead of waiting.
// 2. Ensures dev/qc-1..N exist (N = --instances, QC_INSTANCES, or 3). A
//    missing one is created in the EU with Convex Auth keys and a deploy
//    key, saved to `.env.qc-<i>.local` in the main checkout.
//    Every run sets QC_SEED_ENABLED=1 on each instance (the seed's gate).
// 3. --reset: replaces each instance's data with an empty snapshot.
// 4. Pushes this checkout's code to every instance in parallel with
//    `convex deploy` and its deploy key (never `convex dev`, which rewrites
//    .env.local), and builds `dist-qc/qc-<i>` against each URL.
// 5. Writes qc/.instances.json for playwright.config.ts.
// 6. Runs <command…> if given (`pnpm qc` passes `playwright test`) and
//    holds the lock until it exits.
//
// Must run outside the Claude sandbox: it writes to the main checkout, and
// `pnpm qc` needs WebSockets.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createInstance as createKeyInstance,
  emptySnapshot,
  keyEnv as deployKeyEnv,
  loadKeyFile,
  verifyDeployKey,
} from './convex-instance.mjs'
import { newToken, releaseLock, tryLock as tryLockFile } from './lockfile.mjs'

const PROJECT = 'mr-raznick:keep-together'
const BASE_PORT = 4100

const root = path.resolve(import.meta.dirname, '..')
const mainCheckout = path.dirname(
  execFileSync(
    'git',
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    { cwd: root, encoding: 'utf8' },
  ).trim(),
)
const lockPath = path.join(mainCheckout, '.qc.lock')
// The env files live in the main checkout; QC_ENV_DIR points elsewhere,
// which the pool check's own test uses.
const envDir = process.env.QC_ENV_DIR ?? mainCheckout
// A lock older than this is stale even if its pid looks alive (pid reuse,
// or another user's process answering EPERM).
const LOCK_MAX_AGE_MS = 2 * 60 * 60 * 1000
// Never a pool member, whatever an env file says: the human's own dev
// deployment.
const DENIED = new Set(['zany-bird-247'])

// Children we spawn, each in its own process group, so a signal to this
// process alone (`kill <pid>`) still stops them before the lock goes.
const children = new Set()
// The wrapped command (`playwright test`); a signal is forwarded to it and
// the lock is released when it exits.
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

function parseArgs(argv) {
  const opts = {
    instances: Number(process.env.QC_INSTANCES ?? 3),
    reset: false,
    wait: !process.env.QC_NO_WAIT,
    command: [],
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') {
      opts.command = argv.slice(i + 1)
      break
    } else if (a === '--reset') opts.reset = true
    else if (a === '--no-wait') opts.wait = false
    else if (a === '--instances') opts.instances = Number(argv[++i])
    else throw new Error(`unknown argument ${a}`)
  }
  if (!Number.isInteger(opts.instances) || opts.instances < 1) {
    throw new Error('--instances must be a positive integer')
  }
  return opts
}

const ms = (start) => `${Math.round(performance.now() - start)} ms`

// ── lock ────────────────────────────────────────────────────────────────

const lockToken = newToken()

function tryLock() {
  return tryLockFile(
    lockPath,
    {
      pid: process.pid,
      worktree: root,
      startedAt: new Date().toISOString(),
      token: lockToken,
    },
    { maxAgeMs: LOCK_MAX_AGE_MS, label: 'QC lock' },
  )
}

async function acquireLock(wait) {
  let announced = false
  for (;;) {
    const holder = tryLock()
    if (!holder) break
    const who = `pid ${holder.pid}, ${holder.worktree ?? '?'}, since ${holder.startedAt ?? '?'}`
    if (!wait) throw new Error(`QC lock is held (${who}): ${lockPath}`)
    if (!announced) console.log(`▸ waiting for QC lock (${who})`)
    announced = true
    await new Promise((r) => setTimeout(r, 2000))
  }
  const release = () => {
    releaseLock(lockPath, (lock) => lock?.token === lockToken)
  }
  process.on('exit', release)
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      signalChildren(sig)
      // The wrapped command's close handler exits (and releases) for us.
      if (wrapped) return
      release()
      process.exit(128 + os.constants.signals[sig])
    })
  }
}

// ── instances ───────────────────────────────────────────────────────────

function envFile(i) {
  return path.join(envDir, `.env.qc-${i}.local`)
}

function loadInstance(i) {
  return {
    name: `qc-${i}`,
    ...loadKeyFile(envFile(i), { denied: DENIED, role: 'a QC instance' }),
    port: BASE_PORT + i,
    outDir: `dist-qc/qc-${i}`,
  }
}

// Prove each key is its slot's (dev/qc-<i>) before anything writes with it.
async function verifyPool(pool) {
  await Promise.all(
    pool.map((inst) =>
      verifyDeployKey(
        `${PROJECT}:dev/${inst.name}`,
        inst.deployment,
        inst.envFile,
      ),
    ),
  )
}

function createInstance(i) {
  return createKeyInstance({
    ref: `${PROJECT}:dev/qc-${i}`,
    tokenName: `qc-${i}-push`,
    siteUrl: `http://localhost:${BASE_PORT + i}`,
    envFile: envFile(i),
    comment: `dev/qc-${i}: QC pool instance (scripts/qc-instances.mjs)`,
    cwd: root,
    onSpawn: track,
  })
}

const keyEnv = (inst) => deployKeyEnv(inst.key)

function run(cmd, args, env) {
  return new Promise((resolve, reject) => {
    const child = track(
      spawn(cmd, args, {
        cwd: root,
        env,
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

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  await acquireLock(opts.wait)
  const total = performance.now()

  const ids = Array.from({ length: opts.instances }, (_, k) => k + 1)
  for (const i of ids) {
    if (!existsSync(envFile(i))) await createInstance(i)
  }
  const pool = ids.map(loadInstance)
  await verifyPool(pool)
  console.log(
    `▸ pool: ${pool.map((p) => `${p.name}=${p.deployment}`).join(' ')}`,
  )

  if (opts.reset) {
    const zip = emptySnapshot('qc')
    console.log('▸ resetting data (import --replace-all of an empty snapshot)')
    await Promise.all(
      pool.map((inst) =>
        timed(`reset ${inst.name}`, () =>
          run(
            'npx',
            ['convex', 'import', '--replace-all', '-y', zip],
            keyEnv(inst),
          ),
        ),
      ),
    )
    unlinkSync(zip)
  }

  // Generated files are committed and current, so no codegen: N pushes
  // writing convex/_generated at once would race.
  console.log('▸ pushing and building in parallel')
  const vite = path.join(root, 'node_modules/.bin/vite')
  const work = performance.now()
  await Promise.all([
    timed('push (all)', () =>
      Promise.all(
        pool.map((inst) =>
          timed(`push ${inst.name}`, async () => {
            // platform/qcSeed refuses to run where this isn't set, so it
            // can never create accounts outside the pool. Set every run:
            // it is idempotent and keeps older instances in step.
            await run(
              'npx',
              ['convex', 'env', 'set', 'QC_SEED_ENABLED', '1'],
              keyEnv(inst),
            )
            await run(
              'npx',
              ['convex', 'deploy', '--codegen', 'disable', '-y'],
              keyEnv(inst),
            )
          }),
        ),
      ),
    ),
    timed('build (all)', () =>
      Promise.all(
        pool.map((inst) =>
          timed(`build ${inst.name}`, () =>
            run(vite, ['build', '--outDir', inst.outDir, '--emptyOutDir'], {
              ...process.env,
              VITE_CONVEX_URL: inst.url,
            }),
          ),
        ),
      ),
    ),
  ])
  console.log(`  push + build wall ${ms(work)}`)

  // Keys stay in the main checkout; the harness reads them from envFile.
  mkdirSync(path.join(root, 'qc'), { recursive: true })
  writeFileSync(
    path.join(root, 'qc/.instances.json'),
    JSON.stringify(
      pool.map(({ key: _key, ...inst }) => inst),
      null,
      2,
    ) + '\n',
  )
  console.log(`✔ pool ready in ${ms(total)}: qc/.instances.json`)

  if (opts.command.length) {
    const [cmd, ...args] = opts.command
    const child = (wrapped = track(
      spawn(cmd, args, {
        cwd: root,
        stdio: 'inherit',
        detached: true,
        env: {
          ...process.env,
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
}

main().catch((err) => {
  console.error(`qc-instances: ${err.message}`)
  process.exit(1)
})
