#!/usr/bin/env node
// Keep the manual-test instances on main (README "Manual test instances").
//
//   node scripts/test-instances.mjs [--only demo|preview] [--reset] [--no-build] [--any-branch]
//   node scripts/test-instances.mjs serve
//
// dev/demo is what GitHub Pages builds main against; dev/preview is served
// from this machine over Tailscale (`serve`). A sync:
//
// 1. Refuses unless this checkout is on a clean `main` (--any-branch skips
//    that, for trying the script from a worktree).
// 2. Ensures each deployment exists. A missing one is created in the EU
//    with Convex Auth keys and a deploy key, saved to `.env.<name>.local`
//    in the main checkout, then proven to be dev/<name> before any write.
// 3. Sets TEST_SEED_ENABLED=1 (the seed's gate) and AUTH_2FA_REQUIRED=0
//    (2FA, once R4 builds it, stays off here) on each.
// 4. --reset: replaces each deployment's data with an empty snapshot.
// 5. Pushes this checkout with `convex deploy` and the deploy key.
// 6. Seeds through platform/testSeed:seed. Idempotent: on a seeded
//    deployment it changes nothing (unless a password changed), so
//    data people made while testing survives every sync.
// 7. Builds dist-preview against dev/preview, swapping the directory in
//    whole so a running `serve` never sees a half-written build.
//
// Sign-ins are in `.env.test-users.local` in the main checkout (mode
// 600): strong random passwords minted once, kept across resets.
//
// Must run outside the Claude sandbox: it writes to the main checkout,
// and the Convex CLI needs WebSockets.
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  convex,
  createDeployment,
  setAuthKeys,
  verifyDeployKey,
} from './convex-instance.mjs'

const PROJECT = 'mr-raznick:keep-together'
const PREVIEW_PORT = 4300
// SITE_URL is only used by Convex Auth for OAuth / magic-link redirects,
// which password sign-in doesn't use; set to where each is browsed from.
const INSTANCES = {
  demo: { siteUrl: 'https://kindly.github.io/keep-together/' },
  preview: {
    siteUrl: `http://localhost:${PREVIEW_PORT}`,
    outDir: 'dist-preview',
  },
}
// Never a test instance, whatever an env file says: the human's own dev
// deployment.
const DENIED = new Set(['zany-bird-247'])
// What a push or build reads besides committed files.
const CODE_PATHS = ['convex', 'src', 'public']
const DEPLOYMENT_ENV = { TEST_SEED_ENABLED: '1', AUTH_2FA_REQUIRED: '0' }

const root = path.resolve(import.meta.dirname, '..')
const mainCheckout = path.dirname(
  execFileSync(
    'git',
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    { cwd: root, encoding: 'utf8' },
  ).trim(),
)
const usersFile = path.join(mainCheckout, '.env.test-users.local')
const envFile = (name) => path.join(mainCheckout, `.env.${name}.local`)

function parseArgs(argv) {
  const opts = {
    only: Object.keys(INSTANCES),
    reset: false,
    build: true,
    anyBranch: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--reset') opts.reset = true
    else if (a === '--no-build') opts.build = false
    else if (a === '--any-branch') opts.anyBranch = true
    else if (a === '--only') {
      const name = argv[++i]
      if (!(name in INSTANCES))
        throw new Error(`--only ${name}: not an instance`)
      opts.only = [name]
    } else throw new Error(`unknown argument ${a}`)
  }
  return opts
}

const ms = (start) => `${Math.round(performance.now() - start)} ms`

function readEnv(file) {
  const env = {}
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m) env[m[1]] = m[2]
  }
  return env
}

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

function requireMain() {
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
  if (branch !== 'main') {
    throw new Error(
      `this checkout is on ${branch}, not main; the instances follow main (--any-branch to override)`,
    )
  }
  if (git('status', '--porcelain', '--untracked-files=no')) {
    throw new Error(
      'this checkout has uncommitted changes; the instances follow main (--any-branch to override)',
    )
  }
  // `convex deploy` and `vite build` pick up untracked files too, and
  // dev/demo is public. Scratch files elsewhere (factory/, docs) are fine.
  const stray = git(
    'ls-files',
    '--others',
    '--exclude-standard',
    '--',
    ...CODE_PATHS,
  )
  if (stray) {
    throw new Error(
      `untracked files would be deployed (--any-branch to override):\n${stray}`,
    )
  }
}

// ── instances ───────────────────────────────────────────────────────────

// Load and check an instance's env file. `convex deploy` without a key
// targets the project's *production* deployment, so a missing or non-dev
// key is fatal, never a fallback.
function loadInstance(name) {
  const file = envFile(name)
  const { CONVEX_DEPLOY_KEY: key, VITE_CONVEX_URL: url } = readEnv(file)
  const deployment = key?.match(/^dev:([a-z0-9-]+)\|/)?.[1]
  if (!deployment) {
    throw new Error(
      `${file}: CONVEX_DEPLOY_KEY missing or not a dev deploy key`,
    )
  }
  if (DENIED.has(deployment)) {
    throw new Error(`${file}: ${deployment} is never a test instance`)
  }
  if (!url?.startsWith(`https://${deployment}.`)) {
    throw new Error(`${file}: VITE_CONVEX_URL ${url} is not ${deployment}`)
  }
  return { name, deployment, url, key, envFile: file, ...INSTANCES[name] }
}

