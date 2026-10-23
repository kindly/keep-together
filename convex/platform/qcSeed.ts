/**
 * The QC suite's seeded world (factory/plans/qc-suite.sv, step 3): per run
 * and per Playwright worker, two tenants and four users who can sign in
 * with a password: user A admin of tenant A only, user B admin of tenant B
 * only, plus a staff and a viewer member of tenant A. Contact names are
 * distinctive so the isolation spec can look for leaks.
 *
 * Identifiers (external-ids X5): A's Ada holds `shared` under the active
 * type "Membership number". In B the same type
 * name holds `shared` on B's Ada, `bOnly` on B's Charles and `bReuse` on
 * B's Trust, then is archived: B has no active type (the form hides the
 * section there), A's search can prove B's values don't leak, and A can
 * add `bReuse` without a clash (then removes it again).
 * Internal: run from the QC harness via the CLI, and only on deployments
 * with `QC_SEED_ENABLED=1` (it creates admins with a known password).
 * Re-running with the same run, worker and password returns the same world.
 *
 *   npx convex run --deployment <d> platform/qcSeed:fixture \
 *     '{"runId":"12","worker":0,"password":"qc-password-123"}'
 *
 * Fields (dropdown fields, step 6): A has one active field, "Volunteer
 * status" (Active / Lapsed / Prospect, for every kind), carried by no
 * contact; B has none. Its other four slots are the specs' to use, and
 * each spec frees what it takes.
 *
 * `hold` puts an address on hold in one tenant, as a bounce would: specs
 * call it per sample, since an admin's release lifts it again. `crowd`
 * adds many individuals to one tenant at once, for the paged list.
 */
import { createAccount } from '@convex-dev/auth/server'
import { ConvexError, v } from 'convex/values'
import { internal } from '../_generated/api'
import type { Id } from '../_generated/dataModel'
import { env, internalAction, internalMutation } from '../_generated/server'
import { commandGroup, executeContract } from '../lib/contracts'
import { scopeWriter } from '../lib/tenancy'
import {
  acquisition,
  details,
  identifiers,
  identifierType,
  methods,
  relationshipType,
} from '../contacts/contracts'
import { ensureIdentifierTypes, UK_RELATIONSHIP_TYPES } from '../contacts/seed'
import { field, fieldOption } from '../contacts/fields'
import { BULK_FIELD_LIMIT } from '../contacts/rules'
import { suppressAddress } from '../comms/suppressions'
import { insertTenant, tenantForSlug } from './tenants'
import { ensureSeedCategories, seedDetails } from '../sources/seed'

const SIDES = [
  { suffix: 'a', label: 'Alpha' },
  { suffix: 'b', label: 'Bravo' },
] as const

/** Tenant A's members besides its admin, user A. */
const MEMBERS = ['staff', 'viewer'] as const

export const IDENTIFIER_TYPE = 'Membership number'

const prefix = (runId: string, worker: number) => `r${runId}w${worker}`

/**
 * The seeded identifier values. One token each, with no name in it, so the
 * full-text name search never matches them; and none a prefix of another,
 * since the search matches its last word as a prefix (search Q2).
 */
export const qcIdentifiers = (runId: string, worker: number) => {
  const base = prefix(runId, worker)
  return { shared: `ID${base}`, bOnly: `IDB${base}`, bReuse: `IDR${base}` }
}

/**
 * The detail under Event each side gets, with versions 001 and 002, which
 * no seeded contact carries: specs that set codes use it, so the Street
 * filter's answer stays put.
 */
export const QC_EVENT_DETAIL = 'Gala'

/** Tenant A's seeded dropdown field and its options, in order. */
export const QC_FIELD = {
  label: 'Volunteer status',
  options: ['Active', 'Lapsed', 'Prospect'],
} as const

/**
 * The detail each side's Street category gets (names carry no hyphen),
 * with versions 001 and 002: Charles carries 001 and the Trust 002.
 */
export const qcSourceDetail = (label: string, runId: string) =>
  `${label}${runId}`

function requireEnabled() {
  if (env.QC_SEED_ENABLED !== '1') {
    throw new ConvexError({
      kind: 'disabled' as const,
      message:
        'qcSeed is disabled on this deployment: set the env var QC_SEED_ENABLED=1 to allow it',
    })
  }
}

