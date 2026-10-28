#!/usr/bin/env node
// The local dev loop: the api, rebuilt and restarted on every change under
// server/, and Vite with HMR proxying /api (SSE included) to it, on this
// checkout's own ports, shared on the tailnet.
//
//   pnpm dev                  # tailnet (https) + this machine
//   pnpm dev --local          # loopback only: http://localhost:<vite>
//   pnpm dev:reset [--local]  # wipe server/data, reseed, then as pnpm dev
//   pnpm dev:share            # (re)add this checkout's tailnet entry
//   pnpm dev:share --off      # remove it (pnpm dev removes its own on exit)
//
// Ports come from the checkout's slot n (scripts/dev-lib.mjs): api 8787+n,
// Vite 3000+n, tailnet https 9100+n, so several worktrees run side by
// side. KEEP_PORT, KEEP_VITE_PORT and KEEP_HTTPS_PORT override them.
//
// The api runs as dev (KEEP_ENV=dev, loopback) with KEEP_AUTH_POLICY=
// relaxed (a password alone), KEEP_MAIL=log (codes and links in this
// terminal), KEEP_ADDRESS_LOOKUP=fake,
// KEEP_GOCARDLESS=fake (GoCardless's mock on the api) and data in server/data/; any of
// them set in the environment wins (dev:reset still only wipes
// server/data/, and refuses while KEEP_DATA_DIR points elsewhere). It seeds the riverside group on the
// first boot (KEEP_RESET_SEED=riverside: idempotent, so later boots keep
// what you changed); dev:reset starts again from it. KEEP_DEV_AUTH is
// never set: dev auth is loopback-only, and the tailnet reaches the api
// through Vite.
//
// The tailnet: `tailscale serve --bg --https=<9100+n> http://127.0.0.1:
// <vite>` (never funnel), the same mechanism as the preview
// (scripts/preview/). If tailscale asks for rights, run once:
//   sudo tailscale set --operator=$USER
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, rmSync, watch } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { claimSlot, portsFor, servedOn, slotRecorded } from './dev-lib.mjs'

const root = path.resolve(import.meta.dirname, '..')
const server = path.join(root, 'server')
const dataDir = path.join(server, 'data')
// KEEP_DATA_DIR wins (relative to the repo root); dev:reset only ever
// wipes server/data/.
const apiData = process.env.KEEP_DATA_DIR
  ? path.resolve(root, process.env.KEEP_DATA_DIR)
  : dataDir
const RIVERSIDE = {
  slug: 'riverside',
  users: ['admin', 'staff', 'viewer'].map((r) => `${r}@keep-together.example`),
  password: 'riverside',
}

const argv = process.argv.slice(2)
const command = ['share', 'reset'].includes(argv[0]) ? argv.shift() : 'dev'
const flag = (name) => argv.includes(name)
const local = flag('--local')

