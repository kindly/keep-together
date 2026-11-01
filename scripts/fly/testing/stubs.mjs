// A sandbox for testing the scripts/fly/*.sh the human runs, without
// Fly, GitHub or GoCardless. Every command found on PATH is replaced by a
// wrapper that logs its argv and then runs the real one, so a test can
// prove a secret never reached any process's argv, not only the mocked
// ones. `fly`, `gh` and `curl` (and `date`, when asked) are mocks
// (mock.sh) that answer from files in the sandbox's state dir and log
// what they read on stdin.
import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const here = import.meta.dirname
export const repo = path.resolve(here, '../../..')
const realPath = process.env.PATH ?? '/usr/bin:/bin'
const SEP = '\x1f'

const WRAP = `#!/bin/bash
name=\${0##*/}
{ printf '%s' "$name"; printf '\\x1f%s' "$@"; printf '\\n'; } >>"$STUB_LOG/argv.log"
IFS=:
for d in $STUB_REAL_PATH; do
  if [[ -x $d/$name && ! -d $d/$name ]]; then exec "$d/$name" "$@"; fi
done
echo "stub: no $name" >&2
exit 127
`

export function sandbox(mocks = ['fly', 'gh', 'curl']) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fly-script-test-'))
  const bin = path.join(dir, 'bin')
  const state = path.join(dir, 'state')
  const tmp = path.join(dir, 'tmp')
  for (const d of [bin, state, tmp]) mkdirSync(d)
  writeFileSync(path.join(dir, 'wrap.sh'), WRAP, { mode: 0o755 })
  const seen = new Set(mocks)
  for (const m of mocks) symlinkSync(path.join(here, 'mock.sh'), path.join(bin, m))
  for (const d of realPath.split(':')) {
    let names
    try {
      names = readdirSync(d)
    } catch {
      continue
    }
    for (const n of names) {
      if (seen.has(n)) continue
      try {
        const st = statSync(path.join(d, n))
        if (!st.isFile() || !(st.mode & 0o111)) continue
      } catch {
        continue
      }
      seen.add(n)
      symlinkSync(path.join(dir, 'wrap.sh'), path.join(bin, n))
    }
  }

  const env = (extra = {}) => ({
    HOME: dir,
    LANG: 'C.UTF-8',
    PATH: bin,
    TMPDIR: tmp,
    STUB_LOG: state,
    STUB_STATE: state,
    STUB_REAL_PATH: realPath,
    ...extra,
  })
  const file = (name) => path.join(state, name)
  const read = (name) => (existsSync(file(name)) ? readFileSync(file(name), 'utf8') : '')

  return {
    dir,
    tmp,
    /** Seed a state file the mocks answer from. */
    set: (name, value) =>
      writeFileSync(file(name), typeof value === 'string' ? value : JSON.stringify(value)),
    read,
    json: (name) => JSON.parse(read(name) || 'null'),
    /** Every command run: [name, ...args]. */
    argv: () =>
      read('argv.log')
        .split('\n')
        .filter(Boolean)
        .map((l) => l.split(SEP)),
    /** What the mocks read on stdin: [{cmd, body}]. */
    stdin: () =>
      read('stdin.log')
        .split('\u0000')
        .filter(Boolean)
        .map((rec) => {
          const nl = rec.indexOf('\n')
          return { cmd: rec.slice(0, nl), body: rec.slice(nl + 1) }
        }),
    clearLogs: () => {
      for (const f of ['argv.log', 'stdin.log']) rmSync(file(f), { force: true })
    },
    /** The script with stdin piped (not a terminal). */
    run(script, args = [], { input = '', extraEnv = {} } = {}) {
      const r = spawnSync('/usr/bin/bash', [path.join(repo, script), ...args], {
        cwd: repo,
        env: env(extraEnv),
        input,
        encoding: 'utf8',
        timeout: 30_000,
      })
      return { code: r.status, stdout: r.stdout, stderr: r.stderr }
    },
    /**
     * The script on a terminal (script(1)'s pty), its own stdout and
     * stderr captured apart from the terminal's echo. Each step is a line
     * to type, or a function of the stdout so far that returns the line
     * once it can (null: not yet).
     */
    runTty(script, steps, { extraEnv = {} } = {}) {
      const out = path.join(dir, 'out.txt')
      const err = path.join(dir, 'err.txt')
      rmSync(out, { force: true })
      rmSync(err, { force: true })
      const cmd = `exec /usr/bin/bash ${JSON.stringify(path.join(repo, script))} >${JSON.stringify(out)} 2>${JSON.stringify(err)}`
      const child = spawn('/usr/bin/script', ['-qefc', cmd, '/dev/null'], {
        cwd: repo,
        env: env(extraEnv),
        stdio: ['pipe', 'ignore', 'ignore'],
      })
      const readOut = () => (existsSync(out) ? readFileSync(out, 'utf8') : '')
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          reject(new Error(`timed out; stdout so far:\n${readOut()}`))
        }, 20_000)
        let i = 0
        let done = false
        const feed = () => {
          if (done) return
          while (i < steps.length) {
            const s = steps[i]
            const line = typeof s === 'function' ? s(readOut()) : s
            if (line == null) return void setTimeout(feed, 50)
            child.stdin.write(line + '\n')
            i++
          }
        }
        child.on('exit', (code) => {
          done = true
          clearTimeout(timer)
          resolve({
            code,
            stdout: readOut(),
            stderr: existsSync(err) ? readFileSync(err, 'utf8') : '',
          })
        })
        // Give the script its first prompt before typing.
        setTimeout(feed, 200)
      })
    },
    /** Files left in the script's TMPDIR. */
    tmpFiles: () => readdirSync(tmp),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

/** Fail if any secret appears in any command's argv or in the text. */
export function assertNowhere(secrets, { argv, texts }) {
  for (const s of secrets) {
    if (!s) throw new Error('an empty secret proves nothing')
    for (const a of argv) {
      if (a.some((x) => x.includes(s))) throw new Error(`a secret in argv: ${a[0]} …`)
    }
    for (const [name, t] of Object.entries(texts)) {
      if (t.includes(s)) throw new Error(`a secret in ${name}`)
    }
  }
}
