#!/usr/bin/env node
// The artifact token check (plan gocardless-sandbox-qc.sv, A2): refuse to
// upload QC's output if a secret's value is anywhere in it.
//
//   KEEP_QC_TOKEN=… node scripts/qc-actions/check-artifacts.mjs <dir|file>…
//   GH_TOKEN=… CHECK_SECRETS=GH_TOKEN node …/check-artifacts.mjs <dir|file>…
//
// CHECK_SECRETS names the env variables whose values are looked for
// (space-separated; default KEEP_QC_TOKEN): each step checks for the
// secrets it can see, and every one named must be set.
//
// The repo is public, so its Actions artifacts are too, and a Playwright
// trace or report keeps whatever a test sent. QC never puts the token in
// a browser context (qc/fixtures.ts sends it from Node only), so a hit
// means something broke that rule: nothing is uploaded, and the run says
// so.
//
// It looks inside what it can open, because a plain grep can't see into
// them: zip files (Playwright's traces, and the HTML report's attachments),
// gzip, and base64 `data:` URLs (the HTML report keeps its whole data as
// one, a zip). It looks for the token as it is, in any case, and as JSON,
// URL and base64 (standard and URL-safe, at each of the three
// alignments) would write it, in file contents and in file names.
//
// **Fails closed.** Exit 0 only when every file was read and nothing
// matched. 1: the token was found (the files are named, never the token).
// 2: something couldn't be checked (no token or a short one, an unreadable
// file, a symlink, a zip it can't read, an encrypted or unknown entry):
// treated as a hit by the workflow. It reads the token from the env only,
// never from its arguments, and never prints it.
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { gunzipSync, inflateRawSync } from 'node:zlib'

/** Shorter than this, a match proves little and a miss less. */
export const MIN_TOKEN_LENGTH = 16
/** Containers inside containers: deeper than this can't be checked. */
const MAX_DEPTH = 6

export class Unchecked extends Error {}

/**
 * Every way the token may be written, as Buffers. `caseless` ones are
 * matched against a lower-cased copy of the haystack.
 */
