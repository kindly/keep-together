// @vitest-environment node
// scripts/qc-actions/{run,report,history,status}.sh with pnpm, gh and curl
// stubbed on PATH (jq, node, unzip and the rest are real): what each run
// of .github/workflows/qc.yml decides, writes and alerts on. Never runs
// QC, never reaches GitHub.
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { zip } from './testing/zip.mjs'

const here = import.meta.dirname
const TOKEN = '3f9a1c0e7b2d4f6a8c1e3b5d7f9a2c4e6b8d0f1a3c5e7b9d2f4a6c8e0b1d3f5a'
const SHA = 'a'.repeat(40)
const SHA2 = 'b'.repeat(40)

// Every stub logs its argv (\x1f-separated) to $S/argv.log.
const LOG = `{ printf '%s' "\${0##*/}"; for a in "$@"; do printf '\\x1f%s' "\${a//$'\\n'/\\\\n}"; done; printf '\\n'; } >>"$S/argv.log"`

// pnpm: `qc --target qc` appends $S/lines to qc-results/history.jsonl,
// writes a report (with $S/leak in it when present) and exits $S/qc-exit;
// it notes whether KEEP_QC_TOKEN reached its env. `qc:report` writes the
// trend page.
const PNPM = `#!/bin/bash
${LOG}
case "$*" in
"qc --target qc")
  [ -z "\${KEEP_QC_TOKEN:-}" ] || echo yes >"$S/token-seen"
  mkdir -p qc-results qc-report/playwright
  [ ! -f "$S/lines" ] || cat "$S/lines" >>qc-results/history.jsonl
  echo '<html>report</html>' >qc-report/playwright/index.html
  [ ! -f "$S/leak" ] || cat "$S/leak" >>qc-report/playwright/index.html
  exit "$(cat "$S/qc-exit" 2>/dev/null || echo 0)"
  ;;
"qc:report") mkdir -p qc-report; echo '<html>trend</html>' >qc-report/trend.html ;;
*) echo "pnpm stub: $*" >&2; exit 2 ;;
esac
`

// gh: answers from $S files, through --jq like gh does (raw strings).
const GH = `#!/bin/bash
${LOG}
jqx=""
args=()
while [ $# -gt 0 ]; do
  case $1 in
  --jq) jqx=$2; shift 2 ;;
  *) args+=("$1"); shift ;;
  esac
done
set -- "\${args[@]}"
answer() {
  [ ! -f "$S/fail-$1" ] || exit 1
  if [ -n "$jqx" ]; then jq -r "$jqx" "$S/$1"; else cat "$S/$1"; fi
}
case "$1 $2" in
"api repos/o/r/actions/workflows/qc.yml/runs?branch=main&status=completed&per_page=30") answer qc-runs.json ;;
"api repos/o/r/actions/runs/"*"/artifacts?name=qc-history")
  id=\${2#repos/o/r/actions/runs/}; id=\${id%%/*}
  [ -f "$S/run-$id-artifacts.json" ] || echo '{"artifacts":[]}' >"$S/run-$id-artifacts.json"
  answer "run-$id-artifacts.json"
  ;;
"api repos/o/r/actions/artifacts/"*"/zip")
  [ ! -f "$S/fail-zip" ] || exit 1
  id=\${2#repos/o/r/actions/artifacts/}; cat "$S/artifact-\${id%%/*}.zip"
  ;;
"issue list") answer issues.json ;;
"issue comment" | "issue create" | "label create") ;;
"run list") answer runs.json ;;
*) echo "gh stub: $*" >&2; exit 2 ;;
esac
`

// curl: keep-qc's /healthz answers $S/healthz, or fails without it.
const CURL = `#!/bin/bash
${LOG}
[ -f "$S/healthz" ] || exit 7
cat "$S/healthz"
`

