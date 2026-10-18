#!/usr/bin/env node
// Two fixed, reusable rehearsal deployments (README "Rehearsal slots"):
// dev/rehearsal-1 and dev/rehearsal-2, for trying a migration, an old
// commit or a seed against a real backend without making a new deployment
// each time (the CLI can't delete them).
//
//   node scripts/rehearsal.mjs claim [--slot N] [--pid P]
//   node scripts/rehearsal.mjs run <slot> [--cwd DIR] -- <convex args…>
//   node scripts/rehearsal.mjs release <slot> [--force]
//   node scripts/rehearsal.mjs status
//
// claim takes `.rehearsal-<n>.lock` in the main checkout (the first free
// slot, or --slot), creates dev/rehearsal-<n> on first use (EU, auth keys,
// a deploy key in `.env.rehearsal-<n>.local`, mode 600, in the main
// checkout), proves the key is that slot's, wipes its data (an empty
// snapshot through `import --replace-all`) and sets TEST_SEED_ENABLED=1
// and QC_SEED_ENABLED=1. The deployed code is whatever the last holder
// pushed: deploy yours first.
//
// The lock belongs to the process that claimed it: the nearest ancestor
// that outlives the command (the Claude session, or your interactive
// shell), or --pid. It goes stale when that process dies or 2 h after the
// last claim or run, and the next claim takes it over.
//
// run injects the slot's deploy key into `npx convex <args>` without
// printing it, only for the worktree holding the slot.
//
// Must run outside the Claude sandbox: it writes to the main checkout,
// and the Convex CLI needs WebSockets.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import {
  createInstance,
  emptySnapshot,
  keyDeployment,
  keyEnv,
  loadKeyFile,
  readEnv,
  verifyDeployKey,
} from './convex-instance.mjs'
import {
  isStale,
  newToken,
  readLock,
  refreshLock,
  releaseLock,
  tryLock,
} from './lockfile.mjs'

const PROJECT = 'mr-raznick:keep-together'
const SLOTS = [1, 2]
const LOCK_MAX_AGE_MS = 2 * 60 * 60 * 1000
const DEPLOYMENT_ENV = { TEST_SEED_ENABLED: '1', QC_SEED_ENABLED: '1' }
// What `run` may pass to the CLI: commands that act on the deployment the
// key names. Anything that can pick another deployment is refused.
const RUN_COMMANDS = new Set([
  'deploy',
  'run',
  'import',
  'export',
  'data',
  'env',
  'logs',
  'function-spec',
])
const RETARGET_FLAGS =
  /^(--prod|--deployment|--deployment-name|--env-file|--url|--admin-key|--preview-name|--preview-create|--preview-run|--team|--project)(=|$)/

const root = path.resolve(import.meta.dirname, '..')
const mainCheckout = path.dirname(
  execFileSync(
    'git',
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    { cwd: root, encoding: 'utf8' },
  ).trim(),
)
const lockPath = (n) => path.join(mainCheckout, `.rehearsal-${n}.lock`)
const envFile = (n) => path.join(mainCheckout, `.env.rehearsal-${n}.local`)
const ref = (n) => `${PROJECT}:dev/rehearsal-${n}`

// Never a rehearsal slot, whatever an env file says: the human's own dev
// deployment, and every deployment another env file in the main checkout
// names (QC pool, demo, preview, spikes, .env.local).
function deniedDeployments() {
  const denied = new Set(['zany-bird-247'])
  for (const name of readdirSync(mainCheckout)) {
    if (!/^\.env(\..+)?\.local$/.test(name)) continue
    if (/^\.env\.rehearsal-\d+\.local$/.test(name)) continue
    const env = readEnv(path.join(mainCheckout, name))
    // The CLI writes `dev:<name> # team: …, project: …`.
    const deployment =
      keyDeployment(env.CONVEX_DEPLOY_KEY) ??
      env.CONVEX_DEPLOYMENT?.match(/^dev:([a-z0-9-]+)(\s|$)/)?.[1]
    if (deployment) denied.add(deployment)
  }
  return denied
}

function slotArg(value) {
  const n = Number(value)
  if (!SLOTS.includes(n)) {
    throw new Error(`slot must be one of ${SLOTS.join(', ')}, not ${value}`)
  }
  return n
}

// ── lock owner ──────────────────────────────────────────────────────────

function procInfo(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // comm may hold spaces and parens; ppid is the second field after it.
    const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
    const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
      .split('\0')
      .filter(Boolean)
    return { ppid, argv }
  } catch {
    return null
  }
}

