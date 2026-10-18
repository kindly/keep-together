import { beforeEach, describe, expect, test } from 'vitest'
import migrationsTest from '@convex-dev/migrations/test'
import { runToCompletion } from '@convex-dev/migrations'
import type { Id } from '../_generated/dataModel'
import { api, components, internal } from '../_generated/api'
import { setup } from '../../test/fixture'
import type { Tenant } from '../../test/fixture'

type Fixture = Awaited<ReturnType<typeof setup>>

let f: Fixture

beforeEach(async () => {
  f = await setup()
  migrationsTest.register(f.t)
})

/** A preferences row as the single-switch code wrote it. */
const legacyRow = (who: Tenant, on: boolean, listsVersion: number) =>
  f.t.run((ctx) =>
    ctx.db.insert('tenantPreferences', {
      tenantId: who.tenantId,
      staffCanManageLists: on,
      listsVersion,
    }),
  )

const split = () =>
  f.t.run((ctx) =>
    runToCompletion(
      ctx,
      components.migrations,
      internal.platform.migrations.splitStaffCanManageLists,
    ),
  )

const doc = (id: Id<'tenantPreferences'>) =>
  f.t.run((ctx) => ctx.db.get('tenantPreferences', id))

const revisions = (who: Tenant) =>
  f.t.run(async (ctx) =>
    (await ctx.db.query('revisions').collect())
      .filter(
        (r) =>
          r.tenantId === who.tenantId &&
          r.contract.startsWith('tenantPreferences.'),
      )
      .map((r) => [r.contract, r.counter, r.source, r.payload]),
  )

const mine = async (who: Tenant) =>
  (await who.as.query(api.platform.tenants.mine, {})).find(
    (m) => m._id === who.tenantId,
  )!

describe('splitStaffCanManageLists', () => {
  test('copies the old switch into both, with revisions, and unsets it; per tenant', async () => {
    const aRow = await legacyRow(f.a, true, 3)
    const bRow = await legacyRow(f.b, false, 0)

    // Before the split, reads fall back to the old switch.
    expect(await mine(f.a)).toMatchObject({
      staffCanManageTags: true,
      staffCanManageIdentifierTypes: true,
      tagsVersion: null,
      identifierTypesVersion: null,
    })

    await split()
    const a = await doc(aRow)
    expect(a).toMatchObject({
      staffCanManageTags: true,
      tagsVersion: 1,
      staffCanManageIdentifierTypes: true,
      identifierTypesVersion: 1,
    })
    expect(a).not.toHaveProperty('staffCanManageLists')
    expect(a).not.toHaveProperty('listsVersion')
    expect(await doc(bRow)).toMatchObject({
      staffCanManageTags: false,
      staffCanManageIdentifierTypes: false,
    })
    expect(await revisions(f.a)).toEqual([
      ['tenantPreferences.tags', 1, 'system', { staffCanManageTags: true }],
      [
        'tenantPreferences.identifierTypes',
        1,
        'system',
        { staffCanManageIdentifierTypes: true },
      ],
    ])
    expect(await revisions(f.b)).toEqual([
      ['tenantPreferences.tags', 1, 'system', { staffCanManageTags: false }],
      [
        'tenantPreferences.identifierTypes',
        1,
        'system',
        { staffCanManageIdentifierTypes: false },
      ],
    ])

    // A rerun is a no-op.
    await split()
    expect(await doc(aRow)).toEqual(a)
    expect(await revisions(f.a)).toHaveLength(2)
  })

  test('a save that reaches an unsplit row splits it first, then applies', async () => {
    const row = await legacyRow(f.a, true, 0)
    // The admin saw the old switch: no counter for the new one.
    expect((await mine(f.a)).tagsVersion).toBeNull()
    await f.a.as.mutation(api.platform.preferences.setStaffCanManageTags, {
      tenantId: f.a.tenantId,
      staffCanManageTags: false,
    })
    expect(await doc(row)).toMatchObject({
      staffCanManageTags: false,
      tagsVersion: 2,
      staffCanManageIdentifierTypes: true,
      identifierTypesVersion: 1,
    })
    expect(await mine(f.a)).toMatchObject({
      staffCanManageTags: false,
      staffCanManageIdentifierTypes: true,
    })
    // The migration then finds nothing to do.
    await split()
    expect(await revisions(f.a)).toHaveLength(3)
  })
})