let dir, S, bin
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'qc-actions-'))
  S = path.join(dir, 'state')
  bin = path.join(dir, 'bin')
  for (const d of [S, bin, path.join(dir, 'ws'), path.join(dir, 'prev')])
    mkdirSync(d)
  for (const [n, body] of [
    ['pnpm', PNPM],
    ['gh', GH],
    ['curl', CURL],
  ])
    writeFileSync(path.join(bin, n), body, { mode: 0o755 })
  set('qc-runs.json', { workflow_runs: [] })
  set('issues.json', [])
  set('runs.json', [])
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function set(name, value) {
  writeFileSync(
    path.join(S, name),
    typeof value === 'string' || Buffer.isBuffer(value)
      ? value
      : JSON.stringify(value),
  )
}
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '')
const ws = (...p) => path.join(dir, 'ws', ...p)
const argv = () =>
  read(path.join(S, 'argv.log'))
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\x1f'))

function sh(script, args, env = {}) {
  const out = path.join(dir, 'gh-output')
  const summary = path.join(dir, 'summary')
  rmSync(out, { force: true })
  const r = spawnSync('bash', [path.join(here, script), ...args], {
    cwd: ws(),
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: dir,
      TMPDIR: dir,
      S,
      GITHUB_OUTPUT: out,
      GITHUB_STEP_SUMMARY: summary,
      GH_REPO: 'o/r',
      ...env,
    },
    encoding: 'utf8',
  })
  const outputs = Object.fromEntries(
    read(out)
      .split('\n')
      .filter(Boolean)
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  )
  return {
    code: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    outputs,
    summary: read(summary),
  }
}

const line = (runId, flow, over = {}) =>
  JSON.stringify({
    runId,
    flow,
    pass: true,
    overBudget: 0,
    rttMs: 84,
    rttOver: false,
    samplesMs: [90],
    ...over,
  })

describe('run.sh: QC, then the check', () => {
  const run = (env = {}) =>
    sh('run.sh', [path.join(dir, 'prev')], {
      KEEP_QC_TOKEN: TOKEN,
      QC_TARGET_URL: 'https://keep-qc.fly.dev',
      ...env,
    })

  test('a clean run: the outputs, the last history kept first, the token only in pnpm’s env', () => {
    writeFileSync(
      path.join(dir, 'prev', 'history.jsonl'),
      line('old', 'contact.save') + '\n',
    )
    set(
      'lines',
      [
        line('r1', 'contact.save'),
        line('r1', 'contact.archive', { rttMs: 90 }),
      ].join('\n') + '\n',
    )
    const r = run()
    expect(r.code).toBe(0)
    expect(r.outputs).toEqual({
      exit: '0',
      flows: '2',
      over: '0',
      rtt: '90',
      rttover: '0',
      retries: '0',
      unbudgeted: '0',
      failed: '',
      check: 'clean',
    })
    expect(
      read(ws('qc-results', 'history.jsonl')).split('\n').filter(Boolean),
    ).toHaveLength(3)
    expect(read(path.join(S, 'token-seen'))).toBe('yes\n')
    expect(
      argv()
        .filter((a) => a[0] === 'pnpm')
        .map((a) => a.slice(1)),
    ).toEqual([['qc', '--target', 'qc'], ['qc:report']])
    for (const a of argv()) expect(a.join(' ')).not.toContain(TOKEN)
    expect(r.stdout + r.stderr).not.toContain(TOKEN)
  })

  test('QC failed: its exit and the failing flows, and the output still checked and cleared', () => {
    set(
      'lines',
      [
        line('r1', 'contact.save', { pass: false, overBudget: 2 }),
        line('r1', 'gift.open', { unbudgeted: true }),
      ].join('\n') + '\n',
    )
    set('qc-exit', '1')
    const r = run()
    expect(r.code).toBe(0)
    expect(r.outputs).toMatchObject({
      exit: '1',
      over: '1',
      unbudgeted: '1',
      failed: 'contact.save',
      check: 'clean',
    })
  })

  test('the token in the report: refused, exit 1, the counts still out', () => {
    set('lines', line('r1', 'contact.save') + '\n')
    set('leak', `<script>x-keep-qc-token: ${TOKEN}</script>`)
    const r = run()
    expect(r.code).toBe(1)
    expect(r.outputs).toMatchObject({ exit: '0', flows: '1', check: 'refused' })
    expect(r.stdout).toContain("KEEP_QC_TOKEN's value is in 1 place(s)")
    expect(r.stdout).not.toContain(TOKEN)
  })

  test('the last history is validated again before it seeds the reporter', () => {
    writeFileSync(
      path.join(dir, 'prev', 'history.jsonl'),
      [line('old', 'contact.save'), '{"forged":true}', 'junk'].join('\n') +
        '\n',
    )
    set('lines', line('r1', 'contact.save') + '\n')
    const r = run()
    expect(r.code).toBe(0)
    const h = read(ws('qc-results', 'history.jsonl'))
      .split('\n')
      .filter(Boolean)
    expect(h.map((l) => JSON.parse(l).runId)).toEqual(['old', 'r1'])
    expect(r.outputs.flows).toBe('1')
  })

  test('no token in its env: QC can’t be checked, so nothing is cleared', () => {
    set('lines', line('r1', 'contact.save') + '\n')
    const r = run({ KEEP_QC_TOKEN: '' })
    expect(r.code).toBe(1)
    expect(r.outputs.check).toBe('refused')
  })
})

