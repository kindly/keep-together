// @vitest-environment node
// The image's entrypoint (entrypoint.sh): when a reset environment wipes
// its data (KEEP_RESET_ON=deploy|demand), which Litestream prefix it
// replicates to, and which backups an empty volume restores from. Run
// under /bin/sh over a temp data dir, with sqlite3, litestream, the api
// and restore.sh stubbed on PATH.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

const ENTRYPOINT = path.join(import.meta.dirname, 'entrypoint.sh')

const STUBS = {
  // The entrypoint creates platform.db with `sqlite3 <file> 'PRAGMA …'`.
  sqlite3: `#!/bin/sh\n: >"$1"\n`,
  // Both record the prefix they were given and stop: the "server".
  litestream: `#!/bin/sh\necho "litestream $KEEP_REPLICA_PREFIX" >>"$STUB_LOG"\n`,
  api: `#!/bin/sh\necho "api $KEEP_REPLICA_PREFIX" >>"$STUB_LOG"\n`,
  // restore.sh <source> <dir>: exit STUB_RESTORE_<source> (default 3, no
  // backup); on 0 it leaves a restored platform.db naming its source.
  'restore.sh': `#!/bin/sh
echo "restore $1" >>"$STUB_LOG"
eval "code=\\\${STUB_RESTORE_$1:-3}"
if [ "$code" = 0 ]; then
  mkdir -p "$2/orgs"
  echo "restored from $1" >"$2/platform.db"
fi
exit "$code"
`,
}

let tmp, data, bin, log

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'entrypoint-'))
  data = path.join(tmp, 'data')
  bin = path.join(tmp, 'bin')
  log = path.join(tmp, 'stub.log')
  fs.mkdirSync(bin)
  for (const [name, body] of Object.entries(STUBS)) {
    fs.writeFileSync(path.join(bin, name), body, { mode: 0o755 })
  }
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** One boot with `env` (on top of a staging baseline). */
function boot(env = {}) {
  const res = spawnSync('/bin/sh', [ENTRYPOINT], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      KEEP_DATA_DIR: data,
      KEEP_ENV: 'staging',
      STUB_LOG: log,
      ...env,
    },
  })
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []
  fs.rmSync(log, { force: true })
  return { status: res.status, stderr: res.stderr, calls }
}

/** Something the seed or a user wrote, to see whether a boot kept it. */
function writeOrg() {
  fs.writeFileSync(path.join(data, 'orgs', 'a.db'), 'org')
}
const kept = () => fs.existsSync(path.join(data, 'orgs', 'a.db'))
const marker = (name) => fs.readFileSync(path.join(data, name), 'utf8').trim()
const has = (name) => fs.existsSync(path.join(data, name))
const restores = (calls) => calls.filter((c) => c.startsWith('restore'))

const SEED = { KEEP_RESET_SEED: 'riverside' }
const DEMAND = { ...SEED, KEEP_RESET_ON: 'demand' }
const BUCKETS = { LITESTREAM_BUCKET: 'b', KEEP_SNAPSHOT_BUCKET: 's' }

describe('KEEP_RESET_ON=deploy (the default): today’s behaviour', () => {
  test('the same image keeps the data; a new image wipes it', () => {
    const first = { ...SEED, FLY_IMAGE_REF: 'registry.fly.io/keep-staging:deployment-1' }
    expect(boot(first).status).toBe(0)
    expect(marker('.image')).toBe(first.FLY_IMAGE_REF)
    writeOrg()

    expect(boot(first).status).toBe(0)
    expect(kept()).toBe(true)

    const second = { ...SEED, FLY_IMAGE_REF: 'registry.fly.io/keep-staging:deployment-2' }
    const res = boot(second)
    expect(res.status).toBe(0)
    expect(res.stderr).toContain('new deploy (registry.fly.io/keep-staging:deployment-2)')
    expect(kept()).toBe(false)
    expect(marker('.image')).toBe(second.FLY_IMAGE_REF)
    expect(fs.existsSync(path.join(data, '.generation'))).toBe(false)
  })

  test('replicates to a prefix per image', () => {
    const res = boot({ ...SEED, ...BUCKETS, FLY_IMAGE_REF: 'registry.fly.io/keep-staging:dep-9' })
    expect(res.calls).toContain('litestream staging/dep-9')
  })

  test('an empty volume restores from Litestream only, never the snapshots', () => {
    const res = boot({ ...SEED, ...BUCKETS, FLY_IMAGE_REF: 'x:1' })
    expect(res.calls.filter((c) => c.startsWith('restore'))).toEqual(['restore litestream'])
  })

  test('KEEP_RESET_GENERATION is ignored (and says so)', () => {
    boot({ ...SEED, FLY_IMAGE_REF: 'x:1', KEEP_RESET_GENERATION: 'g1' })
    writeOrg()
    const res = boot({ ...SEED, FLY_IMAGE_REF: 'x:1', KEEP_RESET_GENERATION: 'g2' })
    expect(res.status).toBe(0)
    expect(res.stderr).toContain('KEEP_RESET_GENERATION is ignored')
    expect(kept()).toBe(true)
  })

  test('without KEEP_RESET_SEED nothing is wiped and the prefix is the env', () => {
    boot({ FLY_IMAGE_REF: 'x:1' })
    writeOrg()
    const res = boot({ ...BUCKETS, FLY_IMAGE_REF: 'x:2' })
    expect(kept()).toBe(true)
    expect(res.calls).toContain('litestream staging')
  })
})

