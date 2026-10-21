import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Id } from '../_generated/dataModel'
import { errorData, setup, snapshot } from '../../test/fixture'
import { contactWarnings } from '../contacts/warnings'
import { UK_RELATIONSHIP_TYPES } from '../contacts/seed'
import { TEST_TENANT, TEST_USERS } from './testSeed'
import {
  DONOR_COUNT,
  generateDonors,
  IDENTIFIER_TYPES,
  SOURCE_DETAILS,
} from './testSeedData'

const passwords = {
  admin: 'admin-password-123',
  staff: 'staff-password-123',
  viewer: 'viewer-password-123',
}

// convex-test runs functions in this process, and `env` from
// _generated/server is process.env, so stubbing it reaches them.
beforeEach(() => {
  vi.stubEnv('TEST_SEED_ENABLED', '1')
})
afterEach(() => {
  vi.unstubAllEnvs()
})

// Two unrelated tenants first (the shared fixture), so every test can
// assert the seed leaves them alone.
async function seeded() {
  const { t, a, b } = await setup()
  const before = [await snapshot(t, a.tenantId), await snapshot(t, b.tenantId)]
  const world = await t.action(internal.platform.testSeed.seed, { passwords })
  return { t, a, b, before, world }
}

const count = (t: Awaited<ReturnType<typeof setup>>['t']) =>
  t.run(async (ctx) => {
    const n = async (table: Parameters<typeof ctx.db.query>[0]) =>
      (await ctx.db.query(table).collect()).length
    return {
      users: await n('users'),
      tenants: await n('tenants'),
      memberships: await n('memberships'),
      contacts: await n('contacts'),
      contactNotes: await n('contactNotes'),
      relationships: await n('relationships'),
      relationshipTypes: await n('relationshipTypes'),
      identifierTypes: await n('identifierTypes'),
      contactIdentifiers: await n('contactIdentifiers'),
      commandGroups: await n('commandGroups'),
      revisions: await n('revisions'),
      sourceCodes: await n('sourceCodes'),
    }
  })

test('the generator is deterministic and varied', () => {
  const first = generateDonors()
  expect(generateDonors()).toEqual(first)
  const { donors, relationships } = first
  expect(donors).toHaveLength(DONOR_COUNT)
  expect(new Set(donors.map((d) => d.clientKey)).size).toBe(DONOR_COUNT)

  const kinds = donors.map((d) => d.details.kind)
  for (const kind of ['individual', 'organization']) {
    expect(kinds.filter((k) => k === kind).length).toBeGreaterThan(5)
  }
  expect(kinds).not.toContain('household') // dormant
  const emails = donors.flatMap((d) => d.methods.emails.map((e) => e.address))
  expect(new Set(emails).size).toBeLessThan(emails.length) // some shared
  const warned = donors.map((d) =>
    contactWarnings({
      emails: d.methods.emails.map((e) => ({
        key: e.key!,
        address: e.address,
      })),
      phones: d.methods.phones,
      addresses: d.addresses.addresses,
    }),
  )
  expect(
    warned.some((w) => w.some((x) => /look like an email/.test(x.message))),
  ).toBe(true)
  expect(warned.some((w) => w.some((x) => /UK postcode/.test(x.message)))).toBe(
    true,
  )
  const addresses = donors.flatMap((d) => d.addresses.addresses)
  expect(addresses.some((x) => x.postcode === '')).toBe(true)
  expect(addresses.some((x) => x.country !== 'GB')).toBe(true)
  expect(donors.some((d) => d.archived)).toBe(true)
  const notes = donors.flatMap((d) => d.notes)
  expect(notes.some((n) => n.pinned)).toBe(true)
  expect(notes.some((n) => n.archived)).toBe(true)
  const ids = donors.flatMap((d) => d.identifiers)
  for (const type of IDENTIFIER_TYPES) {
    expect(ids.filter((x) => x.type === type).length).toBeGreaterThan(5)
  }
  expect(donors.some((d) => d.identifiers.length > 1)).toBe(true)
  expect(new Set(ids.map((x) => x.value)).size).toBe(ids.length)
  const used = new Set(relationships.map((r) => r.type))
  expect([...used].sort()).toEqual(
    UK_RELATIONSHIP_TYPES.map(([labelAB]) => labelAB).sort(),
  )
})