// Processes that end with this command: pnpm/npm/npx (often `node …/pnpm`)
// and one-shot shells (`sh -c …`, which is how both pnpm and Claude's Bash
// tool run a command). An interactive shell has no -c and owns the lock.
function transient({ argv }) {
  const exe = path.basename(argv[0] ?? '')
  if (/^(pnpm|npm|npx|corepack|env|timeout)$/.test(exe)) return true
  if (exe === 'node') {
    return /pnpm|npm|npx|corepack|rehearsal\.mjs/.test(argv[1] ?? '')
  }
  if (/^-?(ba|z|da|fi|k)?sh$/.test(exe)) return argv.includes('-c')
  return false
}

// The nearest ancestor that outlives this command. Without /proc (macOS)
// the parent, which is usually pnpm: pass --pid there.
function ownerPid() {
  let pid = process.ppid
  for (let hops = 0; hops < 20; hops++) {
    const info = procInfo(pid)
    if (!info) return process.ppid
    if (!transient(info) || info.ppid <= 1) return pid
    pid = info.ppid
  }
  return pid
}

function describe(pid) {
  const argv = procInfo(pid)?.argv
  return argv ? `${path.basename(argv[0])} pid ${pid}` : `pid ${pid}`
}

function pidArg(value) {
  const pid = Number(value)
  if (!Number.isInteger(pid) || pid < 1) {
    throw new Error(`--pid must be a positive integer, not ${value}`)
  }
  return pid
}

function heldBy(lock) {
  if (!lock) return 'an unreadable lock'
  return `${describe(lock.pid)}, ${lock.worktree ?? '?'}, since ${lock.startedAt ?? '?'}`
}

// The slot's lock if this worktree holds it (and it isn't stale), else
// an error saying who does.
function requireHeld(n) {
  const lock = readLock(lockPath(n))
  if (!lock || isStale(lock, LOCK_MAX_AGE_MS)) {
    throw new Error(
      `rehearsal-${n} is not claimed: pnpm rehearsal:claim --slot ${n}`,
    )
  }
  if (lock.worktree !== root) {
    throw new Error(`rehearsal-${n} is held by ${heldBy(lock)}, not ${root}`)
  }
  return lock
}

// Push the lock's 2 h expiry forward, unless it was taken over (or
// released and claimed) since `token` read it: then throw.
function touch(n, token) {
  if (!refreshLock(lockPath(n), token, { usedAt: new Date().toISOString() })) {
    throw new Error(`rehearsal-${n} was taken over or released meanwhile`)
  }
}

// ── instance ────────────────────────────────────────────────────────────

// The slot's instance, its key proven to be dev/rehearsal-<n>'s.
async function loadSlot(n) {
  const inst = loadKeyFile(envFile(n), {
    denied: deniedDeployments(),
    role: 'a rehearsal slot',
  })
  await verifyDeployKey(ref(n), inst.deployment, inst.envFile)
  return inst
}

function run(args, key, { cwd = root, inherit = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['convex', ...args], {
      cwd,
      env: keyEnv(key),
      stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout?.on('data', (d) => (out += d))
    child.stderr?.on('data', (d) => (out += d))
    child.on('error', reject)
    child.on('close', (code) =>
      inherit || code === 0
        ? resolve({ code, out })
        : reject(new Error(`convex ${args[0]} exited ${code}:\n${out}`)),
    )
  })
}

// ── commands ────────────────────────────────────────────────────────────

