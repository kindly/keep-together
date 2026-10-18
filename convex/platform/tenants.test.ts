import { expect, test } from 'vitest'
import { api, internal } from '../_generated/api'
import { errorData, setup, snapshot } from '../../test/fixture'
import { create } from './tenants'

async function signedUp(
  t: Awaited<ReturnType<typeof setup>>['t'],
  email: string,
) {
  return t.run((ctx) => ctx.db.insert('users', { email }))
}

test('create is internal: not part of the client api', () => {
  // Registered as internalMutation, so a client can't reach it by name.
  expect((create as unknown as { isInternal: boolean }).isInternal).toBe(true)
  expect((create as unknown as { isPublic?: boolean }).isPublic).toBeFalsy()
  // @ts-expect-error `create` is not in the public api
  void api.platform.tenants.create
})

test('create makes the user with adminEmail its admin, and seeds reference data', async () => {
  const { t } = await setup()
  const userId = await signedUp(t, 'jo@example.org')
  const tenantId = await t.mutation(internal.platform.tenants.create, {
    slug: 'anytown-hall',
    name: '  Anytown Village Hall ',
    adminEmail: ' jo@example.org',
  })
  await t.finishAllScheduledFunctions(() => {})

  const { tenant, memberships, types } = await t.run(async (ctx) => ({
    tenant: await ctx.db.get(tenantId),
    memberships: await ctx.db
      .query('memberships')
      .withIndex('by_tenant_user', (q) => q.eq('tenantId', tenantId))
      .collect(),
    types: await ctx.db
      .query('relationshipTypes')
      .withIndex('by_tenant', (q) => q.eq('tenantId', tenantId))
      .collect(),
  }))
  expect(tenant).toMatchObject({
    slug: 'anytown-hall',
    name: 'Anytown Village Hall',
    status: 'active',
  })
  // Exactly one membership, the admin's.
  expect(memberships.map((m) => [m.userId, m.role])).toEqual([
    [userId, 'admin'],
  ])
  expect(types.length).toBeGreaterThan(0)
  // Households are dormant: a new tenant gets no household types.
  expect(
    types.filter((t) => t.kindA === 'household' || t.kindB === 'household'),
  ).toEqual([])

  const jo = t.withIdentity({ subject: `${userId}|session-jo` })
  expect(await jo.query(api.platform.tenants.mine, {})).toEqual([
    {
      _id: tenantId,
      slug: 'anytown-hall',
      name: 'Anytown Village Hall',
      role: 'admin',
      staffCanManageTags: false,
      tagsVersion: null,
      staffCanManageIdentifierTypes: false,
      identifierTypesVersion: null,
      canManageTags: true,
      canManageIdentifierTypes: true,
    },
  ])
})

test('an adminEmail with no user is refused and creates nothing', async () => {
  const { t } = await setup()
  expect(
    await errorData(
      t.mutation(internal.platform.tenants.create, {
        slug: 'anytown-hall',
        name: 'Anytown',
        adminEmail: 'nobody@example.org',
      }),
    ),
  ).toMatchObject({ kind: 'unknownUser', field: 'adminEmail' })
  const slugs = await t.run(async (ctx) =>
    (await ctx.db.query('tenants').collect()).map((x) => x.slug),
  )
  expect(slugs).toEqual(['alpha', 'beta'])
})

test('an adminEmail shared by two users is refused and creates nothing', async () => {
  const { t } = await setup()
  await signedUp(t, 'jo@example.org')
  await signedUp(t, 'jo@example.org')
  expect(
    await errorData(
      t.mutation(internal.platform.tenants.create, {
        slug: 'anytown-hall',
        name: 'Anytown',
        adminEmail: 'jo@example.org',
      }),
    ),
  ).toMatchObject({ kind: 'ambiguousUser', field: 'adminEmail' })
  const slugs = await t.run(async (ctx) =>
    (await ctx.db.query('tenants').collect()).map((x) => x.slug),
  )
  expect(slugs).toEqual(['alpha', 'beta'])
})

test('slug rules still hold: malformed or taken slugs are refused', async () => {
  const { t } = await setup()
  await signedUp(t, 'jo@example.org')
  const attempt = (slug: string) =>
    errorData(
      t.mutation(internal.platform.tenants.create, {
        slug,
        name: 'X',
        adminEmail: 'jo@example.org',
      }),
    )
  for (const slug of [
    'ab',
    'Upper',
    '-lead',
    'trail-',
    'sp ace',
    'a'.repeat(41),
  ]) {
    expect(await attempt(slug)).toEqual({ kind: 'invalid', field: 'slug' })
  }
  expect(await attempt('alpha')).toEqual({ kind: 'taken', field: 'slug' })
})

test('a new tenant leaves existing tenants untouched and sees none of their data', async () => {
  const { t, a, b } = await setup()
  const beforeA = await snapshot(t, a.tenantId)
  const beforeB = await snapshot(t, b.tenantId)
  // Alpha's user becomes admin of a second tenant too.
  const gamma = await t.mutation(internal.platform.tenants.create, {
    slug: 'gamma',
    name: 'Gamma',
    adminEmail: 'alpha@example.com',
  })
  await t.finishAllScheduledFunctions(() => {})

  expect(await snapshot(t, a.tenantId)).toBe(beforeA)
  expect(await snapshot(t, b.tenantId)).toBe(beforeB)
  expect(
    (await a.as.query(api.platform.tenants.mine, {})).map((x) => x.slug),
  ).toEqual(['alpha', 'gamma'])
  expect(
    (await b.as.query(api.platform.tenants.mine, {})).map((x) => x.slug),
  ).toEqual(['beta'])
  // Beta's user is not a member of the new tenant.
  expect(await b.as.query(api.platform.tenants.bySlug, { slug: 'gamma' })).toBe(
    null,
  )
  expect(
    await errorData(
      b.as.query(api.platform.tenants.members, { tenantId: gamma }),
    ),
  ).toMatchObject({ kind: 'forbidden' })
})
