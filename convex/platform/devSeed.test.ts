import { expect, test } from 'vitest'
import { internal } from '../_generated/api'
import type { Id } from '../_generated/dataModel'
import { errorData, setup } from '../../test/fixture'

async function adminsOf(
  t: Awaited<ReturnType<typeof setup>>['t'],
  tenantId: Id<'tenants'>,
) {
  return t.run(async (ctx) => {
    const rows = await ctx.db
      .query('memberships')
      .withIndex('by_tenant_user', (q) => q.eq('tenantId', tenantId))
      .collect()
    return Promise.all(
      rows.map(async (m) => ({
        userId: m.userId,
        email: (await ctx.db.get(m.userId))?.email,
        role: m.role,
      })),
    )
  })
}

test('demoTenant makes an existing user with adminEmail the admin', async () => {
  const { t } = await setup()
  const userId = await t.run((ctx) =>
    ctx.db.insert('users', { email: 'me@example.org' }),
  )
  const { tenantId, userId: admin } = await t.mutation(
    internal.platform.devSeed.demoTenant,
    { slug: 'demo', adminEmail: ' me@example.org' },
  )
  await t.finishAllScheduledFunctions(() => {})

  expect(admin).toBe(userId)
  expect(await adminsOf(t, tenantId)).toEqual([
    { userId, email: 'me@example.org', role: 'admin' },
  ])
  const users = await t.run((ctx) =>
    ctx.db
      .query('users')
      .withIndex('email', (q) => q.eq('email', 'me@example.org'))
      .collect(),
  )
  expect(users).toHaveLength(1)
})

test('demoTenant without adminEmail creates <slug>-admin@example.com', async () => {
  const { t } = await setup()
  const { tenantId, userId } = await t.mutation(
    internal.platform.devSeed.demoTenant,
    { slug: 'demo' },
  )
  await t.finishAllScheduledFunctions(() => {})
  expect(await adminsOf(t, tenantId)).toEqual([
    { userId, email: 'demo-admin@example.com', role: 'admin' },
  ])
  const types = await t.run((ctx) =>
    ctx.db
      .query('relationshipTypes')
      .withIndex('by_tenant', (q) => q.eq('tenantId', tenantId))
      .collect(),
  )
  expect(types.length).toBeGreaterThan(0)
})

test('demoTenant refuses a taken slug instead of making a duplicate tenant', async () => {
  const { t } = await setup()
  expect(
    await errorData(
      t.mutation(internal.platform.devSeed.demoTenant, { slug: 'alpha' }),
    ),
  ).toEqual({ kind: 'taken', field: 'slug' })
  const slugs = await t.run(async (ctx) =>
    (await ctx.db.query('tenants').collect()).map((x) => x.slug),
  )
  expect(slugs).toEqual(['alpha', 'beta'])
})
