import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Id } from '../_generated/dataModel'
import { errorData, setup, snapshot } from '../../test/fixture'
import { contactWarnings } from '../contacts/warnings'
import { UK_RELATIONSHIP_TYPES } from '../contacts/seed'
import { TEST_TENANT, TEST_USERS } from './testSeed'
import { DONOR_COUNT, generateDonors } from './testSeedData'

const passwords = { owner: 'owner-password-123', staff: 'staff-password-123' }

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
      revisions: await n('revisions'),
    }
  })

test('the generator is deterministic and varied', () => {
  const first = generateDonors()
  expect(generateDonors()).toEqual(first)
  const { donors, relationships } = first
  expect(donors).toHaveLength(DONOR_COUNT)
  expect(new Set(donors.map((d) => d.clientKey)).size).toBe(DONOR_COUNT)

  const kinds = donors.map((d) => d.details.kind)
  for (const kind of ['individual', 'organization', 'household']) {
    expect(kinds.filter((k) => k === kind).length).toBeGreaterThan(5)
  }
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

  const owner = await t.run(async (ctx) => {
    const user = await ctx.db
      .query('users')
      .withIndex('email', (q) => q.eq('email', TEST_USERS.owner.email))
      .unique()
    return user!._id
  })
  const asOwner = t.withIdentity({ subject: `${owner}|session` })
  const list = await asOwner.query(api.contacts.queries.list, {
    tenantId: world.tenantId,
  })
  expect(list.length).toBeGreaterThan(0)
  // The seeded owner can't see the fixture's tenants.
  await expect(
    asOwner.query(api.contacts.queries.list, { tenantId: a.tenantId }),
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
  expect(notes.every((n) => n.createdBy === owner)).toBe(true)
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
})

test('a rerun creates nothing and leaves the data alone', async () => {
  const { t, world } = await seeded()
  const counts = await count(t)
  const again = await t.action(internal.platform.testSeed.seed, { passwords })
  expect(again.tenantId).toBe(world.tenantId)
  expect(again.donorsCreated).toBe(0)
  expect(await count(t)).toEqual(counts)
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
})

test('a missing password is refused before anything is written', async () => {
  const { t } = await setup()
  const counts = await count(t)
  expect(
    await errorData(
      t.action(internal.platform.testSeed.seed, {
        passwords: { owner: passwords.owner },
      }),
    ),
  ).toEqual({ kind: 'missing_password', missing: ['staff'] })
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
        members: [{ role: 'owner', userId: a.userId }],
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
