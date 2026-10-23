import { beforeEach, describe, expect, test } from 'vitest'
import migrationsTest from '@convex-dev/migrations/test'
import { runToCompletion } from '@convex-dev/migrations'
import { api, components, internal } from '../_generated/api'
import { setup } from '../../test/fixture'
import type { Tenant } from '../../test/fixture'

type Fixture = Awaited<ReturnType<typeof setup>>

let f: Fixture

beforeEach(async () => {
  f = await setup()
  migrationsTest.register(f.t)
})

/** Creates the tenant's preferences row through a real save. */
const saveTypesSwitch = (who: Tenant, on: boolean) =>
  who.as.mutation(api.platform.preferences.setStaffCanManageIdentifierTypes, {
    tenantId: who.tenantId,
    staffCanManageIdentifierTypes: on,
  })

/** Rows lose the fields pair, as if created before fields step 1. */
const unbackfill = () =>
  f.t.run(async (ctx) => {
    for (const r of await ctx.db.query('tenantPreferences').collect()) {
      await ctx.db.patch('tenantPreferences', r._id, {
        staffCanManageFields: undefined,
        fieldsVersion: undefined,
      })
    }
  })

const rows = () => f.t.run((ctx) => ctx.db.query('tenantPreferences').collect())

const revisionCount = () =>
  f.t.run(async (ctx) => (await ctx.db.query('revisions').collect()).length)

const backfill = (opts: { batchSize?: number; cursor?: null } = {}) =>
  f.t.run((ctx) =>
    runToCompletion(
      ctx,
      components.migrations,
      internal.platform.migrations.backfillFieldsPreference,
      opts,
    ),
  )

describe('backfillFieldsPreference', () => {
  test('a new row is created with the switch off at counter 0', async () => {
    await saveTypesSwitch(f.a, true)
    expect(await rows()).toEqual([
      expect.objectContaining({
        tenantId: f.a.tenantId,
        staffCanManageFields: false,
        fieldsVersion: 0,
      }),
    ])
  })

  test('sets off / 0 on every tenant’s row, without revisions, and nothing else', async () => {
    await saveTypesSwitch(f.a, true)
    await saveTypesSwitch(f.b, false)
    await unbackfill()
    const before = await rows()
    expect(before).toHaveLength(2)
    expect(before.every((r) => r.fieldsVersion === undefined)).toBe(true)
    const revs = await revisionCount()

    const status = await backfill({ batchSize: 1 })
    expect(status.isDone).toBe(true)
    expect(status.processed).toBe(2)
    expect(await rows()).toEqual(
      before.map((r) => ({
        ...r,
        staffCanManageFields: false,
        fieldsVersion: 0,
      })),
    )
    expect(await revisionCount()).toBe(revs)
  })

  test('a rerun from the start changes nothing', async () => {
    await saveTypesSwitch(f.a, true)
    await saveTypesSwitch(f.b, true)
    await unbackfill()
    await backfill()
    const done = await rows()
    const status = await backfill({ cursor: null })
    expect(status.isDone).toBe(true)
    expect(await rows()).toEqual(done)
  })
})