const say = (...a) => console.log('[dev]', ...a)
function die(msg) {
  console.error(`[dev] error: ${msg}`)
  process.exit(1)
}
const git = (...args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()

// ── this checkout's slot and ports ─────────────────────────────────────────

const gitCommon = git('rev-parse', '--path-format=absolute', '--git-common-dir')
const slotsFile = path.join(gitCommon, 'keep-dev-slots.json')

function slot() {
  try {
    return claimSlot(slotsFile, root, path.dirname(gitCommon))
  } catch (err) {
    die(err.message)
  }
}

const n = slot()
const env = process.env
const ports = portsFor(n)
const port = (name, value) => {
  if (value === undefined) return ports[name]
  if (!/^\d+$/.test(value)) die(`${name} port ${value} is not a number`)
  return Number(value)
}
const apiPort = port('api', env.KEEP_PORT)
const vitePort = port('vite', env.KEEP_VITE_PORT)
const httpsPort = port('https', env.KEEP_HTTPS_PORT)
const branch =
  git('branch', '--show-current') ||
  `detached ${git('rev-parse', '--short', 'HEAD')}`

// ── the tailnet ────────────────────────────────────────────────────────────

function tailnetHost() {
  let status
  try {
    status = JSON.parse(
      execFileSync('tailscale', ['status', '--json'], { encoding: 'utf8' }),
    )
  } catch (err) {
    die(
      `can't read tailscale status (${err.message.split('\n')[0]}); pnpm dev --local skips the tailnet`,
    )
  }
  const dns = status.Self?.DNSName?.replace(/\.$/, '')
  if (!dns)
    die(
      'tailscale has no name for this machine (is it up?); pnpm dev --local skips the tailnet',
    )
  return dns
}

// Throws with what tailscale said (and the fix, for missing rights).
function tailscale(args) {
  console.log(`+ tailscale ${args.join(' ')}`)
  try {
    execFileSync('tailscale', args, { stdio: ['ignore', 'inherit', 'pipe'] })
  } catch (err) {
    const why = String(err.stderr || err.message).trim()
    throw new Error(
      /access denied|permission|operator/i.test(why)
        ? `${why}\ntailscale serve needs operator rights; run once: sudo tailscale set --operator=$USER`
        : why,
    )
  }
}

// The serve config is the machine's, shared with other projects: add only
// to a free port, and remove only an entry that is exactly ours (this
// checkout's Vite). Never `tailscale serve reset`.
const target = `http://127.0.0.1:${vitePort}`
function served() {
  let status
  try {
    status = JSON.parse(
      execFileSync('tailscale', ['serve', 'status', '--json'], {
        encoding: 'utf8',
      }) || '{}',
    )
  } catch (err) {
    throw new Error(
      `can't read tailscale serve status: ${err.message.split('\n')[0]}`,
    )
  }
  return servedOn(status, httpsPort, target)
}
function shareOn() {
  const now = served()
  if (now?.ours) {
    console.log(`(tailnet https ${httpsPort} already serves ${target})`)
    return
  }
  if (now) {
    throw new Error(
      `tailnet https port ${httpsPort} already serves something else (tailscale serve status); pick another with KEEP_HTTPS_PORT`,
    )
  }
  tailscale(['serve', '--bg', `--https=${httpsPort}`, target])
}
function shareOff() {
  const now = served()
  if (!now) return
  if (!now.ours) {
    throw new Error(
      `tailnet https port ${httpsPort} serves something other than ${target}: left alone`,
    )
  }
  tailscale(['serve', `--https=${httpsPort}`, 'off'])
}
const orDie = (f) => {
  try {
    f()
  } catch (err) {
    die(err.message)
  }
}

if (command === 'share') {
  if (flag('--off')) {
    orDie(shareOff)
    say(`removed https://${tailnetHost()}:${httpsPort} (${branch})`)
  } else {
    orDie(shareOn)
    say(
      `${branch} → https://${tailnetHost()}:${httpsPort} (Vite on ${vitePort})`,
    )
  }
  process.exit(0)
}

// ── dev ────────────────────────────────────────────────────────────────────

const free = (p) =>
  new Promise((resolve) => {
    const probe = net
      .createServer()
      .once('error', () => resolve(false))
      .once('listening', () => probe.close(() => resolve(true)))
      .listen(p, '127.0.0.1')
  })

for (const [what, p] of [
  ['api', apiPort],
  ['Vite', vitePort],
]) {
  if (!(await free(p))) {
    die(
      `port ${p} (${what}) is in use: is pnpm dev already running in this checkout? (ss -ltnp 'sport = :${p}')`,
    )
  }
}

if (command === 'reset') {
  if (apiData !== dataDir) {
    die(
      `KEEP_DATA_DIR is ${apiData}: dev:reset only wipes server/data/ (unset it, or wipe that dir yourself)`,
    )
  }
  say(`wiping ${path.relative(root, dataDir)}/ (riverside is reseeded on boot)`)
  rmSync(dataDir, { recursive: true, force: true })
}
mkdirSync(apiData, { recursive: true })

const host = local ? null : tailnetHost()
const url = host
  ? `https://${host}:${httpsPort}`
  : `http://localhost:${vitePort}`

const children = new Set()
function track(child) {
  children.add(child)
  child.once('exit', () => children.delete(child))
  return child
}

// Lines of a child's output, prefixed.
function prefixed(stream, label, out) {
  let rest = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    const lines = (rest + chunk).split('\n')
    rest = lines.pop()
    for (const line of lines) out.write(`${label} ${line}\n`)
  })
  stream.on('end', () => rest && out.write(`${label} ${rest}\n`))
}

const apiEnv = {
  ...env,
  KEEP_ENV: env.KEEP_ENV ?? 'dev',
  KEEP_BIND: '127.0.0.1',
  KEEP_PORT: String(apiPort),
  KEEP_DATA_DIR: apiData,
  KEEP_AUTH_POLICY: env.KEEP_AUTH_POLICY ?? 'relaxed',
  KEEP_MAIL: env.KEEP_MAIL ?? 'log',
  KEEP_ADDRESS_LOOKUP: env.KEEP_ADDRESS_LOOKUP ?? 'fake',
  KEEP_GOCARDLESS: env.KEEP_GOCARDLESS ?? 'fake',
  KEEP_RESET_SEED: env.KEEP_RESET_SEED ?? 'riverside',
  KEEP_APP_ORIGIN: env.KEEP_APP_ORIGIN ?? url,
}
delete apiEnv.KEEP_DEV_AUTH