export function needles(token, name = 'KEEP_QC_TOKEN') {
  if (typeof token !== 'string' || token.length < MIN_TOKEN_LENGTH)
    throw new Unchecked(
      `${name} is unset or shorter than ${MIN_TOKEN_LENGTH} characters: nothing can be checked`,
    )
  const caseless = new Set(
    [token, encodeURIComponent(token), JSON.stringify(token).slice(1, -1)].map(
      (s) => s.toLowerCase(),
    ),
  )
  const exact = new Set()
  const raw = Buffer.from(token, 'utf8')
  for (let k = 0; k < 3; k++) {
    const b64 = Buffer.concat([Buffer.alloc(k), raw]).toString('base64')
    // Only the characters the token's bytes alone decide: drop the group
    // the k leading bytes share, and the last group (padding, or bytes
    // that follow the token).
    const core = b64.slice(k ? 4 : 0, b64.length - 4)
    if (core.length < MIN_TOKEN_LENGTH) continue
    exact.add(core)
    exact.add(core.replace(/\+/g, '-').replace(/\//g, '_'))
  }
  return {
    caseless: [...caseless].map((s) => Buffer.from(s, 'utf8')),
    exact: [...exact].map((s) => Buffer.from(s, 'utf8')),
  }
}

function lowerAscii(buf) {
  const out = Buffer.from(buf)
  for (let i = 0; i < out.length; i++) {
    const c = out[i]
    if (c >= 0x41 && c <= 0x5a) out[i] = c + 0x20
  }
  return out
}

function hasNeedle(buf, n) {
  const lower = lowerAscii(buf)
  return (
    n.caseless.some((x) => lower.includes(x)) ||
    n.exact.some((x) => buf.includes(x))
  )
}

// ── zip ─────────────────────────────────────────────────────────────────

const EOCD = 0x06054b50
const EOCD64 = 0x06064b50
const EOCD64_LOCATOR = 0x07064b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50

const isZip = (b) => b.length >= 4 && b.readUInt32LE(0) === LOCAL
const isEmptyZip = (b) => b.length >= 22 && b.readUInt32LE(0) === EOCD
const isGzip = (b) => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b

/** Every entry of a zip: [name, contents]. Throws Unchecked on anything odd. */
export function unzip(buf) {
  let eocd = -1
  for (
    let i = buf.length - 22;
    i >= Math.max(0, buf.length - 22 - 65535);
    i--
  ) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Unchecked('a zip without its end record')
  let count = buf.readUInt16LE(eocd + 10)
  let cdOffset = buf.readUInt32LE(eocd + 16)
  if (count === 0xffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20
    if (loc < 0 || buf.readUInt32LE(loc) !== EOCD64_LOCATOR)
      throw new Unchecked('a zip64 without its locator')
    const at = Number(buf.readBigUInt64LE(loc + 8))
    if (buf.readUInt32LE(at) !== EOCD64)
      throw new Unchecked('a zip64 without its end record')
    count = Number(buf.readBigUInt64LE(at + 32))
    cdOffset = Number(buf.readBigUInt64LE(at + 48))
  }
  const entries = []
  let p = cdOffset
  for (let e = 0; e < count; e++) {
    if (buf.readUInt32LE(p) !== CENTRAL)
      throw new Unchecked('a zip whose central directory is broken')
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    let csize = buf.readUInt32LE(p + 20)
    let usize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    let local = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen)
    // Zip64 sizes and offset, in that order, for each field that's maxed.
    const extra = buf.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen)
    for (let x = 0; x + 4 <= extra.length;) {
      const id = extra.readUInt16LE(x)
      const len = extra.readUInt16LE(x + 2)
      if (id === 0x0001) {
        let q = x + 4
        const next = () => {
          const v = Number(extra.readBigUInt64LE(q))
          q += 8
          return v
        }
        if (usize === 0xffffffff) usize = next()
        if (csize === 0xffffffff) csize = next()
        if (local === 0xffffffff) local = next()
      }
      x += 4 + len
    }
    if (flags & 0x1) throw new Unchecked('an encrypted zip entry')
    if (buf.readUInt32LE(local) !== LOCAL)
      throw new Unchecked('a zip entry without its local header')
    const start =
      local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const data = buf.subarray(start, start + csize)
    let body
    if (method === 0) body = data
    else if (method === 8) body = inflateRawSync(data)
    else throw new Unchecked(`a zip entry compressed with method ${method}`)
    if (body.length !== usize)
      throw new Unchecked('a zip entry whose size is not what it says')
    entries.push([name.toString('utf8'), body])
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

// ── the scan ────────────────────────────────────────────────────────────

const DATA_URL =
  /data:[\w.+/-]*(?:;[\w.+-]+=[\w.+-]+)*;base64,([A-Za-z0-9+/=_-]+)/g

/** Where the token is in `buf` (named by `where`), opening what it can. */
export function scan(buf, where, n, depth = 0) {
  if (depth > MAX_DEPTH)
    throw new Unchecked(`${where}: nested deeper than ${MAX_DEPTH}`)
  const hits = []
  if (hasNeedle(buf, n)) hits.push(where)
  if (isZip(buf) || isEmptyZip(buf)) {
    let entries
    try {
      entries = unzip(buf)
    } catch (err) {
      throw err instanceof Unchecked
        ? new Unchecked(`${where}: ${err.message}`)
        : new Unchecked(`${where}: an unreadable zip (${err.message})`)
    }
    for (const [name, body] of entries) {
      const inner = `${where}!${name}`
      if (hasNeedle(Buffer.from(name, 'utf8'), n)) hits.push(`${inner} (name)`)
      hits.push(...scan(body, inner, n, depth + 1))
    }
  } else if (isGzip(buf)) {
    let body
    try {
      body = gunzipSync(buf)
    } catch (err) {
      throw new Unchecked(`${where}: an unreadable gzip (${err.message})`)
    }
    hits.push(...scan(body, `${where}!gunzip`, n, depth + 1))
  }
  // base64 data: URLs, wherever they are (the HTML report's own data is
  // one). latin1 keeps every byte one character, so this never throws.
  const text = buf.toString('latin1')
  let i = 0
  for (const m of text.matchAll(DATA_URL)) {
    const body = Buffer.from(
      m[1],
      m[1].includes('-') || m[1].includes('_') ? 'base64url' : 'base64',
    )
    hits.push(...scan(body, `${where}#data-url-${i++}`, n, depth + 1))
  }
  return hits
}

/** Every file under the paths (directories walked, hidden files too). */
export function files(paths) {
  const out = []
  const walk = (p) => {
    let st
    try {
      st = lstatSync(p)
    } catch (err) {
      throw new Unchecked(`${p}: ${err.code ?? err.message}`)
    }
    if (st.isSymbolicLink()) throw new Unchecked(`${p}: a symlink`)
    if (st.isDirectory()) {
      for (const e of readdirSync(p).sort()) walk(path.join(p, e))
    } else if (st.isFile()) out.push(p)
    else throw new Unchecked(`${p}: not a file or a directory`)
  }
  for (const p of paths) walk(p)
  return out
}

/**
 * Check every file under `paths` for `token`. Returns the hits (empty:
 * clean); throws Unchecked when something couldn't be checked.
 */
export function check(paths, token) {
  // A string is KEEP_QC_TOKEN's value; an object maps names to values.
  const secrets =
    typeof token === 'object' && token ? token : { KEEP_QC_TOKEN: token }
  const all = Object.entries(secrets).map(([name, v]) => needles(v, name))
  if (!all.length)
    throw new Unchecked('no secret named: nothing can be checked')
  const n = {
    caseless: all.flatMap((x) => x.caseless),
    exact: all.flatMap((x) => x.exact),
  }
  const hits = []
  for (const f of files(paths)) {
    if (hasNeedle(Buffer.from(f, 'utf8'), n)) hits.push(`${f} (name)`)
    let buf
    try {
      buf = readFileSync(f)
    } catch (err) {
      throw new Unchecked(`${f}: ${err.code ?? err.message}`)
    }
    hits.push(...scan(buf, f, n))
  }
  return hits
}

/** `s` with the token (in any case) blanked: for what this prints. */
export function redact(s, token, name = 'KEEP_QC_TOKEN') {
  // A token too short to check is too short to blank sensibly.
  if (!token || token.length < MIN_TOKEN_LENGTH) return String(s)
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return String(s).replace(new RegExp(esc, 'gi'), `[${name}]`)
}

/** The secrets CHECK_SECRETS names (default KEEP_QC_TOKEN), from the env. */
export function secretsFromEnv(env = process.env) {
  const names = (env.CHECK_SECRETS || 'KEEP_QC_TOKEN')
    .split(/\s+/)
    .filter(Boolean)
  return Object.fromEntries(names.map((n) => [n, env[n]]))
}

const redactAll = (s, secrets) =>
  Object.entries(secrets).reduce((acc, [n, v]) => redact(acc, v, n), String(s))

function main() {
  const secrets = secretsFromEnv()
  const named = Object.keys(secrets).join(', ')
  const paths = process.argv.slice(2)
  if (!paths.length) {
    console.error('usage: KEEP_QC_TOKEN=… check-artifacts.mjs <dir|file>…')
    process.exit(2)
  }
  try {
    const n = files(paths).length
    const hits = check(paths, secrets)
    if (hits.length) {
      console.log(
        `::error::${named === 'KEEP_QC_TOKEN' ? "KEEP_QC_TOKEN's value" : `a value of ${named}`} is in ${hits.length} place(s) of QC's output: nothing will be uploaded.`,
      )
      for (const h of hits) console.log(`  ${redactAll(h, secrets)}`)
      process.exit(1)
    }
    console.log(
      `artifact check: ${n} files, no ${named} in any (${paths.join(', ')})`,
    )
  } catch (err) {
    if (!(err instanceof Unchecked)) throw err
    console.log(
      `::error::artifact check could not check everything: ${redactAll(err.message, secrets)}. Nothing will be uploaded.`,
    )
    process.exit(2)
  }
}

if (process.argv[1] === import.meta.filename) {
  try {
    main()
  } catch (err) {
    // Never the token: only the error's own message.
    console.log(
      `::error::artifact check failed: ${redactAll(err?.message ?? err, secretsFromEnv())}. Nothing will be uploaded.`,
    )
    process.exit(2)
  }
}
