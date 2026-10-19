/**
 * The manual-test instances' world (dev/demo and dev/preview, seeded by
 * scripts/test-instances.mjs): one tenant, one password user per
 * membership role, and 100 varied donors from ./testSeedData. Internal,
 * and only on deployments with `TEST_SEED_ENABLED=1` (it creates admins
 * with passwords the operator chose).
 *
 * Idempotent: users, tenant and memberships are ensured, and donors are
 * created in batches that skip themselves when already there, so a rerun
 * leaves existing data alone. A changed password is applied to the
 * existing account. Reset is the script's job (an empty snapshot import).
 *
 *   npx convex run platform/testSeed:users
 *   npx convex run platform/testSeed:seed '{"passwords":{"admin":"…","staff":"…","viewer":"…"}}'
 */
import {
  createAccount,
  modifyAccountCredentials,
} from '@convex-dev/auth/server'
import { ConvexError, v } from 'convex/values'
import { internal } from '../_generated/api'
import type { Id } from '../_generated/dataModel'
import {
  env,
  internalAction,
  internalMutation,
  internalQuery,
} from '../_generated/server'
import { commandGroup, executeContract } from '../lib/contracts'
import { scopeWriter } from '../lib/tenancy'
import type { Role } from '../lib/tenancy'
import {
  addresses,
  archive,
  details,
  identifiers,
  methods,
  note,
  noteFlags,
  relationship,
  relationshipType,
} from '../contacts/contracts'
import {
  ensureIdentifierTypes,
  seedTags,
  UK_RELATIONSHIP_TYPES,
} from '../contacts/seed'
import schema from '../schema'
import {
  DONOR_COUNT,
  generateDonors,
  IDENTIFIER_TYPES,
  SOURCE_DETAILS,
} from './testSeedData'
import { insertTenant, tenantForSlug } from './tenants'
import { ensureSeedCategories, seedDetails } from '../sources/seed'

const role = schema.tables.memberships.validator.fields.role

/**
 * One sign-in per membership role. `satisfies` makes a new role a type
 * error here until it gets its line.
 */
export const TEST_USERS = {
  admin: { email: 'admin@keep-together.example', name: 'Olu Adeyemi' },
  staff: { email: 'staff@keep-together.example', name: 'Sam Kowalski' },
  viewer: { email: 'viewer@keep-together.example', name: 'Vic Okafor' },
} satisfies Record<Role, { email: string; name: string }>

export const TEST_TENANT = {
  slug: 'riverside',
  name: 'Riverside Community Trust',
}

const BATCH = 10

function requireEnabled() {
  if (env.TEST_SEED_ENABLED !== '1') {
    throw new ConvexError({
      kind: 'disabled' as const,
      message:
        'testSeed is disabled on this deployment: set the env var TEST_SEED_ENABLED=1 to allow it',
    })
  }
}

const roles = () => Object.keys(TEST_USERS) as Array<Role>

/** The users the seed creates, so the script can mint their passwords. */
export const users = internalQuery({
  args: {},
  handler: () => {
    requireEnabled()
    return roles().map((r) => ({ role: r, email: TEST_USERS[r].email }))
  },
})

export const seed = internalAction({
  args: { passwords: v.record(v.string(), v.string()) },
  handler: async (
    ctx,
    { passwords },
  ): Promise<{
    slug: string
    tenantId: Id<'tenants'>
    users: Array<{ role: Role; email: string }>
    donorsCreated: number
  }> => {
    requireEnabled()
    const missing = roles().filter((r) => !passwords[r])
    if (missing.length) {
      throw new ConvexError({ kind: 'missing_password' as const, missing })
    }
    const members: Array<{ role: Role; userId: Id<'users'> }> = []
    for (const r of roles()) {
      const { email, name } = TEST_USERS[r]
      const account = {
        provider: 'password',
        account: { id: email, secret: passwords[r] },
      }
      let userId: Id<'users'>
      try {
        // createAccount doesn't copy the account id into the profile.
        ;({
          user: { _id: userId },
        } = await createAccount(ctx, { ...account, profile: { email, name } }))
      } catch (err) {
        // The account exists with another password: the operator's file
        // is the source of truth.
        if (!/already exists/.test(String(err))) throw err
        await modifyAccountCredentials(ctx, account)
        ;({
          user: { _id: userId },
        } = await createAccount(ctx, { ...account, profile: { email, name } }))
      }
      members.push({ role: r, userId })
    }
    const admin = members.find((m) => m.role === 'admin')!.userId
    const tenantId: Id<'tenants'> = await ctx.runMutation(
      internal.platform.testSeed.tenant,
      { members },
    )
    let donorsCreated = 0
    for (let from = 0; from < DONOR_COUNT; from += BATCH) {
      donorsCreated += await ctx.runMutation(
        internal.platform.testSeed.donors,
        {
          tenantId,
          actor: admin,
          from,
          to: Math.min(from + BATCH, DONOR_COUNT),
        },
      )
    }
    return {
      slug: TEST_TENANT.slug,
      tenantId,
      users: members.map(({ role: r }) => ({
        role: r,
        email: TEST_USERS[r].email,
      })),
      donorsCreated,
    }
  },
})