describe('report.sh: the verdict', () => {
  const ok = {
    QC_URL: 'https://keep-qc.fly.dev',
    COMMIT: SHA,
    MODE: 'assert',
    STEPS: 'commit=success checkout=success install=success history=success',
    QC_OUTCOME: 'success',
    QC_EXIT: '0',
    QC_FLOWS: '120',
    QC_OVER: '0',
    QC_RTT: '84',
    QC_RTTOVER: '0',
    QC_RETRIES: '0',
    QC_UNBUDGETED: '0',
    QC_FAILED: '',
    QC_CHECK: 'clean',
    HISTORY_FETCHED: 'true',
    RUN_ID: '9001',
    RUN_URL: 'https://github.com/o/r/actions/runs/9001',
    EVENT: 'schedule',
    GH_TOKEN: 'gh-token',
  }
  const report = (env = {}) =>
    sh('report.sh', [], {
      PREV: path.join(dir, 'prev'),
      OUT: path.join(dir, 'out'),
      ...ok,
      ...env,
    })
  const runsLog = () =>
    read(path.join(dir, 'out', 'runs.log'))
      .split('\n')
      .filter(Boolean)
  const issues = () =>
    argv().filter((a) => a[0] === 'gh' && a[1] === 'issue' && a[2] !== 'list')
  const hoursAgo = (h) =>
    new Date(Date.now() - h * 3600e3).toISOString().slice(0, 19) + 'Z'

  beforeEach(() => {
    set('healthz', JSON.stringify({ ok: true, commit: SHA }))
    mkdirSync(ws('qc-results'), { recursive: true })
    writeFileSync(
      ws('qc-results', 'history.jsonl'),
      line('r1', 'contact.save') + '\n',
    )
    writeFileSync(
      path.join(dir, 'prev', 'history.jsonl'),
      line('r0', 'contact.save') + '\n',
    )
  })

  test('pass: one runs.log line, this run’s history in the next link, no issue, exit 0', () => {
    const r = report()
    expect(r.code).toBe(0)
    const [l] = runsLog()
    expect(l).toMatch(
      new RegExp(
        `^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ run=9001 event=schedule commit=${SHA} result=pass flows=120 over=0 rtt=84 rttover=0 retries=0 unbudgeted=0$`,
      ),
    )
    expect(read(path.join(dir, 'out', 'history.jsonl'))).toContain(
      '"runId":"r1"',
    )
    expect(issues()).toEqual([])
    expect(r.summary).toContain('QC against keep-qc: pass')
  })

  test('fail: opens the qc-nightly issue, or comments on the open one; exit 1', () => {
    const r = report({ QC_EXIT: '1', QC_FAILED: 'contact.save,gift.open' })
    expect(r.code).toBe(1)
    expect(runsLog()[0]).toMatch(/ result=fail .* exit=1$/)
    const [create] = issues()
    expect(create.slice(1, 5)).toEqual([
      'issue',
      'create',
      '--label',
      'qc-nightly',
    ])
    const body = create[create.indexOf('--body') + 1]
    expect(body).toContain('**fail**')
    expect(body).toContain('flows that failed: contact.save, gift.open')
    expect(body).toContain('https://github.com/o/r/actions/runs/9001')
    rmSync(path.join(S, 'argv.log'))
    set('issues.json', [{ number: 42 }])
    report({ QC_EXIT: '1' })
    expect(issues()[0].slice(1, 4)).toEqual(['issue', 'comment', '42'])
  })

  test('a step before QC failed: error step=<it>; the last history carried on', () => {
    const r = report({
      STEPS: 'commit=success checkout=success install=failure history=skipped',
      QC_OUTCOME: 'skipped',
      QC_EXIT: '',
      QC_CHECK: '',
    })
    expect(r.code).toBe(1)
    expect(runsLog()[0]).toMatch(/ result=error step=install$/)
    expect(read(path.join(dir, 'out', 'history.jsonl'))).toContain(
      '"runId":"r0"',
    )
    expect(read(path.join(dir, 'out', 'history.jsonl'))).not.toContain(
      '"runId":"r1"',
    )
    expect(issues()).toHaveLength(1)
  })

  test('the check refused: error step=artifact-check, and this run’s history goes nowhere', () => {
    const r = report({ QC_CHECK: 'refused' })
    expect(r.code).toBe(1)
    expect(runsLog()[0]).toMatch(/ result=error step=artifact-check$/)
    expect(read(path.join(dir, 'out', 'history.jsonl'))).not.toContain(
      '"runId":"r1"',
    )
    // QC died before writing its outputs: error step=qc.
    report({ QC_CHECK: '', QC_EXIT: '' })
    expect(runsLog()[0]).toMatch(/ result=error step=qc$/)
  })

  test('keep-qc moved during the run: void, no alert the first time; the second void in a row alerts', () => {
    set('healthz', JSON.stringify({ commit: SHA2 }))
    const r = report({ QC_EXIT: '1' })
    expect(r.code).toBe(0)
    expect(runsLog()[0]).toMatch(
      new RegExp(` result=void .*exit=1 reason=commit-changed now=${SHA2}$`),
    )
    expect(issues()).toEqual([])
    writeFileSync(path.join(dir, 'prev', 'runs.log'), runsLog()[0] + '\n')
    const again = report()
    expect(again.code).toBe(1)
    expect(runsLog()).toHaveLength(2)
    const body = issues()[0][issues()[0].indexOf('--body') + 1]
    expect(body).toContain('The last 2 runs were void')
  })

  test('36 h with no pass, fail or error: a void alerts', () => {
    writeFileSync(
      path.join(dir, 'prev', 'runs.log'),
      [
        `${hoursAgo(40)} run=1 event=schedule commit=${SHA} result=pass flows=1`,
        `${hoursAgo(30)} run=2 event=push commit=${SHA} result=void reason=rtt-over-ceiling`,
        `${hoursAgo(20)} run=3 event=push commit=${SHA} result=record flows=1`,
      ].join('\n') + '\n',
    )
    const r = report({ QC_RTTOVER: '3' })
    expect(runsLog()[3]).toMatch(/ result=void .* reason=rtt-over-ceiling$/)
    // run=2 and this one are void, with a record run between: lasting.
    expect(r.code).toBe(1)
    expect(issues()).toHaveLength(1)
  })

  test('no budgets on this target yet: void, never an alert on its own', () => {
    writeFileSync(
      path.join(dir, 'prev', 'runs.log'),
      `${hoursAgo(50)} run=1 event=push commit=${SHA} result=void reason=no-budgets\n`,
    )
    const r = report({ QC_UNBUDGETED: '120' })
    expect(r.code).toBe(0)
    expect(runsLog()[1]).toMatch(
      / result=void .*unbudgeted=120 reason=no-budgets$/,
    )
    expect(issues()).toEqual([])
    expect(r.summary).toContain('no budgets on this target yet for 120 flows')
  })

  test('no-budgets voids are not among the voids in a row, and restart the 36 h clock (L2)', () => {
    const nb = (h, run) =>
      `${hoursAgo(h)} run=${run} event=push commit=${SHA} result=void reason=no-budgets`
    // A no-budgets void, then one real void: not two in a row.
    writeFileSync(path.join(dir, 'prev', 'runs.log'), nb(1, 1) + '\n')
    set('healthz', JSON.stringify({ commit: SHA2 }))
    expect(report().code).toBe(0)
    expect(issues()).toEqual([])
    // Two real voids around a no-budgets one: two in a row, it alerts.
    writeFileSync(
      path.join(dir, 'prev', 'runs.log'),
      [
        `${hoursAgo(3)} run=1 event=push commit=${SHA} result=void reason=commit-changed now=${SHA2}`,
        nb(2, 2),
      ].join('\n') + '\n',
    )
    expect(report().code).toBe(1)
    // 40 h since the last pass, but a no-budgets run 10 h ago: no alert.
    rmSync(path.join(S, 'argv.log'))
    writeFileSync(
      path.join(dir, 'prev', 'runs.log'),
      [
        `${hoursAgo(40)} run=1 event=schedule commit=${SHA} result=pass flows=1`,
        nb(10, 2),
      ].join('\n') + '\n',
    )
    expect(report().code).toBe(0)
    expect(issues()).toEqual([])
  })

  test('keep-qc runs a commit that isn’t on main: void commit-not-on-main, nothing run (L1)', () => {
    const r = report({
      STEPS:
        'commit=success checkout=success onmain=failure install=skipped history=skipped',
      QC_OUTCOME: 'skipped',
      QC_EXIT: '',
      QC_CHECK: '',
    })
    expect(r.code).toBe(0)
    expect(runsLog()[0]).toMatch(/ result=void reason=commit-not-on-main$/)
    expect(issues()).toEqual([])
  })

  test('record mode: result=record, never an alert, whatever QC said', () => {
    const r = report({ MODE: 'record', QC_EXIT: '1' })
    expect(r.code).toBe(0)
    expect(runsLog()[0]).toMatch(/ result=record /)
    expect(issues()).toEqual([])
  })

  test('keep-qc unreachable afterwards: a fail stays a fail (qc-check=unknown); a pass is void', () => {
    rmSync(path.join(S, 'healthz'))
    expect(report({ QC_EXIT: '1' }).code).toBe(1)
    expect(runsLog()[0]).toMatch(/ result=fail .* qc-check=unknown$/)
    report()
    expect(runsLog()[0]).toMatch(/ result=void .* reason=qc-check-unknown$/)
  })

  test('nothing timed: error; no history artifact when the last one wasn’t read', () => {
    expect(report({ QC_FLOWS: '0' }).code).toBe(1)
    expect(runsLog()[0]).toMatch(/ result=error .* step=no-history-lines$/)
    rmSync(path.join(dir, 'out'), { recursive: true })
    report({ HISTORY_FETCHED: 'false' })
    expect(existsSync(path.join(dir, 'out'))).toBe(false)
  })

  test('only words and numbers reach runs.log, the summary and the issue', () => {
    const r = report({
      QC_EXIT: '1',
      QC_FAILED: 'a.b,$(touch pwned)',
      EVENT: 'push; rm -rf /',
      COMMIT: 'not-a-sha',
      QC_RTT: '84ms',
    })
    // keep-qc answers a commit that isn't the (dropped) one given: void.
    expect(r.code).toBe(0)
    expect(existsSync(ws('pwned'))).toBe(false)
    const [l] = runsLog()
    expect(l).toMatch(/ run=9001 event=none commit=none result=void /)
    expect(l).toContain(' rtt= ')
    expect(r.summary).not.toContain('pwned')
  })
})

