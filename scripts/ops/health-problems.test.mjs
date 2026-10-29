// @vitest-environment node
// The health monitor's judgement (health-problems.jq, run by
// .github/workflows/health.yml) over /healthz bodies: the disk
// thresholds, and that the backup checks still read as before.
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

const program = path.join(import.meta.dirname, 'health-problems.jq')
const GB = 1e9

/** The problems line for one environment's body. */
function problems(body, env = 'staging', max = 300) {
  return execFileSync(
    'jq',
    ['-r', '--argjson', 'max', String(max), '--arg', 'env', env, '-f', program],
    { input: JSON.stringify(body), encoding: 'utf8' },
  ).trim()
}

const healthy = {
  ok: true,
  db: 'ok',
  walBacklogBytes: 0,
  backup: { snapshots: 'on', snapshotAgeSeconds: 60, litestream: 'ok' },
  diskTotalBytes: 10 * GB,
  diskFreeBytes: 6 * GB,
}

describe('health-problems.jq', () => {
  test('a healthy body has no problem', () => {
    expect(problems(healthy, 'prod')).toBe('')
  })

  test('20% free or more is fine; under 20% is a problem', () => {
    expect(problems({ ...healthy, diskFreeBytes: 2 * GB })).toBe('')
    expect(problems({ ...healthy, diskFreeBytes: 1.9 * GB }, 'prod')).toBe(
      'disk 81% full on prod: 1.9 GB free of 10 GB (docs/ops.md, Disk)',
    )
  })

  test('under 10% free is urgent', () => {
    expect(problems({ ...healthy, diskFreeBytes: 0.95 * GB }, 'prod')).toBe(
      'URGENT: disk 90% full on prod: 0.9 GB free of 10 GB; grow the volume now (docs/ops.md, Disk)',
    )
    expect(problems({ ...healthy, diskFreeBytes: 0 }, 'staging')).toMatch(
      /^URGENT: disk 100% full on staging: 0 GB free/,
    )
  })

  test('no disk fields (an older server) is no problem', () => {
    const { diskTotalBytes: _t, diskFreeBytes: _f, ...old } = healthy
    expect(problems(old)).toBe('')
    expect(problems({ ...healthy, diskFreeBytes: null })).toBe('')
  })

  test('the disk joins the other problems, after ok', () => {
    expect(
      problems({
        ...healthy,
        ok: false,
        diskFreeBytes: 1 * GB,
        backup: { ...healthy.backup, litestream: 'error' },
      }),
    ).toBe(
      'ok is false; disk 90% full on staging: 1 GB free of 10 GB (docs/ops.md, Disk); litestream not ok (see the log)',
    )
  })

  test('the backup checks read as before', () => {
    expect(
      problems(
        {
          ...healthy,
          backup: {
            snapshots: 'on',
            snapshotAgeSeconds: 9000,
            snapshotErrorCount: 2,
            litestream: 'ok',
            litestreamLagSeconds: 400,
          },
        },
        'prod',
      ),
    ).toBe(
      'last snapshot 9000 s ago; 2 file(s) failed the last snapshot run; litestream lag 400 s',
    )
    expect(
      problems(
        { ...healthy, backup: { snapshots: 'off', litestream: 'off' } },
        'prod',
      ),
    ).toBe('snapshots off; litestream off')
    expect(
      problems(
        { ...healthy, backup: { snapshots: 'off', litestream: 'off' } },
        'staging',
      ),
    ).toBe('')
  })
})