test('one user per role, each a member of the seeded tenant at that role', async () => {
  const { t, world } = await seeded()
  expect(world.slug).toBe(TEST_TENANT.slug)
  expect(world.users).toEqual(
    Object.entries(TEST_USERS).map(([role, { email }]) => ({ role, email })),
  )
  const memberships = await t.run(async (ctx) => {
    const rows = await ctx.db
      .query('memberships')
      .withIndex('by_tenant_user', (q) => q.eq('tenantId', world.tenantId))
      .collect()
    return Promise.all(
      rows.map(async (m) => ({
        email: (await ctx.db.get(m.userId))?.email,
        role: m.role,
      })),
    )
  })
  expect(memberships.sort((x, y) => x.role.localeCompare(y.role))).toEqual(
    Object.entries(TEST_USERS).map(([role, { email }]) => ({ email, role })),
  )
  const accounts = await t.run((ctx) => ctx.db.query('authAccounts').collect())
  expect(accounts.map((x) => x.providerAccountId).sort()).toEqual(
    Object.values(TEST_USERS)
      .map((u) => u.email)
      .sort(),
  )
  // Stored as a hash, never the password itself.
  expect(
    accounts.every(
      (x) => x.secret && !Object.values(passwords).includes(x.secret),
    ),
  ).toBe(true)
})

test('100 donors land in the seeded tenant only, through contracts', async () => {
  const { t, a, b, before, world } = await seeded()
  expect(world.donorsCreated).toBe(DONOR_COUNT)
  expect([
    await snapshot(t, a.tenantId),
    await snapshot(t, b.tenantId),
  ]).toEqual(before)

  const admin = await t.run(async (ctx) => {
    const user = await ctx.db
      .query('users')
      .withIndex('email', (q) => q.eq('email', TEST_USERS.admin.email))
      .unique()
    return user!._id
  })
  const asAdmin = t.withIdentity({ subject: `${admin}|session` })
  const list = await asAdmin
    .query(api.contacts.queries.search, {
      tenantId: world.tenantId,
    })
    .then((r) => r.rows)
  expect(list.length).toBeGreaterThan(0)
  // The seeded admin can't see the fixture's tenants.
  await expect(
    asAdmin
      .query(api.contacts.queries.search, { tenantId: a.tenantId })
      .then((r) => r.rows),
  ).rejects.toThrow()

  const { contacts, revisions, notes, links } = await t.run(async (ctx) => {
    const mine = <T extends { tenantId: Id<'tenants'> }>(rows: Array<T>) =>
      rows.filter((r) => r.tenantId === world.tenantId)
    return {
      contacts: mine(await ctx.db.query('contacts').collect()),
      revisions: mine(await ctx.db.query('revisions').collect()),
      notes: mine(await ctx.db.query('contactNotes').collect()),
      links: mine(await ctx.db.query('relationships').collect()),
    }
  })
  const { donors, relationships } = generateDonors()
  expect(contacts).toHaveLength(DONOR_COUNT)
  expect(contacts.filter((c) => c.archived)).toHaveLength(
    donors.filter((d) => d.archived).length,
  )
  expect(notes).toHaveLength(donors.flatMap((d) => d.notes).length)
  expect(notes.every((n) => n.createdBy === admin)).toBe(true)
  expect(links).toHaveLength(relationships.length)
  // Every contact was created by contacts.details and has its methods and
  // addresses slices.
  for (const c of contacts) {
    const own = revisions
      .filter((r) => r.entityId === c._id)
      .map((r) => r.contract)
    expect(own).toEqual(
      expect.arrayContaining([
        'contacts.details',
        'contacts.methods',
        'contacts.addresses',
      ]),
    )
  }
  expect(revisions.every((r) => r.source === 'seed')).toBe(true)

  // Identifier rows under the two types, findable by the list search.
  const seededIds = donors.flatMap((d) =>
    d.identifiers.map((x) => [d.clientKey, x.type, x.value]),
  )
  const rows = await t.run(async (ctx) => {
    const types = await ctx.db.query('identifierTypes').collect()
    return Promise.all(
      (await ctx.db.query('contactIdentifiers').collect())
        .filter((r) => r.tenantId === world.tenantId)
        .map(async (r) => [
          (await ctx.db.get(r.contactId))?.clientKey,
          types.find((x) => x._id === r.typeId)?.name,
          r.value,
        ]),
    )
  })
  expect(rows.sort()).toEqual(seededIds.sort())
  const [, , value] = seededIds[0]
  const hits = await asAdmin
    .query(api.contacts.queries.search, {
      tenantId: world.tenantId,
      search: value,
      includeArchived: true,
    })
    .then((r) => r.rows.map((c) => c._id))
  expect(hits).toEqual([
    contacts.find((c) => c.clientKey === seededIds[0][0])!._id,
  ])
})

test('a rerun creates nothing and leaves the data alone', async () => {
  const { t, world } = await seeded()
  const counts = await count(t)
  const again = await t.action(internal.platform.testSeed.seed, { passwords })
  expect(again.tenantId).toBe(world.tenantId)
  expect(again.donorsCreated).toBe(0)
  expect(await count(t)).toEqual(counts)
})

