import { beforeEach, describe, expect, test } from 'vitest'
import migrationsTest from '@convex-dev/migrations/test'
import { runToCompletion } from '@convex-dev/migrations'
import type { Doc, Id } from '../_generated/dataModel'
import { api, components, internal } from '../_generated/api'
import { setup } from '../../test/fixture'

type Fixture = Awaited<ReturnType<typeof setup>>

let f: Fixture

beforeEach(async () => {
  f = await setup()
  migrationsTest.register(f.t)
})

/** A new user in a tenant at a role, as pre-R1 data would have it. */
const addMember = (tenantId: Id<'tenants'>, role: Doc<'memberships'>['role']) =>
  f.t.run(async (ctx) => {
    const userId = await ctx.db.insert('users', {})
    await ctx.db.insert('memberships', { tenantId, userId, role })
    return userId
  })

/** Put the fixture's admins back to their pre-R1 name. */
const unbackfill = () =>
  f.t.run(async (ctx) => {
    for (const m of await ctx.db.query('memberships').collect()) {
      if (m.role === 'admin') {
        await ctx.db.patch('memberships', m._id, { role: 'owner' })
      }
    }
  })

const memberships = () =>
  f.t.run(async (ctx) =>
    (await ctx.db.query('memberships').collect()).map(
      ({ tenantId, userId, role }) => ({ tenantId, userId, role }),
    ),
  )

const backfill = (opts: { batchSize?: number; cursor?: null } = {}) =>
  f.t.run((ctx) =>
    runToCompletion(
      ctx,
      components.migrations,
      internal.platform.migrations.ownerToAdmin,
      opts,
    ),
  )

describe('ownerToAdmin', () => {
  test('renames every tenant’s owners, in batches, and nothing else', async () => {
    await unbackfill()
    const staffA = await addMember(f.a.tenantId, 'staff')
    const ownerB = await addMember(f.b.tenantId, 'owner')
    const viewerB = await addMember(f.b.tenantId, 'viewer')
    const before = await memberships()

    const status = await backfill({ batchSize: 2 })
    expect(status.isDone).toBe(true)
    expect(status.processed).toBe(5)

    const rename = (role: string) => (role === 'owner' ? 'admin' : role)
    expect(await memberships()).toEqual(
      before.map((m) => ({ ...m, role: rename(m.role) })),
    )
    const roleOf = async (userId: Id<'users'>) =>
      (await memberships()).find((m) => m.userId === userId)?.role
    expect(await roleOf(f.a.userId)).toBe('admin')
    expect(await roleOf(f.b.userId)).toBe('admin')
    expect(await roleOf(ownerB)).toBe('admin')
    expect(await roleOf(staffA)).toBe('staff')
    expect(await roleOf(viewerB)).toBe('viewer')
  })

  test('a rerun from the start changes nothing', async () => {
    await unbackfill()
    await backfill()
    const done = await memberships()
    const status = await backfill({ cursor: null })
    expect(status.isDone).toBe(true)
    expect(await memberships()).toEqual(done)
  })
})

describe('requireMember before the backfill', () => {
  test('an owner reads as admin; each tenant sees its own members', async () => {
    await unbackfill()
    const staffA = await addMember(f.a.tenantId, 'staff')
    for (const [tenant, others] of [
      [f.a, [{ userId: staffA, role: 'staff' }]],
      [f.b, []],
    ] as const) {
      const members = await tenant.as.query(api.platform.tenants.members, {
        tenantId: tenant.tenantId,
      })
      expect(members.map(({ userId, role }) => ({ userId, role }))).toEqual(
        expect.arrayContaining([
          { userId: tenant.userId, role: 'admin' },
          ...others,
        ]),
      )
      expect(members).toHaveLength(1 + others.length)
      expect(await tenant.as.query(api.platform.tenants.mine, {})).toEqual([
        expect.objectContaining({ _id: tenant.tenantId, role: 'admin' }),
      ])
    }
  })
})