export const fixture = internalAction({
  args: { runId: v.string(), worker: v.number(), password: v.string() },
  handler: async (
    ctx,
    { runId, worker, password },
  ): Promise<{
    /** a, b, then tenant A's staff and viewer. */
    users: Array<{ email: string; role: 'admin' | 'staff' | 'viewer' }>
    tenants: Array<{
      slug: string
      tenantId: Id<'tenants'>
      contactIds: Array<Id<'contacts'>>
    }>
    identifierType: string
    identifiers: ReturnType<typeof qcIdentifiers>
    field: typeof QC_FIELD
  }> => {
    requireEnabled()
    const base = prefix(runId, worker)
    const accounts = [
      ...SIDES.map(({ suffix }) => ({ suffix, role: 'admin' as const })),
      ...MEMBERS.map((role) => ({ suffix: `a-${role}`, role })),
    ]
    const users = []
    for (const { suffix, role } of accounts) {
      // createAccount doesn't copy the account id into the profile.
      const email = `qc-${base}-${suffix}@example.com`
      const { user } = await createAccount(ctx, {
        provider: 'password',
        account: { id: email, secret: password },
        profile: { email, name: `${base}-${suffix} qc user` },
      })
      users.push({ email, role, userId: user._id })
    }
    const tenants = await ctx.runMutation(internal.platform.qcSeed.world, {
      runId,
      worker,
      userIds: users.map((u) => u.userId),
    })
    return {
      users: users.map(({ email, role }) => ({ email, role })),
      tenants,
      identifierType: IDENTIFIER_TYPE,
      identifiers: qcIdentifiers(runId, worker),
      field: QC_FIELD,
    }
  },
})

/**
 * Tenants, memberships, reference data and contacts for `fixture`'s users:
 * `userIds` is [a, b, ...MEMBERS of tenant A].
 */
export const world = internalMutation({
  args: {
    runId: v.string(),
    worker: v.number(),
    userIds: v.array(v.id('users')),
  },
  handler: async (ctx, { runId, worker, userIds }) => {
    requireEnabled()
    const base = prefix(runId, worker)
    const out = []
    for (const [i, { suffix, label }] of SIDES.entries()) {
      const userId = userIds[i]
      const slug = `${base}-${suffix}`
      const existing = await tenantForSlug(ctx, slug)
      if (existing) {
        // A re-run: the same run and worker yield the same user, who owns it.
        const own = await ctx.db
          .query('memberships')
          .withIndex('by_tenant_user', (q) =>
            q.eq('tenantId', existing._id).eq('userId', userId),
          )
          .unique()
        if (!own) throw new ConvexError({ kind: 'taken' as const, slug })
        const contacts = await ctx.db
          .query('contacts')
          .withIndex('by_tenant_sort', (q) => q.eq('tenantId', existing._id))
          .collect()
        // In creation order, as a first run returns them: specs take
        // contactIds[0] to be Ada.
        out.push({
          slug,
          tenantId: existing._id,
          contactIds: contacts
            .sort((x, y) => x._creationTime - y._creationTime)
            .map((c) => c._id),
        })
        continue
      }
      const tenantId = await insertTenant(ctx, {
        slug,
        name: `${label} ${base} qc group`,
        adminUserId: userId,
      })
      if (suffix === 'a') {
        for (const [j, role] of MEMBERS.entries()) {
          await ctx.db.insert('memberships', {
            tenantId,
            userId: userIds[SIDES.length + j],
            role,
          })
        }
      }
      // Seeded inline so the world is complete on return; the jobs
      // insertTenant schedules then find the types and source codes
      // and do nothing.

      const scoped = { db: scopeWriter(ctx, tenantId), userId, role: null }
      const group = await commandGroup(scoped, 'qc seed')
      for (const [labelAB, labelBA, kindA, kindB] of UK_RELATIONSHIP_TYPES) {
        await executeContract(
          scoped,
          relationshipType,
          { labelAB, labelBA, kindA, kindB, isActive: true },
          { source: 'seed', group },
        )
      }
      await ensureSeedCategories(scoped, group)
      // One detail per side, named for it: the isolation spec looks for
      // B's in A's Source codes tab.
      const twoVersions = [{ name: '001' }, { name: '002' }]
      await seedDetails(
        scoped,
        [
          {
            category: 'Street',
            name: qcSourceDetail(label, runId),
            versions: twoVersions,
          },
          { category: 'Event', name: QC_EVENT_DETAIL, versions: twoVersions },
        ],
        group,
      )
      const name = `${label}-${runId}`
      const contacts = [
        { kind: 'individual', firstName: 'Ada', lastName: name, name: '' },
        { kind: 'individual', firstName: 'Charles', lastName: name, name: '' },
        {
          kind: 'organization',
          firstName: '',
          lastName: '',
          name: `${name} Trust`,
        },
      ] as const
      const contactIds = []
      for (const c of contacts) {
        const { id } = await executeContract(
          scoped,
          details,
          {
            ...c,
            title: '',
            nickname: '',
            isDeceased: false,
          },
          { source: 'seed', group },
        )
        const local = (c.firstName || c.name).toLowerCase().replace(/\W+/g, '')
        await executeContract(
          scoped,
          methods,
          {
            emails: [
              {
                label: 'home',
                address: `${local}-${slug}@example.com`,
                isPrimary: true,
              },
            ],
            phones: [],
          },
          { entityId: id, expected: 0, source: 'seed', group },
        )
        contactIds.push(id)
      }

      const { shared, bOnly, bReuse } = qcIdentifiers(runId, worker)
      const typeId = (
        await ensureIdentifierTypes(scoped, [IDENTIFIER_TYPE], group)
      ).get(IDENTIFIER_TYPE)!
      const held: Array<[Id<'contacts'>, string]> =
        suffix === 'a'
          ? [[contactIds[0], shared]]
          : [
              [contactIds[0], shared],
              [contactIds[1], bOnly],
              [contactIds[2], bReuse],
            ]
      for (const [contactId, value] of held) {
        await executeContract(
          scoped,
          identifiers,
          { identifiers: [{ typeId, value }] },
          { entityId: contactId, expected: 0, source: 'seed', group },
        )
      }
      if (suffix === 'a') {
        const { id: fieldId } = await executeContract(
          scoped,
          field,
          {
            label: QC_FIELD.label,
            appliesTo: ['individual', 'organization', 'household'],
            isActive: true,
          },
          { source: 'seed', group },
        )
        for (const [position, optionLabel] of QC_FIELD.options.entries()) {
          await executeContract(
            scoped,
            fieldOption,
            { label: optionLabel, position, isActive: true },
            { source: 'seed', group, createWith: { fieldId } },
          )
        }
      } else {
        await executeContract(
          scoped,
          identifierType,
          { name: IDENTIFIER_TYPE, isActive: false },
          { entityId: typeId, expected: 0, source: 'seed', group },
        )
      }
      // Charles on Street-<side>-001, the Trust on -002.
      const part = async (parentId: Id<'sourceCodes'> | undefined, n: string) =>
        (await scoped.db
          .query('sourceCodes')
          .withIndex('by_tenant_parent', (q) =>
            q.eq('parentId', parentId).eq('nameNormalized', n.toLowerCase()),
          )
          .unique())!._id
      const street = await part(
        await part(undefined, 'Street'),
        qcSourceDetail(label, runId),
      )
      const coded: Array<[Id<'contacts'>, string]> = [
        [contactIds[1], '001'],
        [contactIds[2], '002'],
      ]
      for (const [contactId, version] of coded) {
        await executeContract(
          scoped,
          acquisition,
          { codeId: await part(street, version) },
          { entityId: contactId, expected: 0, source: 'seed', group },
        )
      }
      out.push({ slug, tenantId, contactIds })
    }
    return out
  },
})