async function claim(argv) {
  let slots = SLOTS
  let pid = null
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--slot') slots = [slotArg(argv[++i])]
    else if (argv[i] === '--pid') pid = pidArg(argv[++i])
    else throw new Error(`unknown argument ${argv[i]}`)
  }
  pid ??= ownerPid()
  // Claiming again while holding a slot hands back that slot (untouched)
  // rather than taking a second one.
  const held = slots.find((s) => {
    const lock = readLock(lockPath(s))
    return (
      !isStale(lock, LOCK_MAX_AGE_MS) &&
      lock.worktree === root &&
      lock.pid === pid
    )
  })
  if (held) {
    console.log(
      `✔ you already hold rehearsal-${held} (${readEnv(envFile(held)).VITE_CONVEX_URL}); ` +
        `not reset. To start from empty: pnpm rehearsal:release ${held} && pnpm rehearsal:claim --slot ${held}`,
    )
    return
  }
  const now = new Date().toISOString()
  const token = newToken()
  const holders = []
  let n
  for (const s of slots) {
    const holder = tryLock(
      lockPath(s),
      { slot: s, pid, worktree: root, startedAt: now, usedAt: now, token },
      { maxAgeMs: LOCK_MAX_AGE_MS, label: `rehearsal-${s} lock` },
    )
    if (!holder) {
      n = s
      break
    }
    holders.push(`  rehearsal-${s}: ${heldBy(holder)}`)
  }
  if (!n) {
    throw new Error(
      `no free rehearsal slot:\n${holders.join('\n')}\n` +
        'a slot frees when its holder releases it or its process ends',
    )
  }
  try {
    if (!existsSync(envFile(n))) {
      await createInstance({
        ref: ref(n),
        tokenName: `rehearsal-${n}-push`,
        siteUrl: 'http://localhost:3000',
        envFile: envFile(n),
        comment: `dev/rehearsal-${n}: rehearsal slot (scripts/rehearsal.mjs)`,
        cwd: root,
      })
    }
    const inst = await loadSlot(n)
    // Last check before wiping: the slot is still ours.
    touch(n, token)
    const zip = emptySnapshot(`rehearsal-${n}`)
    console.log(`▸ rehearsal-${n}: resetting data`)
    try {
      await run(['import', '--replace-all', '-y', zip], inst.key)
    } finally {
      unlinkSync(zip)
    }
    for (const [k, v] of Object.entries(DEPLOYMENT_ENV)) {
      await run(['env', 'set', k, v], inst.key)
    }
    console.log(`✔ claimed rehearsal-${n} = ${inst.deployment}, empty
  url:     ${inst.url}
  held by: ${describe(pid)} (${root})
  run:     pnpm rehearsal:run ${n} -- deploy --codegen disable -y
           pnpm rehearsal:run ${n} -- run platform/devSeed:demoTenant '{"slug":"demo"}'
           pnpm rehearsal:run ${n} --cwd <other checkout> -- deploy …
  or:      npx convex <command> --env-file ${inst.envFile}
           (no lock check: only while you hold the slot)
  release: pnpm rehearsal:release ${n}`)
  } catch (err) {
    releaseLock(lockPath(n), (lock) => lock?.token === token)
    throw err
  }
}

async function runIn(argv) {
  const sep = argv.indexOf('--')
  if (sep < 0)
    throw new Error('usage: run <slot> [--cwd DIR] -- <convex args…>')
  const own = argv.slice(0, sep)
  const args = argv.slice(sep + 1)
  const n = slotArg(own[0])
  let cwd = root
  for (let i = 1; i < own.length; i++) {
    if (own[i] === '--cwd') cwd = path.resolve(own[++i])
    else throw new Error(`unknown argument ${own[i]}`)
  }
  if (!RUN_COMMANDS.has(args[0])) {
    throw new Error(
      `run passes only ${[...RUN_COMMANDS].join(', ')} to the CLI, not ${args[0]}`,
    )
  }
  const retarget = args.find((a) => RETARGET_FLAGS.test(a))
  if (retarget) throw new Error(`${retarget} would leave the slot; refused`)
  const { token } = requireHeld(n)
  const inst = await loadSlot(n)
  // Re-checked after loadSlot's wait: the slot may have changed hands.
  touch(n, token)
  const { code } = await run(args, inst.key, { cwd, inherit: true })
  process.exit(code ?? 1)
}

function release(argv) {
  const n = slotArg(argv[0])
  const force = argv.includes('--force')
  let holder
  const outcome = releaseLock(lockPath(n), (lock) => {
    holder = lock
    return force || isStale(lock, LOCK_MAX_AGE_MS) || lock.worktree === root
  })
  if (outcome === 'absent') console.log(`rehearsal-${n} is not claimed`)
  else if (outcome === 'released') console.log(`✔ released rehearsal-${n}`)
  else {
    throw new Error(
      `rehearsal-${n} is held by ${heldBy(holder)}; --force to release it anyway`,
    )
  }
}

function status() {
  for (const n of SLOTS) {
    const lock = readLock(lockPath(n))
    const url = existsSync(envFile(n))
      ? readEnv(envFile(n)).VITE_CONVEX_URL
      : '(not created yet)'
    const state = !existsSync(lockPath(n))
      ? 'free'
      : isStale(lock, LOCK_MAX_AGE_MS)
        ? `free (stale: ${heldBy(lock)})`
        : `held by ${heldBy(lock)}`
    console.log(`rehearsal-${n}  ${url}  ${state}`)
  }
}

const COMMANDS = { claim, run: runIn, release, status }

async function main([command, ...argv]) {
  const fn = COMMANDS[command]
  if (!fn) {
    throw new Error(`usage: rehearsal.mjs ${Object.keys(COMMANDS).join('|')} …`)
  }
  await fn(argv)
}

main(process.argv.slice(2)).catch((err) => {
  console.error(`rehearsal: ${err.message}`)
  process.exit(1)
})