// Prove the key is dev/<name>'s before anything writes with it.
function verify(inst) {
  return verifyDeployKey(
    `${PROJECT}:dev/${inst.name}`,
    inst.deployment,
    inst.envFile,
  )
}

// Create dev/<name> with auth keys and a deploy key. The env file is
// written last, so an interrupted creation is redone on the next run: the
// deployment is then reused (each retry leaves an extra `<name>-push` key
// to delete from the dashboard).
async function createInstance(name) {
  const ref = `${PROJECT}:dev/${name}`
  console.log(`▸ creating ${ref}`)
  let url
  try {
    ;({ url } = await createDeployment(ref))
  } catch (err) {
    if (!/DeploymentReferenceAlreadyExists/.test(err.message)) throw err
    console.log(`▸ ${ref} already exists; finishing its setup`)
  }
  console.log(`▸ setting Convex Auth keys + SITE_URL on ${ref}`)
  await setAuthKeys(ref, INSTANCES[name].siteUrl)
  const { code, stdout, stderr } = await convex([
    'deployment',
    'token',
    'create',
    `${name}-push`,
    '--deployment',
    ref,
  ])
  const key = stdout.trim().split('\n').at(-1) ?? ''
  const deployment = key.match(/^dev:([a-z0-9-]+)\|/)?.[1]
  if (code !== 0 || !deployment) {
    throw new Error(`deploy key for ${ref} not created: ${stderr}`)
  }
  if (!url) {
    // A dry-run deploy names the URL without changing anything.
    const out = await run(
      'npx',
      [
        'convex',
        'deploy',
        '--dry-run',
        '--typecheck',
        'disable',
        '--codegen',
        'disable',
        '-y',
      ],
      keyEnv({ key }),
    )
    url = out.match(/https:\/\/[a-z0-9.-]*\.convex\.cloud/)?.[0]
  }
  if (!url?.startsWith(`https://${deployment}.`)) {
    throw new Error(`no URL for ${deployment}`)
  }
  writeFileSync(
    envFile(name),
    `# dev/${name}: manual-test instance (scripts/test-instances.mjs)\n` +
      `CONVEX_DEPLOY_KEY=${key}\nVITE_CONVEX_URL=${url}\n`,
    { mode: 0o600 },
  )
  console.log(`▸ wrote ${envFile(name)}`)
}

// Child env for a Convex CLI call scoped by a deploy key: nothing inherited
// may pick a different deployment.
function keyEnv(inst) {
  const env = { ...process.env, CONVEX_DEPLOY_KEY: inst.key }
  delete env.CONVEX_DEPLOYMENT
  delete env.CONVEX_SELF_HOSTED_URL
  delete env.CONVEX_SELF_HOSTED_ADMIN_KEY
  return env
}

function run(cmd, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0
        ? resolve(out)
        : reject(
            new Error(
              `${cmd} ${args.slice(0, 3).join(' ')} … exited ${code}:\n${out}${err}`,
            ),
          ),
    )
  })
}

// A snapshot with no tables: `import --replace-all` clears every table.
function emptySnapshot() {
  const file = path.join(os.tmpdir(), `test-instances-empty-${process.pid}.zip`)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  writeFileSync(file, eocd)
  return file
}

// ── sign-ins ────────────────────────────────────────────────────────────

const varName = (role, field) => `TEST_${role.toUpperCase()}_${field}`

// The seed names its users (one per role); mint a password for any the
// file lacks and keep the rest, so passwords survive resets and a new
// role (R1's viewer) just gets one more entry.
function ensurePasswords(users) {
  const current = existsSync(usersFile) ? readEnv(usersFile) : {}
  const lines = [
    '# Manual-test instance sign-ins (scripts/test-instances.mjs), the same',
    '# on dev/demo and dev/preview. Change a password here and sync to apply it.',
  ]
  const passwords = {}
  for (const { role, email } of users) {
    const password =
      current[varName(role, 'PASSWORD')] ||
      randomBytes(18).toString('base64url')
    passwords[role] = password
    lines.push(
      `${varName(role, 'EMAIL')}=${email}`,
      `${varName(role, 'PASSWORD')}=${password}`,
    )
  }
  writeFileSync(usersFile, lines.join('\n') + '\n', { mode: 0o600 })
  return passwords
}

// Args (the passwords, for the seed) go through argv: `convex run` has no
// stdin or file input. They show in `ps` for the seconds the call takes,
// on a single-user machine; an env var would keep them on the deployment.
// `run` never echoes past the function name on failure.
async function convexRun(inst, fn, args) {
  const out = await run(
    'npx',
    ['convex', 'run', fn, JSON.stringify(args)],
    keyEnv(inst),
  )
  return JSON.parse(out)
}

// ── main ────────────────────────────────────────────────────────────────

