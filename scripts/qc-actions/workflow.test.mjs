// @vitest-environment node
// .github/workflows/qc.yml, and its call from deploy.yml (plan
// gocardless-sandbox-qc.sv, A2), parsed: the repo is public, so the
// token's one step, the triggers, the permissions and the gate in front
// of every upload are pinned here. The gate's and the commit step's shell
// is run as Actions would run it.
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { parse } from './testing/yaml-subset.mjs'

const root = path.join(import.meta.dirname, '../..')
const qcText = readFileSync(path.join(root, '.github/workflows/qc.yml'), 'utf8')
const deployText = readFileSync(
  path.join(root, '.github/workflows/deploy.yml'),
  'utf8',
)
const qc = parse(qcText)
const deploy = parse(deployText)
const job = qc.jobs.qc
const steps = job.steps
const byId = (id) => steps.find((s) => s.id === id)
const indexOf = (s) => steps.indexOf(s)
const CLEAN = "steps.qc.outputs.check == 'clean'"

describe('triggers', () => {
  test('after keep-qc deploys, nightly at 03:00, by hand with a mode; never a pull request', () => {
    expect(Object.keys(qc.on).sort()).toEqual([
      'schedule',
      'workflow_call',
      'workflow_dispatch',
    ])
    expect(qc.on.schedule).toEqual([{ cron: '0 3 * * *' }])
    expect(qc.on.workflow_dispatch.inputs.mode).toMatchObject({
      type: 'choice',
      options: ['assert', 'record'],
      default: 'assert',
    })
    expect(qc.on.workflow_call.inputs.mode.default).toBe('assert')
    // Not even in a comment: nothing to copy from.
    expect(qcText).not.toMatch(/pull_request/)
    expect(deployText).not.toMatch(/pull_request/)
  })

  test('main only: the qc job never starts elsewhere; the refuse job fails loudly instead', () => {
    expect(job.if).toBe("${{ github.ref == 'refs/heads/main' }}")
    expect(qc.jobs.refuse.if).toBe("${{ github.ref != 'refs/heads/main' }}")
    expect(qc.jobs.refuse.environment).toBeUndefined()
    expect(qc.jobs.refuse.steps[0].run).toMatch(/exit 1/)
    expect(Object.keys(qc.jobs).sort()).toEqual(['qc', 'refuse'])
  })
})

describe('permissions and the environment', () => {
  test('exactly contents read, issues write, actions read; no job widens them', () => {
    expect(qc.permissions).toEqual({
      contents: 'read',
      issues: 'write',
      actions: 'read',
    })
    for (const j of Object.values(qc.jobs))
      expect(j.permissions).toBeUndefined()
  })

  test('environment qc, and the concurrency group keep-qc shared with deploy-qc', () => {
    expect(job.environment).toBe('qc')
    expect(job.concurrency).toEqual({
      group: 'keep-qc',
      'cancel-in-progress': false,
    })
    expect(deploy.jobs['deploy-qc'].concurrency).toEqual(job.concurrency)
    expect(qc.concurrency).toBeUndefined()
  })
})

describe('the token', () => {
  test('KEEP_QC_TOKEN only in the env of the QC step, and the workflow names no other secret', () => {
    expect(qcText.match(/secrets\./g)).toHaveLength(1)
    const holders = steps.filter((s) =>
      JSON.stringify(s).includes('KEEP_QC_TOKEN'),
    )
    expect(holders).toEqual([byId('qc')])
    expect(byId('qc').env.KEEP_QC_TOKEN).toBe('${{ secrets.KEEP_QC_TOKEN }}')
    expect(job.env).toBeUndefined()
    expect(qc.env).toBeUndefined()
  })

  test('never in run text, never echoed; the step holding it has no GitHub token', () => {
    for (const s of steps) {
      expect(s.run ?? '', s.name).not.toMatch(/KEEP_QC_TOKEN|secrets\./)
      expect(s.with ?? {}, s.name).not.toHaveProperty('token')
    }
    expect(byId('qc').env).not.toHaveProperty('GH_TOKEN')
    expect(byId('qc').env).not.toHaveProperty('GITHUB_TOKEN')
  })

  test('no expression is ever pasted into a run: script (no injection), in qc.yml or deploy.yml', () => {
    const runs = [
      ...Object.values(qc.jobs),
      ...Object.values(deploy.jobs),
    ].flatMap((j) => (j.steps ?? []).map((s) => s.run ?? ''))
    for (const r of runs) expect(r).not.toContain('${{')
  })

  test('checkouts keep no credentials', () => {
    const checkouts = steps.filter((s) =>
      s.uses?.startsWith('actions/checkout@'),
    )
    expect(checkouts).toHaveLength(2)
    for (const c of checkouts) expect(c.with['persist-credentials']).toBe(false)
  })
})