describe('KEEP_RESET_ON=demand: reset only when the generation changes', () => {
  test('the same generation keeps the data across deploys', () => {
    expect(boot({ ...DEMAND, KEEP_RESET_GENERATION: 'g1', FLY_IMAGE_REF: 'x:1' }).status).toBe(0)
    expect(marker('.generation')).toBe('g1')
    writeOrg()
    const res = boot({ ...DEMAND, KEEP_RESET_GENERATION: 'g1', FLY_IMAGE_REF: 'x:2' })
    expect(res.status).toBe(0)
    expect(kept()).toBe(true)
  })

  test('a new generation wipes the data and records it', () => {
    boot({ ...DEMAND, KEEP_RESET_GENERATION: 'g1' })
    writeOrg()
    fs.writeFileSync(path.join(data, '.restored'), '{}')
    const res = boot({ ...DEMAND, KEEP_RESET_GENERATION: '20261101T120000Z' })
    expect(res.status).toBe(0)
    expect(res.stderr).toContain('new reset generation (20261101T120000Z)')
    expect(kept()).toBe(false)
    expect(fs.existsSync(path.join(data, '.restored'))).toBe(false)
    expect(marker('.generation')).toBe('20261101T120000Z')
  })

  test('a volume without a generation (the switch from deploy) is wiped once', () => {
    boot({ ...SEED, FLY_IMAGE_REF: 'x:1' })
    writeOrg()
    boot({ ...DEMAND, KEEP_RESET_GENERATION: 'g1', FLY_IMAGE_REF: 'x:1' })
    expect(kept()).toBe(false)
  })

  test('a 64-character generation is accepted', () => {
    const g = 'a'.repeat(64)
    expect(boot({ ...DEMAND, KEEP_RESET_GENERATION: g }).status).toBe(0)
    expect(marker('.generation')).toBe(g)
  })

  test('replicates to a prefix per generation, not per image', () => {
    const res = boot({ ...DEMAND, ...BUCKETS, KEEP_RESET_GENERATION: 'g7', FLY_IMAGE_REF: 'x:1' })
    expect(res.calls).toContain('litestream staging/g7')
  })

  test('an empty volume restores from the generation and keeps it', () => {
    const env = { ...DEMAND, ...BUCKETS, KEEP_RESET_GENERATION: 'g1', STUB_RESTORE_litestream: '0' }
    const res = boot(env)
    expect(res.status).toBe(0)
    expect(res.calls).toEqual(['restore litestream', 'litestream staging/g1'])
    expect(marker('.generation')).toBe('g1')
    expect(marker('platform.db')).toBe('restored from litestream')
  })

  test('with no replica the snapshots are the fallback', () => {
    const env = { ...DEMAND, ...BUCKETS, KEEP_RESET_GENERATION: 'g1', STUB_RESTORE_snapshot: '0' }
    const res = boot(env)
    expect(res.status).toBe(0)
    expect(res.calls.filter((c) => c.startsWith('restore'))).toEqual([
      'restore litestream',
      'restore snapshot',
    ])
    expect(res.stderr).toContain('FALLBACK')
    expect(marker('platform.db')).toBe('restored from snapshot')
    expect(JSON.parse(marker('.restored')).fallback).toBe(true)
  })
})

