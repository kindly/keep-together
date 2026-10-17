import { convexTest } from 'convex-test'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import schema from '../schema'
import { errorData, modules } from '../../test/fixture'
import { SEED_TAGS, UK_RELATIONSHIP_TYPES } from '../contacts/seed'

// 12+ characters: auth.ts may gain a minimum-length password check.
const password = 'qc-password-123'

// convex-test runs functions in this process, and `env` from
// _generated/server is process.env, so stubbing it reaches them.
beforeEach(() => {
  vi.stubEnv('QC_SEED_ENABLED', '1')
})
afterEach(() => {
  vi.unstubAllEnvs()
})

async function seed() {
  const t = convexTest(schema, modules)
  const world = await t.action(internal.platform.qcSeed.fixture, {
    runId: '7',
    worker: 1,
    password,
  })
  return { t, world }
}

test('two users, two tenants, each user a member of their own tenant only', async () => {
  const { t, world } = await seed()
  expect(world.users.map((u) => u.email)).toEqual([
    'qc-r7w1-a@example.com',
    'qc-r7w1-b@example.com',
  ])
  expect(world.tenants.map((x) => x.slug)).toEqual(['r7w1-a', 'r7w1-b'])

  const [tenantA, tenantB] = world.tenants
  const memberships = await t.run(async (ctx) => {
    const rows = await ctx.db.query('memberships').collect()
    return Promise.all(
      rows.map(async (m) => ({
        tenantId: m.tenantId,
        email: (await ctx.db.get(m.userId))?.email,
        role: m.role,
      })),
    )
  })
  expect(memberships).toEqual([
    {
      tenantId: tenantA.tenantId,
      email: 'qc-r7w1-a@example.com',
      role: 'admin',
    },
    {
      tenantId: tenantB.tenantId,
      email: 'qc-r7w1-b@example.com',
      role: 'admin',
    },
  ])
})

test('each seeded user has a hashed password account', async () => {
  const { t } = await seed()
  const accounts = await t.run((ctx) => ctx.db.query('authAccounts').collect())
  expect(accounts.map((a) => [a.provider, a.providerAccountId])).toEqual([
    ['password', 'qc-r7w1-a@example.com'],
    ['password', 'qc-r7w1-b@example.com'],
  ])
  // Stored as a hash, never the password itself.
  expect(accounts.every((a) => a.secret && a.secret !== password)).toBe(true)
})

test('contacts are scoped to their tenant and carry distinctive names', async () => {
  const { t, world } = await seed()
  const [tenantA, tenantB] = world.tenants
  const userIdOf = (email: string) =>
    t.run(async (ctx) => {
      const user = await ctx.db
        .query('users')
        .withIndex('email', (q) => q.eq('email', email))
        .unique()
      return user!._id
    })
  const as = async (email: string) =>
    t.withIdentity({ subject: `${await userIdOf(email)}|session` })

  const asA = await as('qc-r7w1-a@example.com')
  const listA = await asA.query(api.contacts.queries.list, {
    tenantId: tenantA.tenantId,
  })
  const namesA = listA.map((c) => c.displayName)
  expect(namesA).toHaveLength(3)
  expect(namesA.every((n) => n.includes('Alpha-7'))).toBe(true)
  expect(listA.map((c) => c._id).sort()).toEqual([...tenantA.contactIds].sort())

  // A cannot read tenant B, nor B's contact through tenant A.
  await expect(
    asA.query(api.contacts.queries.list, { tenantId: tenantB.tenantId }),
  ).rejects.toThrow()
  expect(
    await asA.query(api.contacts.queries.get, {
      tenantId: tenantA.tenantId,
      id: tenantB.contactIds[0],
    }),
  ).toBeNull()

  const rows = await t.run((ctx) => ctx.db.query('contacts').collect())
  for (const tenant of world.tenants) {
    const ids = rows
      .filter((r) => r.tenantId === tenant.tenantId)
      .map((r) => r._id)
    expect(ids.sort()).toEqual([...tenant.contactIds].sort())
  }
  expect(
    rows
      .filter((r) => r.tenantId === tenantB.tenantId)
      .every((r) => r.displayName.includes('Bravo-7')),
  ).toBe(true)
})