describe('history.sh: the artifact chain', () => {
  // A run of a workflow, as GitHub's API lists it.
  const ghRun = (id, over = {}) => ({
    id,
    path: '.github/workflows/qc.yml',
    head_branch: 'main',
    event: 'schedule',
    created_at: `2026-11-0${id}T03:00:00Z`,
    repository: { full_name: 'o/r' },
    head_repository: { full_name: 'o/r' },
    ...over,
  })
  const artifactOf = (run, aid, entries, expired = false) => {
    set(`run-${run}-artifacts.json`, {
      artifacts: [{ id: aid, name: 'qc-history', expired }],
    })
    set(`artifact-${aid}.zip`, zip(entries))
  }
  const RUNS_LINE = `2026-11-01T03:00:00Z run=5 event=schedule commit=${SHA} result=pass flows=1`
  const into = () => path.join(dir, 'h')

  test('fetch: none yet is an empty start; else the newest qc.yml run on main with one', () => {
    const none = sh('history.sh', ['fetch', into()])
    expect(none.code, none.stderr + none.stdout).toBe(0)
    expect(none.stdout).toContain('::notice::no qc-history artifact')
    expect(read(path.join(into(), 'history.jsonl'))).toBe('')
    set('qc-runs.json', {
      workflow_runs: [ghRun(5), ghRun(7), ghRun(6, { event: 'workflow_run' })],
    })
    // Run 7, the newest, has none (or only an expired one): run 6's is taken.
    artifactOf(7, 70, [['history.jsonl', line('r7', 'x') + '\n']], true)
    artifactOf(6, 60, [
      ['history.jsonl', line('r6', 'x') + '\n'],
      ['runs.log', RUNS_LINE + '\n'],
    ])
    artifactOf(5, 50, [['history.jsonl', line('r5', 'x') + '\n']])
    const r = sh('history.sh', ['fetch', into()])
    expect(r.code, r.stderr).toBe(0)
    expect(argv().at(-1).slice(1, 3)).toEqual([
      'api',
      'repos/o/r/actions/artifacts/60/zip',
    ])
    expect(read(path.join(into(), 'history.jsonl'))).toContain('"runId":"r6"')
    expect(read(path.join(into(), 'runs.log'))).toBe(RUNS_LINE + '\n')
  })

  test('fetch: never from another workflow, branch, fork, or a pull request’s event', () => {
    set('qc-runs.json', {
      workflow_runs: [
        ghRun(1),
        ghRun(2, { path: '.github/workflows/ci.yml' }),
        ghRun(3, { head_branch: 'feat/x' }),
        ghRun(4, { head_repository: { full_name: 'evil/r' } }),
        ghRun(5, { event: 'pull_request' }),
        ghRun(6, { event: 'push' }),
        ghRun(7, { repository: { full_name: 'evil/r' } }),
      ],
    })
    for (const run of [2, 3, 4, 5, 6, 7])
      artifactOf(run, run * 10, [
        ['history.jsonl', line(`forged${run}`, 'x') + '\n'],
      ])
    artifactOf(1, 10, [['history.jsonl', line('r1', 'x') + '\n']])
    const r = sh('history.sh', ['fetch', into()])
    expect(r.code, r.stderr).toBe(0)
    expect(read(path.join(into(), 'history.jsonl'))).toContain('"runId":"r1"')
    expect(read(path.join(into(), 'history.jsonl'))).not.toContain('forged')
    // Only run 1's artifacts were ever asked for.
    expect(
      argv()
        .filter((a) => a[0] === 'gh' && /\/runs\/\d+\/artifacts/.test(a[2]))
        .map((a) => a[2]),
    ).toEqual(['repos/o/r/actions/runs/1/artifacts?name=qc-history'])
  })

  test('fetch: a link entry, or any other entry, is refused; nothing is ever written from the zip', () => {
    set('qc-runs.json', { workflow_runs: [ghRun(1)] })
    // history.jsonl -> /proc/self/environ: would copy GH_TOKEN out.
    artifactOf(1, 10, [['history.jsonl', '/proc/self/environ', 0o120777]])
    const link = sh('history.sh', ['fetch', into()], {
      GH_TOKEN: 'ghs_secret_value_1234567890',
    })
    expect(link.code).toBe(1)
    expect(link.stderr).toContain('holds a link')
    expect(read(path.join(into(), 'history.jsonl'))).toBe('')
    artifactOf(1, 10, [
      ['history.jsonl', line('r1', 'x') + '\n'],
      ['../escape', 'x'],
    ])
    const other = sh('history.sh', ['fetch', into()])
    expect(other.code).toBe(1)
    expect(other.stderr).toContain('holds ../escape')
    expect(existsSync(path.join(dir, 'escape'))).toBe(false)
  })

  test('fetch: forged and oversized lines are dropped, every line validated', () => {
    set('qc-runs.json', { workflow_runs: [ghRun(1)] })
    artifactOf(1, 10, [
      [
        'history.jsonl',
        [
          line('r1', 'ok'),
          '{"runId":"r1"}',
          '[1,2]',
          'not json',
          JSON.stringify({
            runId: 'r1',
            flow: 'big',
            samplesMs: ['x'.repeat(1_100_000)],
          }),
        ].join('\n') + '\n',
      ],
      [
        'runs.log',
        [
          RUNS_LINE,
          `2026-11-02T03:00:00Z run=6 event=schedule commit=${SHA} result=pass flows=1 $(touch x)`,
          'streak: 7 passing nights',
          `2026-11-02T03:00:00Z run=6 event=schedule commit=${SHA} result=great`,
        ].join('\n') + '\n',
      ],
    ])
    const r = sh('history.sh', ['fetch', into()])
    expect(r.code, r.stderr).toBe(0)
    const h = read(path.join(into(), 'history.jsonl'))
      .split('\n')
      .filter(Boolean)
    expect(h.map((l) => JSON.parse(l).flow)).toEqual(['ok'])
    expect(read(path.join(into(), 'runs.log'))).toBe(RUNS_LINE + '\n')
    expect(r.stderr).toContain('dropped 4 history line(s)')
    expect(r.stderr).toContain('dropped 3 runs.log line(s)')
  })

  test('fetch: GitHub failing is a failure, never an empty history', () => {
    set('fail-qc-runs.json', '')
    expect(sh('history.sh', ['fetch', into()]).code).toBe(1)
    rmSync(path.join(S, 'fail-qc-runs.json'))
    set('qc-runs.json', { workflow_runs: [ghRun(1)] })
    artifactOf(1, 10, [['history.jsonl', '']])
    set('fail-zip', '')
    expect(sh('history.sh', ['fetch', into()]).code).toBe(1)
  })

  test('build: the last N runs of history, unreadable lines dropped; runs.log appended', () => {
    const h = ws('h.jsonl')
    writeFileSync(
      h,
      ['r1', 'r1', 'r2', 'r3', 'r3']
        .map((r, i) => line(r, `f${i}`))
        .join('\n') + '\n{broken\n',
    )
    writeFileSync(path.join(dir, 'prev', 'runs.log'), 'a\nb\n')
    const r = sh(
      'history.sh',
      ['build', path.join(dir, 'out'), path.join(dir, 'prev'), h, 'c'],
      {
        QC_HISTORY_RUNS: '2',
      },
    )
    expect(r.code).toBe(0)
    const kept = read(path.join(dir, 'out', 'history.jsonl'))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l).runId)
    expect(kept).toEqual(['r2', 'r3', 'r3'])
    expect(read(path.join(dir, 'out', 'runs.log'))).toBe('a\nb\nc\n')
  })
})