async function sync(opts) {
  if (!opts.anyBranch) requireMain()
  const total = performance.now()
  for (const name of opts.only) {
    if (!existsSync(envFile(name))) await createInstance(name)
  }
  const pool = opts.only.map(loadInstance)
  await Promise.all(pool.map(verify))
  console.log(
    `▸ instances: ${pool.map((p) => `${p.name}=${p.deployment}`).join(' ')}`,
  )

  const zip = opts.reset ? emptySnapshot() : null
  const commit =
    git('rev-parse', '--short', 'HEAD') +
    (git('status', '--porcelain', '--untracked-files=no') ? '+uncommitted' : '')
  const results = await Promise.all(
    pool.map(async (inst) => {
      const start = performance.now()
      for (const [k, v] of Object.entries(DEPLOYMENT_ENV)) {
        await run('npx', ['convex', 'env', 'set', k, v], keyEnv(inst))
      }
      if (zip) {
        console.log(`▸ ${inst.name}: resetting data`)
        await run(
          'npx',
          ['convex', 'import', '--replace-all', '-y', zip],
          keyEnv(inst),
        )
      }
      // Generated files are committed and current, so no codegen.
      await run(
        'npx',
        ['convex', 'deploy', '--codegen', 'disable', '-y'],
        keyEnv(inst),
      )
      console.log(`  ${inst.name}: pushed ${commit} (${ms(start)})`)
      return inst
    }),
  )
  if (zip) unlinkSync(zip)

  // Every deployment runs the same code, so any of them names the users.
  const passwords = ensurePasswords(
    await convexRun(results[0], 'platform/testSeed:users', {}),
  )
  await Promise.all(
    results.map(async (inst) => {
      const start = performance.now()
      const world = await convexRun(inst, 'platform/testSeed:seed', {
        passwords,
      })
      console.log(
        `  ${inst.name}: seeded /t/${world.slug}, ${world.donorsCreated} new donors (${ms(start)})`,
      )
    }),
  )

  const preview = results.find((p) => p.outDir)
  if (preview && opts.build) {
    const start = performance.now()
    const build = await buildPreview(preview)
    console.log(`  preview: built ${build} (${ms(start)})`)
  }
  console.log(`✔ synced ${commit} in ${ms(total)}; sign-ins in ${usersFile}`)
  for (const inst of results) console.log(`  ${inst.name}: ${inst.url}`)
}

// Build into dist-preview.builds/<time> and repoint the dist-preview
// symlink with one rename, so `serve` (which resolves paths per request)
// never sees a missing or half-written build. The previous build stays
// until the next sync: tabs opened on it still load their lazy route
// chunks.
async function buildPreview(inst) {
  const link = path.join(root, inst.outDir)
  const builds = `${link}.builds`
  const name = new Date().toISOString().replace(/[:.]/g, '-')
  mkdirSync(builds, { recursive: true })
  await run(
    path.join(root, 'node_modules/.bin/vite'),
    ['build', '--outDir', path.join(builds, name), '--emptyOutDir'],
    { ...process.env, VITE_CONVEX_URL: inst.url },
  )
  const current = existsSync(link) ? path.basename(realpathSync(link)) : null
  if (existsSync(link) && !lstatSync(link).isSymbolicLink()) {
    // A plain directory from before the symlink: retire it.
    rmSync(link, { recursive: true })
  }
  const tmp = `${link}.tmp-${process.pid}`
  symlinkSync(path.join(path.basename(builds), name), tmp)
  renameSync(tmp, link)
  for (const old of readdirSync(builds)) {
    if (old !== name && old !== current) {
      rmSync(path.join(builds, old), { recursive: true, force: true })
    }
  }
  return path.relative(root, path.join(builds, name))
}

// Serve dist-preview on this machine's Tailscale address only (not the
// LAN), or PREVIEW_HOST if set. Runs until killed; the controller keeps it
// in a herdr tab, and syncs swap the build underneath it.
function serve() {
  let host = process.env.PREVIEW_HOST
  if (!host) {
    try {
      host = execFileSync('tailscale', ['ip', '-4'], { encoding: 'utf8' })
        .trim()
        .split('\n')[0]
    } catch {
      throw new Error(
        'no Tailscale address (`tailscale ip -4` failed); set PREVIEW_HOST',
      )
    }
  }
  const outDir = INSTANCES.preview.outDir
  if (!existsSync(path.join(root, outDir, 'index.html'))) {
    throw new Error(`${outDir} has no build; run a sync first`)
  }
  const child = spawn(
    path.join(root, 'node_modules/.bin/vite'),
    [
      'preview',
      '--outDir',
      outDir,
      '--host',
      host,
      '--port',
      String(PREVIEW_PORT),
      '--strictPort',
    ],
    { cwd: root, stdio: 'inherit' },
  )
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => child.kill(sig))
  }
  child.on('close', (code) => process.exit(code ?? 1))
}

const [first, ...rest] = process.argv.slice(2)
try {
  if (first === 'serve') serve()
  else await sync(parseArgs(first === undefined ? [] : [first, ...rest]))
} catch (err) {
  console.error(`test-instances: ${err.message}`)
  process.exit(1)
}