test('every seeded write went through a contract and left a revision', async () => {
  const { t, world } = await seed()
  for (const { tenantId, contactIds } of world.tenants) {
    const { revisions, types } = await t.run(async (ctx) => ({
      revisions: (await ctx.db.query('revisions').collect()).filter(
        (r) => r.tenantId === tenantId,
      ),
      types: (await ctx.db.query('relationshipTypes').collect()).filter(
        (r) => r.tenantId === tenantId,
      ),
    }))
    expect(types).toHaveLength(UK_RELATIONSHIP_TYPES.length)
    for (const contactId of contactIds) {
      expect(
        revisions
          .filter((r) => r.entityId === contactId)
          .map((r) => r.contract)
          .sort(),
      ).toEqual(['contacts.details', 'contacts.methods'])
    }
    expect(revisions).toHaveLength(
      UK_RELATIONSHIP_TYPES.length + SEED_TAGS.length + contactIds.length * 2,
    )
  }
})

test('a second worker in the same run gets its own tenants', async () => {
  const { t } = await seed()
  const other = await t.action(internal.platform.qcSeed.fixture, {
    runId: '7',
    worker: 2,
    password,
  })
  expect(other.tenants.map((x) => x.slug)).toEqual(['r7w2-a', 'r7w2-b'])
  const tenants = await t.run((ctx) => ctx.db.query('tenants').collect())
  expect(tenants).toHaveLength(4)
})

test('re-running the same run and worker returns the same world', async () => {
  const { t, world } = await seed()
  const again = await t.action(internal.platform.qcSeed.fixture, {
    runId: '7',
    worker: 1,
    password,
  })
  expect(again.users).toEqual(world.users)
  expect(again.tenants.map((x) => [x.slug, x.tenantId])).toEqual(
    world.tenants.map((x) => [x.slug, x.tenantId]),
  )
  for (const [i, tenant] of again.tenants.entries()) {
    expect([...tenant.contactIds].sort()).toEqual(
      [...world.tenants[i].contactIds].sort(),
    )
  }
  const counts = await t.run(async (ctx) => ({
    tenants: (await ctx.db.query('tenants').collect()).length,
    memberships: (await ctx.db.query('memberships').collect()).length,
    users: (await ctx.db.query('users').collect()).length,
    contacts: (await ctx.db.query('contacts').collect()).length,
  }))
  expect(counts).toEqual({ tenants: 2, memberships: 2, users: 2, contacts: 6 })
})

test('a slug held by someone else is refused, not duplicated', async () => {
  const t = convexTest(schema, modules)
  await t.run(async (ctx) => {
    const userId = await ctx.db.insert('users', { email: 'real@example.com' })
    const tenantId = await ctx.db.insert('tenants', {
      slug: 'r7w1-a',
      name: 'A real group',
      status: 'active',
    })
    await ctx.db.insert('memberships', { tenantId, userId, role: 'admin' })
  })
  expect(
    await errorData(
      t.action(internal.platform.qcSeed.fixture, {
        runId: '7',
        worker: 1,
        password,
      }),
    ),
  ).toEqual({ kind: 'taken', slug: 'r7w1-a' })
  const slugs = await t.run(async (ctx) =>
    (await ctx.db.query('tenants').collect()).map((x) => x.slug),
  )
  expect(slugs).toEqual(['r7w1-a'])
})

test('a run id that makes an invalid slug is refused', async () => {
  const t = convexTest(schema, modules)
  expect(
    await errorData(
      t.action(internal.platform.qcSeed.fixture, {
        runId: 'NOT valid',
        worker: 1,
        password,
      }),
    ),
  ).toEqual({ kind: 'invalid', field: 'slug' })
})

test('both functions refuse unless QC_SEED_ENABLED is "1"', async () => {
  vi.stubEnv('QC_SEED_ENABLED', '')
  const t = convexTest(schema, modules)
  const action = errorData(
    t.action(internal.platform.qcSeed.fixture, {
      runId: '7',
      worker: 1,
      password,
    }),
  )
  expect(await action).toMatchObject({ kind: 'disabled' })
  expect(String((await action).message)).toContain('QC_SEED_ENABLED')
  const userId = await t.run((ctx) =>
    ctx.db.insert('users', { email: 'x@example.com' }),
  )
  expect(
    await errorData(
      t.mutation(internal.platform.qcSeed.world, {
        runId: '7',
        worker: 1,
        userIds: [userId, userId],
      }),
    ),
  ).toMatchObject({ kind: 'disabled' })
  const counts = await t.run(async (ctx) => ({
    users: (await ctx.db.query('users').collect()).length,
    tenants: (await ctx.db.query('tenants').collect()).length,
  }))
  expect(counts).toEqual({ users: 1, tenants: 0 })
})