describe('the commit', () => {
  test('the app is checked out at what /healthz reported; the scripts at the workflow’s own commit', () => {
    expect(byId('checkout').with.ref).toBe('${{ steps.commit.outputs.sha }}')
    expect(byId('scripts').with).toMatchObject({
      ref: '${{ github.sha }}',
      path: '.qc-actions',
      'sparse-checkout': 'scripts/qc-actions',
    })
    for (const id of ['history', 'qc', 'report'])
      expect(byId(id).run).toMatch(/^\.qc-actions\/scripts\/qc-actions\//)
    expect(byId('report').env.COMMIT).toBe('${{ steps.commit.outputs.sha }}')
  })
})

describe('the steps', () => {
  test('every step after the gate follows it (the uploads follow the check instead)', () => {
    expect(steps[0].id).toBe('gate')
    for (const s of steps.slice(1)) {
      if (s.uses?.startsWith('actions/upload-artifact@')) continue
      expect(s.if, s.name).toMatch(/steps\.gate\.outputs\.go == 'true'/)
    }
  })

  test('the order: commit, checkouts, install, chromium, history, QC, verdict, uploads', () => {
    const order = [
      'commit',
      'checkout',
      'scripts',
      'install',
      'browsers',
      'history',
      'qc',
      'report',
    ]
    const at = order.map((id) => indexOf(byId(id)))
    expect(at).toEqual([...at].sort((a, b) => a - b))
    expect(byId('qc').run).toBe(
      '.qc-actions/scripts/qc-actions/run.sh "$RUNNER_TEMP/qc-prev"',
    )
    expect(byId('browsers').run).toMatch(
      /playwright install --with-deps chromium/,
    )
    expect(byId('install').run).toBe('pnpm install --frozen-lockfile')
  })

  test('the QC step: the target, the mode, and the URL from the environment', () => {
    expect(byId('qc').env).toEqual({
      KEEP_QC_TOKEN: '${{ secrets.KEEP_QC_TOKEN }}',
      QC_TARGET_URL: '${{ vars.QC_URL }}',
      QC_MODE: "${{ inputs.mode == 'record' && 'record' || 'assert' }}",
    })
    expect(
      readFileSync(path.join(root, 'scripts/qc-actions/run.sh'), 'utf8'),
    ).toMatch(/\n {2}pnpm qc --target qc \|\| qc_rc=\$\?\n/)
  })

  test('the verdict runs whatever failed before it, and is told every earlier step’s outcome', () => {
    const r = byId('report')
    expect(r.if).toBe("${{ always() && steps.gate.outputs.go == 'true' }}")
    const named = [
      ...r.env.STEPS.matchAll(/([\w-]+)=\$\{\{ steps\.([\w-]+)\.outcome \}\}/g),
    ].map(([, name, id]) => {
      expect(name).toBe(id)
      return id
    })
    expect(
      r.env.STEPS.replace(
        /[\w-]+=\$\{\{ steps\.[\w-]+\.outcome \}\}/g,
        '',
      ).trim(),
    ).toBe('')
    const before = steps.slice(1, indexOf(byId('qc'))).map((s) => s.id)
    expect(named).toEqual(before)
    expect(r.env.QC_CHECK).toBe('${{ steps.qc.outputs.check }}')
    // Issues need the GitHub token; the QC token it never has.
    expect(r.env.GH_TOKEN).toBe('${{ github.token }}')
  })
})

describe('the artifact check comes before every upload', () => {
  const uploads = steps.filter((s) =>
    s.uses?.startsWith('actions/upload-artifact@'),
  )

  test('three uploads, all after the QC step (which ends with the check)', () => {
    expect(uploads.map((u) => u.with.name)).toEqual([
      'qc-results',
      'qc-report',
      'qc-history',
    ])
    for (const u of uploads)
      expect(indexOf(u)).toBeGreaterThan(indexOf(byId('qc')))
    expect(
      readFileSync(path.join(root, 'scripts/qc-actions/run.sh'), 'utf8'),
    ).toMatch(
      /check-artifacts\.mjs" qc-results qc-report; then\n {2}put check clean/,
    )
  })

  test('QC’s output goes up only when the check said clean', () => {
    for (const u of uploads.filter((x) => x.with.name !== 'qc-history')) {
      expect(u.if).toBe(`\${{ always() && ${CLEAN} }}`)
      expect(['qc-results/', 'qc-report/']).toContain(u.with.path)
    }
  })

  test('the history link is built by the verdict from checked history only, and only when the last one was read', () => {
    const h = uploads.find((u) => u.with.name === 'qc-history')
    expect(h.if).toBe("${{ always() && steps.history.outcome == 'success' }}")
    expect(h.with.path).toBe('${{ runner.temp }}/qc-history/')
    expect(h.with['retention-days']).toBe(90)
    const report = readFileSync(
      path.join(root, 'scripts/qc-actions/report.sh'),
      'utf8',
    )
    expect(report).toMatch(
      /hist=-\n {2}\[ "\$\{QC_CHECK:-\}" != clean \] \|\| hist=qc-results\/history\.jsonl/,
    )
  })
})

describe('deploy.yml calls it after deploy-qc', () => {
  test('only when deploy-qc deployed, with no secrets passed and the same permissions', () => {
    const call = deploy.jobs.qc
    expect(call).toEqual({
      needs: 'deploy-qc',
      if: "${{ needs.deploy-qc.outputs.deployed == 'true' }}",
      permissions: { contents: 'read', issues: 'write', actions: 'read' },
      uses: './.github/workflows/qc.yml',
      with: { mode: 'assert' },
    })
    expect(deploy.jobs['deploy-qc'].outputs).toEqual({
      deployed: '${{ steps.gate.outputs.go }}',
    })
    expect(deployText).not.toMatch(/secrets: inherit/)
  })
})

// The gate's and the commit step's shell, as Actions runs it (bash -e).
function runStep(id, env, { curl } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'qc-step-'))
  const out = path.join(dir, 'out')
  try {
    const bin = path.join(dir, 'bin')
    mkdirSync(bin)
    if (curl !== undefined)
      writeFileSync(path.join(bin, 'curl'), `#!/bin/sh\n${curl}\n`, {
        mode: 0o755,
      })
    const r = spawnSync('bash', ['-e', '-c', byId(id).run], {
      env: { PATH: `${bin}:${process.env.PATH}`, GITHUB_OUTPUT: out, ...env },
      encoding: 'utf8',
    })
    let outputs = ''
    try {
      outputs = readFileSync(out, 'utf8')
    } catch {}
    return { code: r.status, stdout: r.stdout, outputs }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('the gate and the commit', () => {
  test('skips green while QC_URL is unset; goes on main once it is', () => {
    const skip = runStep('gate', { QC_URL: '', GITHUB_REF: 'refs/heads/main' })
    expect(skip).toMatchObject({ code: 0, outputs: 'go=false\n' })
    expect(skip.stdout).toContain('::notice::')
    expect(
      runStep('gate', {
        QC_URL: 'https://keep-qc.fly.dev',
        GITHUB_REF: 'refs/heads/main',
      }),
    ).toMatchObject({ code: 0, outputs: 'go=true\n' })
    const other = runStep('gate', {
      QC_URL: 'https://keep-qc.fly.dev',
      GITHUB_REF: 'refs/heads/x',
    })
    expect(other.code).not.toBe(0)
    expect(other.outputs).toBe('')
  })

  const SHA = 'a'.repeat(40)
  test('the commit is what /healthz reports, 40 hex or nothing', () => {
    const ok = runStep(
      'commit',
      { QC_URL: 'https://keep-qc.fly.dev' },
      { curl: `echo '{"ok":true,"commit":"${SHA}"}'` },
    )
    expect(ok).toMatchObject({ code: 0, outputs: `sha=${SHA}\n` })
    for (const curl of [
      'echo \'{"ok":true}\'',
      'echo \'{"commit":"dev"}\'',
      'exit 7',
    ]) {
      const r = runStep(
        'commit',
        { QC_URL: 'https://keep-qc.fly.dev' },
        { curl },
      )
      expect(r.code, curl).not.toBe(0)
      expect(r.outputs).toBe('')
    }
  })
})

test('the parser this rests on reads the YAML it claims to', () => {
  expect(
    parse(
      [
        'a: 1 # c',
        "b: 'x # y'",
        'c: [p, q]',
        'd:',
        '  - e: f',
        '    g: |',
        '      one',
        '      # kept',
        '',
        '      two',
        '  - h',
        'i: >-',
        '  j',
        '  k',
      ].join('\n'),
    ),
  ).toEqual({
    a: 1,
    b: 'x # y',
    c: ['p', 'q'],
    d: [{ e: 'f', g: 'one\n# kept\n\ntwo\n' }, 'h'],
    i: 'j k',
  })
  for (const bad of ['a: &x 1', 'a: {b: 1}', 'a: 1\n---\nb: 2', 'a:\n\tb: 1'])
    expect(() => parse(bad), bad).toThrow()
})