let api = null
let stopping = false
// This run's tailnet entry is up (stop() removes it).
let shared = false

function startApi() {
  const bin = path.join(server, 'target', 'debug', 'api')
  api = track(
    spawn(bin, [], {
      cwd: server,
      env: apiEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  )
  prefixed(api.stdout, '[api]', process.stdout)
  prefixed(api.stderr, '[api]', process.stderr)
  const me = api
  api.once('exit', (code, sig) => {
    if (me === api) api = null
    if (!stopping && !me.replaced)
      say(
        `api exited (${sig ?? code}); it starts again on the next change under server/`,
      )
  })
}

function stopApi() {
  const old = api
  if (!old) return Promise.resolve()
  old.replaced = true
  api = null
  return new Promise((resolve) => {
    old.once('exit', resolve)
    old.kill('SIGTERM')
    setTimeout(() => old.kill('SIGKILL'), 5000).unref()
  })
}

function cargoBuild() {
  return new Promise((resolve) => {
    const cargo = track(
      spawn('cargo', ['build', '-p', 'api', '--bin', 'api'], {
        cwd: server,
        stdio: ['ignore', 'inherit', 'inherit'],
      }),
    )
    cargo.once('exit', (code) => resolve(code === 0))
  })
}

// One build at a time; a change during a build builds again after it.
let building = false
let again = false
async function rebuild(reason) {
  if (building) {
    again = true
    return
  }
  building = true
  do {
    again = false
    say(`building the api (${reason})`)
    const started = Date.now()
    if (await cargoBuild()) {
      await stopApi()
      if (stopping) break
      startApi()
      say(
        `api restarted on ${apiPort} (${((Date.now() - started) / 1000).toFixed(1)}s)`,
      )
    } else {
      say(
        api
          ? 'build failed: the running api is the last good build'
          : 'build failed: fix it and save',
      )
    }
  } while (again && !stopping)
  building = false
}

// Every source change under server/: the crates, the workspace manifest
// and the lockfile (never target/ or data/, which aren't watched at all).
let timer = null
function changed(file) {
  if (!file || /(^|[/\\])\./.test(file)) return
  clearTimeout(timer)
  timer = setTimeout(() => void rebuild(file), 200)
}
watch(path.join(server, 'crates'), { recursive: true }, (_e, file) =>
  changed(file && path.join('crates', file)),
)
watch(server, (_e, file) => {
  if (file === 'Cargo.toml' || file === 'Cargo.lock') changed(file)
})

function banner() {
  console.log('')
  if (host)
    console.log(`  ${url}    ← ${branch} (tailnet; Vite on ${vitePort})`)
  console.log(`  http://localhost:${vitePort}    ← ${branch} (this machine)`)
  console.log(
    `  sign in: ${RIVERSIDE.users[0]} / ${RIVERSIDE.password}  (also ${RIVERSIDE.users.slice(1).join(', ')}; same password)`,
  )
  console.log(
    `  api ${apiPort} · data ${path.relative(root, apiData)}/ · slot ${n} · Ctrl-C stops`,
  )
  console.log('')
}

async function stop(code = 0) {
  if (stopping) return
  stopping = true
  // Only an entry this run put up, and only while the slots file still
  // gives this checkout the slot the entry was made for: a run that lost
  // its slot (or never got the entry up) must not take down another's.
  if (host && shared && slotRecorded(slotsFile, root) === n) {
    try {
      shareOff()
    } catch (err) {
      say(
        `couldn't remove the tailnet entry (pnpm dev:share --off): ${err.message}`,
      )
    }
  }
  await stopApi()
  // Wait for each to exit, so its port is free for the next pnpm dev.
  await Promise.all(
    [...children].map(
      (child) =>
        new Promise((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve()
            return
          }
          child.once('exit', resolve)
          child.kill('SIGTERM')
          setTimeout(() => child.kill('SIGKILL'), 5000).unref()
        }),
    ),
  )
  process.exit(code)
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'])
  process.on(sig, () => void stop(0))

if (host) {
  console.log(`\n  ${url}    ← ${branch}\n`)
  orDie(shareOn)
  shared = true
}

const vite = track(
  spawn(
    path.join(root, 'node_modules', '.bin', 'vite'),
    ['dev', '--port', String(vitePort), '--strictPort', '--host', '127.0.0.1'],
    {
      cwd: root,
      env: { ...env, KEEP_PORT: String(apiPort) },
      stdio: 'inherit',
    },
  ),
)
vite.once('exit', (code) => {
  if (!stopping) {
    say(`Vite exited (${code}); stopping`)
    void stop(code ?? 1)
  }
})

await rebuild('start')
banner()