describe('status.sh: the streak', () => {
  // Nights run noon to noon UTC: 03:00 on the 5th is the night of the 4th.
  const pass = (at, run) =>
    `${at} run=${run} event=schedule commit=${SHA} result=pass flows=120 over=0 rtt=84`
  const withLog = (lines, runs = []) => {
    set('qc-runs.json', {
      workflow_runs: [
        {
          id: 3,
          path: '.github/workflows/qc.yml',
          head_branch: 'main',
          event: 'schedule',
          created_at: '2026-11-05T03:00:00Z',
          repository: { full_name: 'o/r' },
          head_repository: { full_name: 'o/r' },
        },
      ],
    })
    set('run-3-artifacts.json', {
      artifacts: [{ id: 30, name: 'qc-history', expired: false }],
    })
    set(
      'artifact-30.zip',
      zip([
        ['history.jsonl', ''],
        ['runs.log', lines.join('\n') + '\n'],
      ]),
    )
    set('runs.json', runs)
  }

  test('passing nights in a row, a post-deploy run counted on its night', () => {
    withLog([
      `2026-11-01T03:00:00Z run=1 event=schedule commit=${SHA} result=fail flows=120 over=1 exit=1`,
      pass('2026-11-02T03:00:00Z', 2),
      pass('2026-11-02T15:00:00Z', 3),
      pass('2026-11-03T03:00:00Z', 4),
      pass('2026-11-04T03:00:00Z', 5),
    ])
    const r = sh('status.sh', [])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain(
      'streak: 3 passing night(s) in a row (4 run(s)), the latest the night of 2026-11-03',
    )
    expect(r.stdout).toMatch(/result=|fail/)
    expect(r.stdout).toContain('issue    none open')
  })

  test('a void, a missed night, or a run that never recorded ends it', () => {
    withLog([
      pass('2026-11-01T03:00:00Z', 1),
      `2026-11-02T03:00:00Z run=2 event=schedule commit=${SHA} result=void reason=commit-changed`,
      pass('2026-11-03T03:00:00Z', 3),
    ])
    expect(sh('status.sh', []).stdout).toContain('streak: 1 passing night(s)')
    withLog([pass('2026-11-01T03:00:00Z', 1), pass('2026-11-03T03:00:00Z', 3)])
    expect(sh('status.sh', []).stdout).toContain('streak: 1 passing night(s)')
    withLog(
      [pass('2026-11-01T03:00:00Z', 1), pass('2026-11-02T03:00:00Z', 2)],
      [
        {
          databaseId: 2,
          event: 'schedule',
          status: 'completed',
          conclusion: 'success',
          createdAt: '2026-11-02T03:00:00Z',
          headSha: SHA,
          url: 'u',
        },
        {
          databaseId: 4,
          event: 'schedule',
          status: 'completed',
          conclusion: 'cancelled',
          createdAt: '2026-11-03T03:00:00Z',
          headSha: SHA,
          url: 'u',
        },
        {
          databaseId: 5,
          event: 'workflow_dispatch',
          status: 'in_progress',
          conclusion: '',
          createdAt: '2026-11-03T09:00:00Z',
          headSha: SHA,
          url: 'u5',
        },
      ],
    )
    const r = sh('status.sh', [])
    expect(r.stdout).toMatch(
      /2026-11-03T03:00:00Z\s+4\s+schedule\s+\w+\s+no-record .*cancelled/,
    )
    expect(r.stdout).toContain('streak: 0 passing night(s)')
    expect(r.stdout).toMatch(/running +5 \(workflow_dispatch, in_progress/)
  })
})

describe('check-uploads.sh: the GitHub token, over everything that may go up', () => {
  const GH = 'ghs_' + 'x1'.repeat(18)
  const up = (env = {}) =>
    sh('check-uploads.sh', [path.join(dir, 'next')], {
      GH_TOKEN: GH,
      CHECK_SECRETS: 'GH_TOKEN',
      ...env,
    })

  test('clean when nothing holds it; nothing to upload is clean too', () => {
    expect(up().outputs.check).toBe('clean')
    mkdirSync(ws('qc-results'), { recursive: true })
    writeFileSync(ws('qc-results', 'history.jsonl'), line('r1', 'x') + '\n')
    mkdirSync(path.join(dir, 'next'))
    writeFileSync(path.join(dir, 'next', 'runs.log'), 'fine\n')
    const r = up()
    expect(r.code).toBe(0)
    expect(r.outputs.check).toBe('clean')
    expect(r.stdout).toContain('no GH_TOKEN in any')
  })

  test('the token in the next history link, or in QC’s output: refused, never printed', () => {
    mkdirSync(path.join(dir, 'next'))
    writeFileSync(path.join(dir, 'next', 'history.jsonl'), `GH_TOKEN=${GH}\n`)
    const r = up()
    expect(r.code).toBe(1)
    expect(r.outputs.check).toBe('refused')
    expect(r.stdout).not.toContain(GH)
    expect(up({ GH_TOKEN: '' }).outputs.check).toBe('refused')
  })
})