/** The tenant, each user's membership at its role, and reference data. */
export const tenant = internalMutation({
  args: {
    members: v.array(v.object({ role, userId: v.id('users') })),
  },
  handler: async (ctx, { members }) => {
    requireEnabled()
    const admin = members.find((m) => m.role === 'admin')
    if (!admin) throw new Error('test seed: no admin among the members')
    const existing = await tenantForSlug(ctx, TEST_TENANT.slug)
    const tenantId =
      existing?._id ??
      (await insertTenant(ctx, { ...TEST_TENANT, adminUserId: admin.userId }))
    for (const { role: r, userId } of members) {
      const membership = await ctx.db
        .query('memberships')
        .withIndex('by_tenant_user', (q) =>
          q.eq('tenantId', tenantId).eq('userId', userId),
        )
        .unique()
      if (!membership) {
        await ctx.db.insert('memberships', { tenantId, userId, role: r })
      } else if (membership.role !== r) {
        await ctx.db.patch('memberships', membership._id, { role: r })
      }
    }
    // Seeded inline so the donors can link at once; the jobs insertTenant
    // schedules then find the types, tags and source codes and do nothing.
    const scoped = { db: scopeWriter(ctx, tenantId), userId: null, role: null }
    const types = await scoped.db
      .query('relationshipTypes')
      .withIndex('by_tenant')
      .first()
    if (!types) {
      const group = await commandGroup(scoped, 'test seed: reference data')
      for (const [labelAB, labelBA, kindA, kindB] of UK_RELATIONSHIP_TYPES) {
        await executeContract(
          scoped,
          relationshipType,
          { labelAB, labelBA, kindA, kindB, isActive: true },
          { source: 'seed', group },
        )
      }
    }
    await seedTags(scoped)
    await ensureSeedCategories(scoped)
    await seedDetails(scoped, SOURCE_DETAILS)
    await ensureIdentifierTypes(scoped, IDENTIFIER_TYPES)
    return tenantId
  },
})

/**
 * Donors [from, to), with their notes and every relationship whose later
 * end is in the batch. A batch commits whole, so its first donor existing
 * means the batch is done. Returns the number of donors created.
 */
export const donors = internalMutation({
  args: {
    tenantId: v.id('tenants'),
    actor: v.id('users'),
    from: v.number(),
    to: v.number(),
  },
  handler: async (ctx, { tenantId, actor, from, to }) => {
    requireEnabled()
    const { donors: specs, relationships } = generateDonors()
    const scoped = { db: scopeWriter(ctx, tenantId), userId: actor, role: null }
    const idOf = async (i: number) => {
      const row = await scoped.db
        .query('contacts')
        .withIndex('by_tenant_clientKey', (q) =>
          q.eq('clientKey', specs[i].clientKey),
        )
        .unique()
      return row?._id ?? null
    }
    if (await idOf(from)) return 0

    const group = await commandGroup(
      scoped,
      `test seed: donors ${from}–${to - 1}`,
    )
    const ids = new Map<number, Id<'contacts'>>()
    const opts = { source: 'seed', group } as const
    // The tenant mutation made them; this only looks them up. A type an
    // admin has archived since (say "External reference", which the X2
    // backfill made on older instances) stays archived and its rows are
    // skipped: the contract adds rows of active types only.
    const identifierTypes = new Map<string, Id<'identifierTypes'>>()
    for (const [name, typeId] of await ensureIdentifierTypes(
      scoped,
      IDENTIFIER_TYPES,
    )) {
      if ((await scoped.db.get(typeId))?.isActive)
        identifierTypes.set(name, typeId)
    }
    for (let i = from; i < to; i++) {
      const spec = specs[i]
      const { id } = await executeContract(
        scoped,
        details,
        { ...spec.details, clientKey: spec.clientKey },
        opts,
      )
      ids.set(i, id)
      await executeContract(scoped, methods, spec.methods, {
        ...opts,
        entityId: id,
        expected: 0,
      })
      await executeContract(scoped, addresses, spec.addresses, {
        ...opts,
        entityId: id,
        expected: 0,
      })
      const rows = spec.identifiers.flatMap(({ key, type, value }) => {
        const typeId = identifierTypes.get(type)
        return typeId ? [{ key, typeId, value }] : []
      })
      if (rows.length) {
        await executeContract(
          scoped,
          identifiers,
          { identifiers: rows },
          { ...opts, entityId: id, expected: 0 },
        )
      }
      if (spec.archived) {
        await executeContract(
          scoped,
          archive,
          { archived: true },
          { ...opts, entityId: id, expected: 0 },
        )
      }
      for (const n of spec.notes) {
        const { id: noteId } = await executeContract(
          scoped,
          note,
          { body: n.body },
          { ...opts, createWith: { contactId: id } },
        )
        if (n.pinned || n.archived) {
          await executeContract(
            scoped,
            noteFlags,
            { pinned: n.pinned, archived: n.archived },
            { ...opts, entityId: noteId, expected: 0 },
          )
        }
      }
    }

    const typeIds = new Map<string, Id<'relationshipTypes'>>()
    for (const t of await scoped.db
      .query('relationshipTypes')
      .withIndex('by_tenant')
      .collect()) {
      typeIds.set(t.labelAB, t._id)
    }
    for (const rel of relationships) {
      const last = Math.max(rel.a, rel.b)
      if (last < from || last >= to) continue
      const [contactA, contactB] = await Promise.all(
        [rel.a, rel.b].map(async (i) => ids.get(i) ?? (await idOf(i))),
      )
      const typeId = typeIds.get(rel.type)
      if (!contactA || !contactB || !typeId) {
        throw new Error(`test seed: cannot link donors ${rel.a} and ${rel.b}`)
      }
      await executeContract(
        scoped,
        relationship,
        {
          contactA,
          contactB,
          typeId,
          startDate: rel.startDate,
          isActive: true,
          description: rel.description,
        },
        opts,
      )
    }
    return to - from
  },
})