/**
 * Hold `address` in a tenant, as the SES webhook does after a hard bounce
 * (comms `suppressAddress`, with no user and role null: a seed is a
 * trusted caller). A no-op if it is already held.
 */
export const hold = internalMutation({
  args: { tenantId: v.id('tenants'), address: v.string() },
  handler: async (ctx, { tenantId, address }) => {
    requireEnabled()
    if (!(await ctx.db.get('tenants', tenantId))) {
      throw new ConvexError({ kind: 'not_found' as const })
    }
    return suppressAddress(
      { db: scopeWriter(ctx, tenantId), userId: null, role: null },
      { address, note: 'qc seed' },
    )
  },
})

/**
 * Contacts `crowdBatch` writes per transaction: what every bulk write here
 * commits at once (bulk set field, retire), so pages
 * subscribed meanwhile re-run as they would under a real one.
 */
const CROWD_BATCH = BULK_FIELD_LIMIT

/**
 * Add `count` individuals to a tenant, named `<lastName>, <first>`
 * with `first` numbered `n0001`, `n0002`, …: the paged list's specs put
 * them where they need them in the sort order. Each goes through the
 * details contract, as a create in the UI would.
 */
export const crowd = internalAction({
  args: {
    tenantId: v.id('tenants'),
    lastName: v.string(),
    count: v.number(),
  },
  handler: async (ctx, { tenantId, lastName, count }): Promise<number> => {
    requireEnabled()
    for (let from = 0; from < count; from += CROWD_BATCH) {
      await ctx.runMutation(internal.platform.qcSeed.crowdBatch, {
        tenantId,
        lastName,
        from,
        count: Math.min(CROWD_BATCH, count - from),
      })
    }
    return count
  },
})

export const crowdBatch = internalMutation({
  args: {
    tenantId: v.id('tenants'),
    lastName: v.string(),
    from: v.number(),
    count: v.number(),
  },
  handler: async (ctx, { tenantId, lastName, from, count }) => {
    requireEnabled()
    if (!(await ctx.db.get('tenants', tenantId))) {
      throw new ConvexError({ kind: 'not_found' as const })
    }
    const scoped = { db: scopeWriter(ctx, tenantId), userId: null, role: null }
    const group = await commandGroup(scoped, 'qc crowd')
    for (let i = from; i < from + count; i++) {
      await executeContract(
        scoped,
        details,
        {
          kind: 'individual',
          firstName: `n${String(i + 1).padStart(4, '0')}`,
          lastName,
          name: '',
          title: '',
          nickname: '',
          isDeceased: false,
        },
        { source: 'seed', group },
      )
    }
  },
})
