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

const REAL_MV = fs.existsSync('/usr/bin/mv') ? '/usr/bin/mv' : '/bin/mv'

const STUBS = {
  // mv, except that STUB_CRASH_AT_PLATFORM_MV makes the restore's move of
  // platform.db fail: under `set -e` the boot stops there, as a crash would.
  mv: `#!/bin/sh
case "$1" in
*/restoring/platform.db) [ -z "\${STUB_CRASH_AT_PLATFORM_MV:-}" ] || exit 1 ;;
esac
exec ${REAL_MV} "$@"
`,
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

  test('a crash just before platform.db is in place keeps the fallback flag', () => {
    const env = { ...DEMAND, ...BUCKETS, KEEP_RESET_GENERATION: 'g1', STUB_RESTORE_snapshot: '0' }
    const crashed = boot({ ...env, STUB_CRASH_AT_PLATFORM_MV: '1' })
    expect(crashed.status).not.toBe(0)
    expect(JSON.parse(marker('.restored'))).toMatchObject({ source: 'snapshot', fallback: true })
    // The next boot restores again (no platform.db) and stays flagged.
    const res = boot(env)
    expect(res.status, res.stderr).toBe(0)
    expect(marker('platform.db')).toBe('restored from snapshot')
    expect(JSON.parse(marker('.restored')).fallback).toBe(true)
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

  test('an empty .wiping (a crash while creating it) counts: the next boot wipes', () => {
    volume(() => fs.writeFileSync(path.join(data, '.wiping'), ''))
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

  test('a crash after the new marker, before .wiping went: wiped again, and g2 stays usable', () => {
    volume(() => {
      fs.writeFileSync(path.join(data, '.wiping'), 'g2\n')
      fs.writeFileSync(path.join(data, '.generation'), 'g2\n')
    })
    reset(bootWithBackups())
    expect(has('.generations-used')).toBe(false)
    writeOrg()
    expect(boot({ ...DEMAND, KEEP_RESET_GENERATION: 'g2' }).status).toBe(0)
    expect(kept()).toBe(true)
  })

  test('a crash mid-restore, after the marker and before the data: restored again, never wiped', () => {
    // put_in_place writes .generation first: the state a crash leaves is
    // the marker, a half-moved restore, and no platform.db.
    fs.mkdirSync(path.join(data, 'restoring', 'orgs'), { recursive: true })
    fs.writeFileSync(path.join(data, '.generation'), 'g1\n')
    const res = boot({ ...DEMAND, ...BUCKETS, KEEP_RESET_GENERATION: 'g1', STUB_RESTORE_litestream: '0' })
    expect(res.status, res.stderr).toBe(0)
    expect(restores(res.calls)).toEqual(['restore litestream'])
    expect(marker('platform.db')).toBe('restored from litestream')
    expect(marker('.generation')).toBe('g1')
    expect(has('.generation.tmp')).toBe(false)
  })

  test('a crash while wiping for g2, then a newer generation g3: wiped for g3', () => {
    volume(() => fs.writeFileSync(path.join(data, '.wiping'), 'g2\n'))
    reset(bootWithBackups('g3'), 'g3')
  })

  test('a resumed wipe with an unreadable .generation refuses: it can’t retire what it can’t read', () => {
    volume(() => {
      fs.writeFileSync(path.join(data, '.wiping'), 'g2\n')
      fs.rmSync(path.join(data, '.generation'))
      fs.mkdirSync(path.join(data, '.generation'))
    })
    const res = bootWithBackups()
    expect(res.status).toBe(1)
    expect(res.stderr).toContain("can't read")
    expect(res.stderr).toContain('to retire it')
    expect(res.calls).toEqual([])
    expect(kept()).toBe(true)
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

describe('switching modes, and generations used before (review L1, round 2 M)', () => {
  test('demand g1 → deploy → demand g1 again refuses: g1’s prefix holds the old replica', () => {
    boot({ ...DEMAND, KEEP_RESET_GENERATION: 'g1', FLY_IMAGE_REF: 'x:1' })
    // Deploy, same image: nothing wiped, but g1 is retired. The secret
    // stays set, as it does on Fly.
    const deploy = boot({ ...SEED, FLY_IMAGE_REF: 'x:1', KEEP_RESET_GENERATION: 'g1' })
    expect(deploy.status).toBe(0)
    expect(has('.generation')).toBe(false)
    expect(marker('.generations-used')).toBe('g1')
    writeOrg()
    const res = boot({ ...DEMAND, ...BUCKETS, KEEP_RESET_GENERATION: 'g1', FLY_IMAGE_REF: 'x:1' })
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('generation g1 was used before on this volume')
    expect(res.calls).toEqual([])
    expect(kept()).toBe(true)
  })

  test('demand g1 → deploy → demand g2 wipes once, then keeps', () => {
    boot({ ...DEMAND, KEEP_RESET_GENERATION: 'g1', FLY_IMAGE_REF: 'x:1' })
    boot({ ...SEED, FLY_IMAGE_REF: 'x:1' })
    writeOrg()
    const res = boot({ ...DEMAND, KEEP_RESET_GENERATION: 'g2', FLY_IMAGE_REF: 'x:1' })
    expect(res.status, res.stderr).toBe(0)
    expect(res.stderr).toContain('no reset generation recorded')
    expect(kept()).toBe(false)
    expect(marker('.generation')).toBe('g2')
    writeOrg()
    expect(boot({ ...DEMAND, KEEP_RESET_GENERATION: 'g2', FLY_IMAGE_REF: 'x:2' }).status).toBe(0)
    expect(kept()).toBe(true)
  })

  test('a reset retires the generation it wipes: going back to g1 refuses', () => {
    boot({ ...DEMAND, KEEP_RESET_GENERATION: 'g1' })
    boot({ ...DEMAND, KEEP_RESET_GENERATION: 'g2' })
    expect(marker('.generations-used')).toBe('g1')
    writeOrg()
    const res = boot({ ...DEMAND, KEEP_RESET_GENERATION: 'g1' })
    expect(res.status).toBe(1)
    expect(kept()).toBe(true)
    // The used list survives every wipe.
    boot({ ...DEMAND, KEEP_RESET_GENERATION: 'g3' })
    expect(marker('.generations-used').split('\n')).toEqual(['g1', 'g2'])
  })

  test('an unreadable .generations-used refuses to boot', () => {
    boot({ ...DEMAND, KEEP_RESET_GENERATION: 'g1' })
    writeOrg()
    fs.mkdirSync(path.join(data, '.generations-used'))
    const res = boot({ ...DEMAND, KEEP_RESET_GENERATION: 'g2' })
    expect(res.status).toBe(1)
    expect(res.stderr).toContain("can't read")
    expect(kept()).toBe(true)
  })

  test('a deploy-mode wipe removes the marker too', () => {
    boot({ ...DEMAND, KEEP_RESET_GENERATION: 'g1', FLY_IMAGE_REF: 'x:1' })
    boot({ ...SEED, FLY_IMAGE_REF: 'x:2' })
    expect(has('.generation')).toBe(false)
    expect(marker('.generations-used')).toBe('g1')
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

// fly.staging.toml's [env], as Fly passes it to the machine.
function stagingToml() {
  const toml = fs.readFileSync(path.join(import.meta.dirname, '../../fly.staging.toml'), 'utf8')
  const env = {}
  let inEnv = false
  for (const line of toml.split('\n').map((l) => l.trim())) {
    if (line.startsWith('[')) inEnv = line === '[env]'
    else if (inEnv && line.includes(' = ') && !line.startsWith('#')) {
      const [k, v] = line.split(' = ')
      env[k.trim()] = v.trim().replace(/^"|"$/g, '')
    }
  }
  return env
}

describe('staging’s switch to demand (S1b: scripts/fly/staging-kept.sh)', () => {
  const STAGING = stagingToml()
  /** keep-staging today: reset on deploy, image x:1, with data. */
  function today() {
    expect(boot({ ...SEED, ...BUCKETS, FLY_IMAGE_REF: 'x:1' }).status).toBe(0)
    writeOrg()
  }

  test('fly.staging.toml says demand, and never names the generation (review S1a M3)', () => {
    expect(STAGING).toMatchObject({ KEEP_ENV: 'staging', KEEP_RESET_SEED: 'riverside', KEEP_RESET_ON: 'demand' })
    expect(STAGING).not.toHaveProperty('KEEP_RESET_GENERATION')
  })

  test('deployed before the generation is set: refuses to boot, touches nothing', () => {
    today()
    const res = boot({ ...STAGING, ...BUCKETS, FLY_IMAGE_REF: 'x:2' })
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('needs KEEP_RESET_GENERATION')
    expect(res.calls).toEqual([])
    expect(kept()).toBe(true)
    // Setting it then restarts that machine: the one wipe happens there.
    const set = boot({ ...STAGING, ...BUCKETS, FLY_IMAGE_REF: 'x:2', KEEP_RESET_GENERATION: 'g1' })
    expect(set.status, set.stderr).toBe(0)
    expect(kept()).toBe(false)
  })

  test('generation staged, then the deploy: exactly one wipe, a fresh prefix, no restore', () => {
    today()
    const env = { ...STAGING, ...BUCKETS, KEEP_RESET_GENERATION: '20261102T120000Z' }
    const res = boot({ ...env, FLY_IMAGE_REF: 'x:2', STUB_RESTORE_litestream: '0', STUB_RESTORE_snapshot: '0' })
    expect(res.status, res.stderr).toBe(0)
    expect(res.stderr).toContain('no reset generation recorded')
    expect(kept()).toBe(false)
    // Wiped, so never restored: the new prefix starts empty.
    expect(restores(res.calls)).toEqual([])
    expect(res.calls).toEqual(['litestream staging/20261102T120000Z'])
    expect(marker('.generation')).toBe('20261102T120000Z')
    expect(has('.generations-used')).toBe(false)
    // From then on deploys and restarts keep the data.
    writeOrg()
    for (const image of ['x:3', 'x:3', 'x:4']) {
      const next = boot({ ...env, FLY_IMAGE_REF: image })
      expect(next.status, next.stderr).toBe(0)
      expect(next.calls).toEqual(['litestream staging/20261102T120000Z'])
      expect(kept()).toBe(true)
    }
  })

  test('generation set unstaged first (a restart under deploy): ignored, kept, then one wipe', () => {
    today()
    // `fly secrets set` without --stage restarts the machine on the same
    // image, still under deploy: nothing wiped, the old prefix.
    const restart = boot({ ...SEED, ...BUCKETS, FLY_IMAGE_REF: 'x:1', KEEP_RESET_GENERATION: 'g1' })
    expect(restart.status).toBe(0)
    expect(restart.stderr).toContain('KEEP_RESET_GENERATION is ignored')
    expect(restart.calls).toEqual(['litestream staging/1'])
    expect(kept()).toBe(true)
    const deploy = boot({ ...STAGING, ...BUCKETS, FLY_IMAGE_REF: 'x:2', KEEP_RESET_GENERATION: 'g1' })
    expect(deploy.status, deploy.stderr).toBe(0)
    expect(kept()).toBe(false)
    expect(deploy.calls).toEqual(['litestream staging/g1'])
  })
})
