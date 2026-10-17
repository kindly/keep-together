#!/usr/bin/env node
// Shared logic for creating cloud dev deployments and giving them the
// Convex Auth keys. Used by scripts/dev-instance.sh (through the CLI below)
// and scripts/qc-instances.mjs (through the exports).
//
//   node scripts/convex-instance.mjs create <ref> <envfile> [region]
//     creates the deployment, writes CONVEX_DEPLOYMENT + VITE_CONVEX_URL
//   node scripts/convex-instance.mjs auth <deployment> <site-url>
//     sets JWT_PRIVATE_KEY, JWKS and SITE_URL unless JWKS is already set
//
// <ref> is anything `convex deployment create` accepts: `dev/<name>` inside
// a configured project, `team:project:dev/<name>` from anywhere.
import { spawn } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// Run `npx convex …`. Resolves { code, stdout, stderr }; `tee` copies the
// child's output to our stderr as it arrives. A timeout kills the child
// and rejects: `convex env list` hangs forever inside the Claude sandbox.
export function convex(args, { env, tee = false, timeoutMs, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['convex', ...args], {
      cwd,
      env: env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => {
      stdout += d
      if (tee) process.stderr.write(d)
    })
    child.stderr.on('data', (d) => {
      stderr += d
      if (tee) process.stderr.write(d)
    })
    const timer =
      timeoutMs &&
      setTimeout(() => {
        child.kill('SIGTERM')
        reject(
          new Error(
            `npx convex ${args[0]} ${args[1] ?? ''} timed out after ${timeoutMs} ms` +
              ' (inside the Claude sandbox its WebSocket never connects)',
          ),
        )
      }, timeoutMs)
    child.on('error', reject)
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

// Create a dev deployment; returns { deployment, url }. The region is the
// EU unless CONVEX_REGION says otherwise (eu | us | …).
export async function createDeployment(
  ref,
  { region = process.env.CONVEX_REGION ?? 'eu' } = {},
) {
  const { code, stdout, stderr } = await convex(
    ['deployment', 'create', ref, '--type', 'dev', '--region', region],
    { tee: true },
  )
  const url = (stdout + stderr).match(
    /https:\/\/[a-z0-9.-]*\.convex\.cloud/,
  )?.[0]
  if (code !== 0 || !url) {
    throw new Error(`could not parse deployment URL\n${stdout}${stderr}`)
  }
  const deployment = url.replace(/^https:\/\/([a-z0-9-]+)\..*$/, '$1')
  return { deployment, url }
}

// The RS256 key pair Convex Auth needs, in the exact shape its setup wizard
// produces (JWT_PRIVATE_KEY on one line, JWKS as JSON).
export function generateAuthKeys() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  })
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const jwk = publicKey.export({ format: 'jwk' })
  return {
    JWT_PRIVATE_KEY: pem.trimEnd().replace(/\n/g, ' '),
    JWKS: JSON.stringify({ keys: [{ use: 'sig', ...jwk }] }),
  }
}

export async function hasAuthKeys(deployment) {
  const { stdout } = await convex(['env', 'list', '--deployment', deployment], {
    timeoutMs: 60_000,
  })
  return /^JWKS=/m.test(stdout)
}

// Set the Convex Auth keys and SITE_URL. `deployment` is a name or ref.
export async function setAuthKeys(deployment, siteUrl) {
  const keys = generateAuthKeys()
  for (const [name, value] of [
    ['JWT_PRIVATE_KEY', keys.JWT_PRIVATE_KEY],
    ['JWKS', keys.JWKS],
    ['SITE_URL', siteUrl],
  ]) {
    const { code, stderr } = await convex([
      'env',
      'set',
      '--deployment',
      deployment,
      name,
      '--',
      value,
    ])
    if (code !== 0)
      throw new Error(`env set ${name} on ${deployment}: ${stderr}`)
  }
}

// Prove a deploy key belongs to `ref` before anything writes with it: the
// project reference must resolve (with the team login, not the key) to the
// deployment the key names. A key for any other deployment, pasted into an
// env file, would otherwise get code pushed to it and, on reset, its data
// wiped. `source` names where the key came from, for the error.
export async function verifyDeployKey(ref, deployment, source) {
  const env = { ...process.env }
  delete env.CONVEX_DEPLOY_KEY
  delete env.CONVEX_DEPLOYMENT
  const { code, stdout, stderr } = await convex(
    ['dashboard', '--deployment', ref, '--no-open'],
    { env, timeoutMs: 60_000 },
  )
  const actual = stdout.match(/\/d\/([a-z0-9-]+)/)?.[1]
  if (code !== 0 || !actual) {
    throw new Error(`cannot resolve ${ref}: ${stderr.trim()}`)
  }
  if (actual !== deployment) {
    throw new Error(
      `${source}: key is for ${deployment}, but ${ref} is ${actual}; refusing to touch it`,
    )
  }
}

async function main([command, ...args]) {
  if (command === 'create') {
    const [ref, envfile, region] = args
    if (!ref || !envfile)
      throw new Error('usage: create <ref> <envfile> [region]')
    const { deployment, url } = await createDeployment(ref, { region })
    writeFileSync(
      envfile,
      `CONVEX_DEPLOYMENT=dev:${deployment}\nVITE_CONVEX_URL=${url}\n`,
    )
    console.log(`▸ wrote ${envfile}`)
  } else if (command === 'auth') {
    const [deployment, siteUrl] = args
    if (!deployment || !siteUrl)
      throw new Error('usage: auth <deployment> <site-url>')
    if (await hasAuthKeys(deployment)) return
    console.log(`▸ setting Convex Auth keys + SITE_URL on ${deployment}`)
    await setAuthKeys(deployment, siteUrl)
  } else {
    throw new Error('usage: convex-instance.mjs create|auth …')
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message)
    process.exit(1)
  })
}
