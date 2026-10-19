import { convexTest } from 'convex-test'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Id } from '../_generated/dataModel'
import schema from '../schema'
import { errorData, modules } from '../../test/fixture'
import { SEED_TAGS, UK_RELATIONSHIP_TYPES } from '../contacts/seed'
import { SEED_CATEGORIES } from '../sources/rules'
import {
  IDENTIFIER_TYPE,
  QC_EVENT_DETAIL,
  qcIdentifiers,
  qcSourceDetail,
} from './qcSeed'

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

test('four users, two tenants: A and B admin their own; staff and viewer in A', async () => {
  const { t, world } = await seed()
  expect(world.users).toEqual([
    { email: 'qc-r7w1-a@example.com', role: 'admin' },
    { email: 'qc-r7w1-b@example.com', role: 'admin' },
    { email: 'qc-r7w1-a-staff@example.com', role: 'staff' },
    { email: 'qc-r7w1-a-viewer@example.com', role: 'viewer' },
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
      tenantId: tenantA.tenantId,
      email: 'qc-r7w1-a-staff@example.com',
      role: 'staff',
    },
    {
      tenantId: tenantA.tenantId,
      email: 'qc-r7w1-a-viewer@example.com',
      role: 'viewer',
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
    ['password', 'qc-r7w1-a-staff@example.com'],
    ['password', 'qc-r7w1-a-viewer@example.com'],
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
  const listA = await asA
    .query(api.contacts.queries.list, {
      tenantId: tenantA.tenantId,
    })
    .then((r) => r.rows)
  const namesA = listA.map((c) => c.displayName)
  expect(namesA).toHaveLength(3)
  expect(namesA.every((n) => n.includes('Alpha-7'))).toBe(true)
  expect(listA.map((c) => c._id).sort()).toEqual([...tenantA.contactIds].sort())

  // A cannot read tenant B, nor B's contact through tenant A.
  await expect(
    asA
      .query(api.contacts.queries.list, { tenantId: tenantB.tenantId })
      .then((r) => r.rows),
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
    const isA = tenantId === world.tenants[0].tenantId
    // A: Ada's identifier and tag. B: every contact's identifier. Both:
    // Charles's and the Trust's acquisition code.
    const extra = isA
      ? [
          ['contacts.identifiers', 'contacts.tags'],
          ['contacts.acquisition'],
          ['contacts.acquisition'],
        ]
      : [
          ['contacts.identifiers'],
          ['contacts.identifiers', 'contacts.acquisition'],
          ['contacts.identifiers', 'contacts.acquisition'],
        ]
    for (const [i, contactId] of contactIds.entries()) {
      expect(
        revisions
          .filter((r) => r.entityId === contactId)
          .map((r) => r.contract)
          .sort(),
      ).toEqual(
        ['contacts.details', 'contacts.methods', ...(extra[i] ?? [])].sort(),
      )
    }
    // One identifier type, plus its archive in B.
    const typeRevisions = isA ? 1 : 2
    expect(revisions).toHaveLength(
      UK_RELATIONSHIP_TYPES.length +
        SEED_TAGS.length +
        SEED_CATEGORIES.length +
        // The side's Street detail and Event's Gala, each with its 001
        // and a 002.
        2 * 3 +
        contactIds.length * 2 +
        extra.flat().length +
        typeRevisions,
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
  // Same order too: specs take contactIds[0] to be Ada.
  expect(again.tenants.map((x) => x.contactIds)).toEqual(
    world.tenants.map((x) => x.contactIds),
  )
  const counts = await t.run(async (ctx) => ({
    tenants: (await ctx.db.query('tenants').collect()).length,
    memberships: (await ctx.db.query('memberships').collect()).length,
    users: (await ctx.db.query('users').collect()).length,
    contacts: (await ctx.db.query('contacts').collect()).length,
  }))
  expect(counts).toEqual({ tenants: 2, memberships: 4, users: 4, contacts: 6 })
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

test("identifiers: A finds its own, never B's; B has no active type", async () => {
  const { t, world } = await seed()
  const [tenantA, tenantB] = world.tenants
  const { shared, bOnly, bReuse } = qcIdentifiers('7', 1)
  expect(world.identifiers).toEqual({ shared, bOnly, bReuse })
  // The list search prefix-matches its last word: no value may start another.
  for (const a of [shared, bOnly, bReuse])
    for (const b of [shared, bOnly, bReuse])
      if (a !== b)
        expect(b.toLowerCase().startsWith(a.toLowerCase())).toBe(false)
  const viewer = await t.run(async (ctx) => {
    const user = await ctx.db
      .query('users')
      .withIndex('email', (q) => q.eq('email', 'qc-r7w1-a-viewer@example.com'))
      .unique()
    return user!._id
  })
  const asViewer = t.withIdentity({ subject: `${viewer}|session` })
  const search = (term: string) =>
    asViewer
      .query(api.contacts.queries.list, {
        tenantId: tenantA.tenantId,
        search: term,
      })
      .then((r) => r.rows.map((c) => c._id))

  // The value both tenants hold finds only A's Ada; B's own value nothing.
  expect(await search(shared)).toEqual([tenantA.contactIds[0]])
  expect(await search(bOnly)).toEqual([])
  expect(await search(bReuse)).toEqual([])

  const ada = await asViewer.query(api.contacts.queries.get, {
    tenantId: tenantA.tenantId,
    id: tenantA.contactIds[0],
  })
  expect(ada?.identifiers.map((r) => r.value)).toEqual([shared])
  expect(ada?.tags).toHaveLength(1)

  const types = await t.run((ctx) => ctx.db.query('identifierTypes').collect())
  expect(types.map((x) => [x.tenantId, x.name, x.isActive]).sort()).toEqual(
    [
      [tenantA.tenantId, IDENTIFIER_TYPE, true],
      [tenantB.tenantId, IDENTIFIER_TYPE, false],
    ].sort(),
  )
  const rowsB = await t.run(async (ctx) =>
    (await ctx.db.query('contactIdentifiers').collect())
      .filter((r) => r.tenantId === tenantB.tenantId)
      .map((r) => [r.contactId, r.value]),
  )
  expect(rowsB).toEqual([
    [tenantB.contactIds[0], shared],
    [tenantB.contactIds[1], bOnly],
    [tenantB.contactIds[2], bReuse],
  ])
})

test('hold: holds an address in one tenant only, again after a release', async () => {
  const { t, world } = await seed()
  const [tenantA, tenantB] = world.tenants
  const address = 'Ada-r7w1-a@example.com'
  const heldIn = (tenantId: Id<'tenants'>) =>
    t.run(async (ctx) =>
      (await ctx.db.query('emailSuppressions').collect())
        .filter((r) => r.tenantId === tenantId && r.suppressed)
        .map((r) => r.addressNormalized),
    )
  const hold = () =>
    t.mutation(internal.platform.qcSeed.hold, {
      tenantId: tenantA.tenantId,
      address,
    })

  expect(await hold()).toEqual({ changed: true, counter: 0 })
  expect(await hold()).toEqual({ changed: false, counter: 0 })
  expect(await heldIn(tenantA.tenantId)).toEqual(['ada-r7w1-a@example.com'])
  expect(await heldIn(tenantB.tenantId)).toEqual([])

  const adminId = await t.run(async (ctx) => {
    const user = await ctx.db
      .query('users')
      .withIndex('email', (q) => q.eq('email', world.users[0].email))
      .unique()
    return user!._id
  })
  const admin = t.withIdentity({ subject: `${adminId}|session` })
  await admin.mutation(api.comms.suppressions.release, {
    tenantId: tenantA.tenantId,
    address,
    expected: 0,
    note: '',
  })
  expect(await heldIn(tenantA.tenantId)).toEqual([])
  expect(await hold()).toEqual({ changed: true, counter: 2 })
})

test('hold refuses unless QC_SEED_ENABLED is "1", and an unknown tenant', async () => {
  const { t, world } = await seed()
  const tenantId = world.tenants[0].tenantId
  vi.stubEnv('QC_SEED_ENABLED', '')
  expect(
    await errorData(
      t.mutation(internal.platform.qcSeed.hold, {
        tenantId,
        address: 'x@example.com',
      }),
    ),
  ).toMatchObject({ kind: 'disabled' })
  vi.stubEnv('QC_SEED_ENABLED', '1')
  await t.run((ctx) => ctx.db.delete('tenants', tenantId))
  expect(
    await errorData(
      t.mutation(internal.platform.qcSeed.hold, {
        tenantId,
        address: 'x@example.com',
      }),
    ),
  ).toMatchObject({ kind: 'not_found' })
  expect(
    await t.run(
      async (ctx) => (await ctx.db.query('emailSuppressions').collect()).length,
    ),
  ).toBe(0)
})

test("each side's Street category holds its own detail; Event holds Gala; nothing else", async () => {
  const { t, world } = await seed()
  for (const [i, label] of ['Alpha', 'Bravo'].entries()) {
    const rows = (await t.run((ctx) => ctx.db.query('sourceCodes').collect()))
      .filter((r) => r.tenantId === world.tenants[i].tenantId)
      .filter((r) => r.level !== 'category')
    expect(rows.map((r) => [r.level, r.name])).toEqual([
      ['detail', qcSourceDetail(label, '7')],
      ['version', '001'],
      ['version', '002'],
      ['detail', QC_EVENT_DETAIL],
      ['version', '001'],
      ['version', '002'],
    ])
  }
})

test('source codes: Charles and the Trust coded under Street; Event-Gala free', async () => {
  const { t, world } = await seed()
  for (const [i, tenant] of world.tenants.entries()) {
    const id = await t.run(async (ctx) => {
      const user = await ctx.db
        .query('users')
        .withIndex('email', (q) => q.eq('email', world.users[i].email))
        .unique()
      return user!._id
    })
    const as = t.withIdentity({ subject: `${id}|session` })
    const detail = qcSourceDetail(i === 0 ? 'Alpha' : 'Bravo', '7')
    const { codes } = await as.query(api.sources.queries.picker, {
      tenantId: tenant.tenantId,
      today: '2026-10-19',
    })
    expect(codes.map((c) => c.code)).toEqual(
      expect.arrayContaining([
        `Event-${QC_EVENT_DETAIL}-001`,
        `Event-${QC_EVENT_DETAIL}-002`,
        `Street-${detail}-001`,
        `Street-${detail}-002`,
      ]),
    )
    const byCode = new Map(codes.map((c) => [c.code, c.versionId]))
    const [, charles, trust] = tenant.contactIds
    const coded = await Promise.all(
      [charles, trust].map((contactId) =>
        as.query(api.contacts.queries.get, {
          tenantId: tenant.tenantId,
          id: contactId,
        }),
      ),
    )
    expect(coded.map((c) => c?.acquisition?.code)).toEqual([
      `Street-${detail}-001`,
      `Street-${detail}-002`,
    ])
    const version = await as.query(api.contacts.queries.list, {
      tenantId: tenant.tenantId,
      source: { level: 'version', id: byCode.get(`Street-${detail}-002`)! },
    })
    expect(version.rows.map((r) => r._id)).toEqual([trust])
  }
})