test('demo source codes land under the seeded categories, in the seeded tenant only', async () => {
  const { t, a, world } = await seeded()
  const admin = await t.run(async (ctx) => {
    const user = await ctx.db
      .query('users')
      .withIndex('email', (q) => q.eq('email', TEST_USERS.admin.email))
      .unique()
    return user!._id
  })
  const asAdmin = t.withIdentity({ subject: `${admin}|session` })
  const tree = await asAdmin.query(api.sources.queries.tree, {
    tenantId: world.tenantId,
  })
  const codes = tree.filter((p) => p.level === 'version').map((p) => p.code)
  expect(codes).toEqual(
    expect.arrayContaining([
      'Street-Wesser-001',
      'Street-Wesser-002',
      'Direct mail-Xmas25-Warm',
      'Direct mail-Xmas25-Lapsed',
      'Event-Gala26-001',
    ]),
  )
  expect(tree.filter((p) => p.level === 'detail')).toHaveLength(
    SOURCE_DETAILS.length,
  )
  const bath = tree.find((p) => p.code === 'Event-BathHalf25-001')!
  expect(bath).toMatchObject({ isActive: true, visible: false })
  const spring = tree.find((p) => p.code === 'Street-Wesser-001')!
  expect(spring).toMatchObject({
    description: 'Spring run',
    endDate: '2026-05-31',
  })
  const other = await t.run((ctx) => ctx.db.query('sourceCodes').collect())
  expect(
    other.filter((r) => r.tenantId === a.tenantId && r.level !== 'category'),
  ).toEqual([])
})

test('a changed password replaces the stored one; the same one keeps it', async () => {
  const { t } = await seeded()
  const secrets = () =>
    t.run(async (ctx) =>
      (await ctx.db.query('authAccounts').collect()).map((x) => x.secret),
    )
  const first = await secrets()
  await t.action(internal.platform.testSeed.seed, { passwords })
  expect(await secrets()).toEqual(first)
  await t.action(internal.platform.testSeed.seed, {
    passwords: { ...passwords, staff: 'a-new-staff-password' },
  })
  const after = await secrets()
  expect(after[0]).toBe(first[0])
  expect(after[1]).not.toBe(first[1])
  expect(after[2]).toBe(first[2])
})

test('a missing password is refused before anything is written', async () => {
  const { t } = await setup()
  const counts = await count(t)
  expect(
    await errorData(
      t.action(internal.platform.testSeed.seed, {
        passwords: { admin: passwords.admin },
      }),
    ),
  ).toEqual({ kind: 'missing_password', missing: ['staff', 'viewer'] })
  expect(await count(t)).toEqual(counts)
})

test('every function refuses unless TEST_SEED_ENABLED is "1"', async () => {
  vi.stubEnv('TEST_SEED_ENABLED', '')
  const { t, a } = await setup()
  const counts = await count(t)
  const action = errorData(
    t.action(internal.platform.testSeed.seed, { passwords }),
  )
  expect(await action).toMatchObject({ kind: 'disabled' })
  expect(String((await action).message)).toContain('TEST_SEED_ENABLED')
  expect(
    await errorData(t.query(internal.platform.testSeed.users, {})),
  ).toMatchObject({ kind: 'disabled' })
  expect(
    await errorData(
      t.mutation(internal.platform.testSeed.tenant, {
        members: [{ role: 'admin', userId: a.userId }],
      }),
    ),
  ).toMatchObject({ kind: 'disabled' })
  expect(
    await errorData(
      t.mutation(internal.platform.testSeed.donors, {
        tenantId: a.tenantId,
        actor: a.userId,
        from: 0,
        to: 10,
      }),
    ),
  ).toMatchObject({ kind: 'disabled' })
  expect(await count(t)).toEqual(counts)
})

test('an archived "External reference" stays archived; its rows are skipped', async () => {
  const { t, a } = await setup()
  // An older instance: the tenant exists and an admin archived the type
  // before the donors were seeded.
  const tenantId = await t.mutation(internal.platform.testSeed.tenant, {
    members: [{ role: 'admin', userId: a.userId }],
  })
  await t.run(async (ctx) => {
    const type = (await ctx.db.query('identifierTypes').collect()).find(
      (x) => x.tenantId === tenantId && x.name === 'External reference',
    )!
    await ctx.db.patch('identifierTypes', type._id, { isActive: false })
  })
  const world = await t.action(internal.platform.testSeed.seed, { passwords })
  expect(world.donorsCreated).toBe(DONOR_COUNT)

  const { types, rows } = await t.run(async (ctx) => ({
    types: (await ctx.db.query('identifierTypes').collect()).filter(
      (x) => x.tenantId === tenantId,
    ),
    rows: (await ctx.db.query('contactIdentifiers').collect()).filter(
      (r) => r.tenantId === tenantId,
    ),
  }))
  expect(types.map((x) => [x.name, x.isActive]).sort()).toEqual([
    ['External reference', false],
    ['Membership number', true],
  ])
  const membership = types.find((x) => x.name === 'Membership number')!._id
  const expected = generateDonors().donors.flatMap((d) =>
    d.identifiers.filter((x) => x.type === 'Membership number'),
  )
  expect(rows.length).toBe(expected.length)
  expect(rows.every((r) => r.typeId === membership)).toBe(true)
})