describe('demand: a reset is crash-safe and never restores (review M1, M2)', () => {
  /** A volume of generation g1 with data, then `state` applied. */
  function volume(state = () => {}) {
    boot({ ...DEMAND, KEEP_RESET_GENERATION: 'g1' })
    writeOrg()
    state()
  }
  /** Boot generation `g` with both backups holding something. */
  const bootWithBackups = (g = 'g2') =>
    boot({
      ...DEMAND,
      ...BUCKETS,
      KEEP_RESET_GENERATION: g,
      STUB_RESTORE_litestream: '0',
      STUB_RESTORE_snapshot: '0',
    })
  const reset = (res, g = 'g2') => {
    expect(res.status, res.stderr).toBe(0)
    expect(restores(res.calls)).toEqual([])
    expect(kept()).toBe(false)
    expect(has('platform.db') && marker('platform.db')).not.toMatch(/restored/)
    expect(marker('.generation')).toBe(g)
    expect(has('.wiping')).toBe(false)
  }

  test('a changed generation over a volume with no platform.db wipes, never restores', () => {
    volume(() => fs.rmSync(path.join(data, 'platform.db')))
    reset(bootWithBackups())
  })

  test('a crash before anything was removed: the next boot wipes', () => {
    volume(() => fs.writeFileSync(path.join(data, '.wiping'), 'g2\n'))
    reset(bootWithBackups())
  })

  test('a crash mid-wipe (platform.db and the marker gone, orgs left): finished, not restored', () => {
    volume(() => {
      fs.writeFileSync(path.join(data, '.wiping'), 'g2\n')
      fs.rmSync(path.join(data, 'platform.db'))
      fs.rmSync(path.join(data, '.generation'))
    })
    const res = bootWithBackups()
    expect(res.stderr).toContain("an earlier wipe didn't finish")
    reset(res)
  })

  test('a crash after the new marker, before .wiping went: wiped again', () => {
    volume(() => {
      fs.writeFileSync(path.join(data, '.wiping'), 'g2\n')
      fs.writeFileSync(path.join(data, '.generation'), 'g2\n')
    })
    reset(bootWithBackups())
  })

  test('a crash while wiping for g2, then a newer generation g3: wiped for g3', () => {
    volume(() => fs.writeFileSync(path.join(data, '.wiping'), 'g2\n'))
    reset(bootWithBackups('g3'), 'g3')
  })

  test('an unreadable .generation refuses to boot and wipes nothing', () => {
    volume(() => {
      fs.rmSync(path.join(data, '.generation'))
      fs.mkdirSync(path.join(data, '.generation'))
    })
    const res = bootWithBackups()
    expect(res.status).toBe(1)
    expect(res.stderr).toContain("can't read")
    expect(res.calls).toEqual([])
    expect(kept()).toBe(true)
  })

  test.skipIf(process.getuid?.() === 0)('a .generation without read permission refuses too', () => {
    volume(() => fs.chmodSync(path.join(data, '.generation'), 0o000))
    const res = bootWithBackups()
    fs.chmodSync(path.join(data, '.generation'), 0o644)
    expect(res.status).toBe(1)
    expect(res.calls).toEqual([])
    expect(kept()).toBe(true)
  })
})

describe('switching modes (review L1)', () => {
  test('deploy clears a marker left by demand, so demand again starts a fresh wipe', () => {
    boot({ ...DEMAND, KEEP_RESET_GENERATION: 'g1', FLY_IMAGE_REF: 'x:1' })
    fs.writeFileSync(path.join(data, '.wiping'), 'g1\n')
    // Deploy, same image: nothing wiped, but the markers go.
    fs.rmSync(path.join(data, '.wiping'))
    boot({ ...SEED, FLY_IMAGE_REF: 'x:1', KEEP_RESET_GENERATION: 'g1' })
    expect(has('.generation')).toBe(false)
    writeOrg()
    // Back to demand with the same generation: the data made under deploy
    // isn't taken for g1's.
    const res = boot({ ...DEMAND, KEEP_RESET_GENERATION: 'g1', FLY_IMAGE_REF: 'x:1' })
    expect(res.stderr).toContain('no reset generation recorded')
    expect(kept()).toBe(false)
    expect(marker('.generation')).toBe('g1')
  })

  test('a deploy-mode wipe removes the marker too', () => {
    boot({ ...DEMAND, KEEP_RESET_GENERATION: 'g1', FLY_IMAGE_REF: 'x:1' })
    boot({ ...SEED, FLY_IMAGE_REF: 'x:2' })
    expect(has('.generation')).toBe(false)
  })
})

describe('refusals: nothing is touched', () => {
  const refused = (env, message) => {
    fs.mkdirSync(path.join(data, 'orgs'), { recursive: true })
    writeOrg()
    const res = boot(env)
    expect(res.status).toBe(1)
    expect(res.stderr).toContain(message)
    expect(res.calls).toEqual([])
    expect(kept()).toBe(true)
  }

  test('an unknown KEEP_RESET_ON', () => {
    refused({ ...SEED, KEEP_RESET_ON: 'never' }, "KEEP_RESET_ON must be deploy or demand, not 'never'")
  })
  test('demand without KEEP_RESET_SEED', () => {
    refused({ KEEP_RESET_ON: 'demand', KEEP_RESET_GENERATION: 'g1' }, 'needs KEEP_RESET_SEED')
  })
  test('demand without a generation, or with one that is not a plain name', () => {
    for (const g of [undefined, '', 'a/b', 'a b', '../x']) {
      const env = { ...DEMAND, ...(g === undefined ? {} : { KEEP_RESET_GENERATION: g }) }
      refused(env, 'needs KEEP_RESET_GENERATION')
    }
  })
  test('KEEP_RESET_SEED on any env but staging or dev (review L2)', () => {
    for (const env of ['Prod', 'production', 'stagign', '']) {
      refused({ ...SEED, ...BUCKETS, KEEP_ENV: env }, `refused when KEEP_ENV=${env} `)
    }
  })
  test('a generation over 64 characters (review L3)', () => {
    refused({ ...DEMAND, KEEP_RESET_GENERATION: 'a'.repeat(65) }, '1 to 64')
  })
  test('KEEP_RESET_SEED on prod, before any restore', () => {
    refused({ ...SEED, ...BUCKETS, KEEP_ENV: 'prod' }, 'KEEP_RESET_SEED is refused when KEEP_ENV=prod')
    refused({ ...DEMAND, KEEP_RESET_GENERATION: 'g1', KEEP_ENV: 'prod' }, 'refused when KEEP_ENV=prod')
  })
})
