/**
 * Source codes (plan: factory/plans/source-codes.sv, step 2): the
 * `sources.code` contract, the used marker and delete, archive hiding, the
 * picker, the list-management switch and the seeds. Two tenants throughout.
 */
import { describe, expect, test } from 'vitest'
import migrationsTest from '@convex-dev/migrations/test'
import { runToCompletion } from '@convex-dev/migrations'
import type { TestConvex } from 'convex-test'
import { api, components, internal } from '../_generated/api'
import type { Id } from '../_generated/dataModel'
import type schema from '../schema'
import type { MutationCtx } from '../_generated/server'
import { executeContract, restore } from '../lib/contracts'
import { scopeWriter } from '../lib/tenancy'
import type { Role } from '../lib/tenancy'
import { errorData, setup, snapshot } from '../../test/fixture'
import type { Tenant } from '../../test/fixture'
import {
  code,
  describe as describeCode,
  markUsed,
  sourceContracts,
} from './code'
import { SEED_CATEGORIES, codeMatches, dateStatus, pickerOrder } from './rules'

type T = TestConvex<typeof schema>
type CodeId = Id<'sourceCodes'>

const TODAY = '2026-10-19'

const tree = (who: Tenant) =>
  who.as.query(api.sources.queries.tree, { tenantId: who.tenantId })

const picker = (who: Tenant, search?: string, today = TODAY) =>
  who.as.query(api.sources.queries.picker, {
    tenantId: who.tenantId,
    today,
    search,
  })

const create = (
  who: Tenant,
  name: string,
  parentId?: CodeId,
  extra: { startDate?: string; endDate?: string; description?: string } = {},
) =>
  who.as.mutation(api.sources.mutations.create, {
    tenantId: who.tenantId,
    parentId,
    name,
    isActive: true,
    ...extra,
  })

async function part(who: Tenant, id: CodeId) {
  return (await tree(who)).find((p) => p._id === id)!
}

/** Save a part with some fields changed, at its current counter. */
async function save(
  who: Tenant,
  id: CodeId,
  change: Partial<{
    name: string
    description: string
    startDate: string
    endDate: string
    isActive: boolean
  }>,
) {
  const p = await part(who, id)
  return who.as.mutation(api.sources.mutations.save, {
    tenantId: who.tenantId,
    id,
    expected: p.saveVersion,
    name: p.name,
    description: p.description,
    startDate: p.startDate,
    endDate: p.endDate,
    isActive: p.isActive,
    ...change,
  })
}

async function remove(who: Tenant, id: CodeId) {
  const p = await part(who, id)
  return who.as.mutation(api.sources.mutations.remove, {
    tenantId: who.tenantId,
    id,
    expected: p.saveVersion,
  })
}

const category = async (who: Tenant, name: string) =>
  (await tree(who)).find((p) => p.level === 'category' && p.name === name)!._id

/** Street → Wesser (→ 001), the plan's example. */
async function street(who: Tenant) {
  const categoryId = await category(who, 'Street')
  const { id: detailId, versionId } = await create(who, 'Wesser', categoryId)
  return { categoryId, detailId, versionId: versionId! }
}

const scoped = (ctx: MutationCtx, tenantId: Id<'tenants'>) => ({
  db: scopeWriter(ctx, tenantId),
  userId: null,
  role: null,
})

const mark = (t: T, who: Tenant, id: CodeId, allowArchived?: boolean) =>
  t.run((ctx) => markUsed(scoped(ctx, who.tenantId), id, { allowArchived }))

/** A user holding `role` in the tenant, as a caller. */
async function member(t: T, who: Tenant, role: Role) {
  const userId = await t.run(async (ctx) => {
    const id = await ctx.db.insert('users', { email: `${role}@example.com` })
    await ctx.db.insert('memberships', {
      tenantId: who.tenantId,
      userId: id,
      role,
    })
    return id
  })
  return { ...who, as: t.withIdentity({ subject: `${userId}|s-${role}` }) }
}

// ── pure rules ─────────────────────────────────────────────────────────────

describe('rules', () => {
  test('date status: dates guide, inclusive at both ends', () => {
    expect(dateStatus({}, TODAY)).toBe('current')
    expect(dateStatus({ startDate: TODAY, endDate: TODAY }, TODAY)).toBe(
      'current',
    )
    expect(dateStatus({ startDate: '2026-10-20' }, TODAY)).toBe('notStarted')
    expect(dateStatus({ endDate: '2026-10-18' }, TODAY)).toBe('ended')
  })

  test('picker order: in date, not started, ended; by code in each', () => {
    const rows = [
      { status: 'ended' as const, code: 'A-a-1' },
      { status: 'current' as const, code: 'b-a-1' },
      { status: 'notStarted' as const, code: 'A-a-1' },
      { status: 'current' as const, code: 'A-b-1' },
    ]
    expect(rows.sort(pickerOrder)).toEqual([
      { status: 'current', code: 'A-b-1' },
      { status: 'current', code: 'b-a-1' },
      { status: 'notStarted', code: 'A-a-1' },
      { status: 'ended', code: 'A-a-1' },
    ])
  })

  test('a search matches anywhere in the code, any case', () => {
    expect(codeMatches('Street-Wesser-001', 'wesser')).toBe(true)
    expect(codeMatches('Street-Wesser-001', 'T-WES')).toBe(true)
    expect(codeMatches('Street-Wesser-001', '001')).toBe(true)
    expect(codeMatches('Street-Wesser-001', ' ')).toBe(true)
    expect(codeMatches('Street-Wesser-001', 'online')).toBe(false)
  })
})

// ── seeds ──────────────────────────────────────────────────────────────────

describe('seeds', () => {
  test('each tenant starts with the seven categories; a rerun adds nothing', async () => {
    const { t, a, b } = await setup()
    for (const who of [a, b]) {
      const parts = await tree(who)
      expect(parts.map((p) => [p.level, p.name]).sort()).toEqual(
        SEED_CATEGORIES.map((n) => ['category', n]).sort(),
      )
      expect(
        await t.mutation(internal.sources.seed.categories, {
          tenantId: who.tenantId,
        }),
      ).toEqual({ seeded: 0 })
      expect(await tree(who)).toEqual(parts)
    }
  })

  test('an unused seed can be deleted, and stays deleted', async () => {
    const { t, a, b } = await setup()
    const before = await snapshot(t, b.tenantId)
    await remove(a, await category(a, 'Telephone'))
    await t.mutation(internal.sources.seed.categories, {
      tenantId: a.tenantId,
    })
    expect((await tree(a)).map((p) => p.name)).not.toContain('Telephone')
    expect(await tree(a)).toHaveLength(SEED_CATEGORIES.length - 1)
    expect(await snapshot(t, b.tenantId)).toBe(before)
  })

  test('the backfill seeds existing tenants through the contract, once', async () => {
    const { t, a, b } = await setup()
    migrationsTest.register(t)
    // Tenant A predates the seed: no source codes.
    await t.run(async (ctx) => {
      for (const r of await ctx.db.query('sourceCodes').collect()) {
        if (r.tenantId === a.tenantId) await ctx.db.delete(r._id)
      }
    })
    const bBefore = await snapshot(t, b.tenantId)
    const backfill = () =>
      t.run((ctx) =>
        runToCompletion(
          ctx,
          components.migrations,
          internal.sources.migrations.seedCategories,
          { batchSize: 1, cursor: null },
        ),
      )
    await backfill()
    const seeded = await tree(a)
    expect(seeded.map((p) => p.name).sort()).toEqual(
      [...SEED_CATEGORIES].sort(),
    )
    const revisions = await t.run(async (ctx) =>
      (await ctx.db.query('revisions').collect()).filter(
        (r) => r.tenantId === a.tenantId && r.contract === 'sources.code',
      ),
    )
    // The fixture's seed of A, then the backfill's.
    expect(revisions.filter((r) => r.source === 'seed')).toHaveLength(
      SEED_CATEGORIES.length * 2,
    )
    expect(await snapshot(t, b.tenantId)).toBe(bBefore)
    await backfill()
    expect(await tree(a)).toEqual(seeded)
    expect(await snapshot(t, b.tenantId)).toBe(bBefore)
  })
})

// ── the contract ───────────────────────────────────────────────────────────

describe('sources.code', () => {
  test('a new detail comes with version 001, in one command group', async () => {
    const { t, a } = await setup()
    const { categoryId, detailId, versionId } = await street(a)
    const parts = await tree(a)
    expect(
      parts
        .filter((p) => [categoryId, detailId, versionId].includes(p._id))
        .map((p) => [p.level, p.code, p.used]),
    ).toEqual([
      ['category', 'Street', false],
      ['detail', 'Street-Wesser', false],
      ['version', 'Street-Wesser-001', false],
    ])
    const groups = await t.run(async (ctx) =>
      (await ctx.db.query('revisions').collect())
        .filter((r) => r.entityId === detailId || r.entityId === versionId)
        .map((r) => r.groupName),
    )
    expect(groups).toEqual(['create Wesser', 'create Wesser'])
    // A version added by hand is just itself.
    const { id, versionId: none } = await create(a, '002', detailId)
    expect(none).toBeUndefined()
    expect((await part(a, id)).code).toBe('Street-Wesser-002')
  })

  test('names: required, no hyphen, unique among siblings in any case', async () => {
    const { a } = await setup()
    const { categoryId, detailId } = await street(a)
    const problem = async (p: Promise<unknown>) => {
      const data = await errorData(p)
      return data.kind === 'invalid'
        ? (data.problems as Array<{ field: string }>)[0].field
        : data.reason
    }
    expect(await problem(create(a, '  ', categoryId))).toBe('name')
    expect(await problem(create(a, 'Wes-ser', categoryId))).toBe('name')
    expect(await problem(create(a, 'x'.repeat(41), categoryId))).toBe('name')
    expect(
      await problem(
        create(a, 'Long', categoryId, { description: 'x'.repeat(1001) }),
      ),
    ).toBe('description')
    const { id: wordy } = await create(a, 'Wordy', categoryId, {
      description: ` ${'x'.repeat(1000)} `,
    })
    expect((await part(a, wordy)).description).toHaveLength(1000)
    expect(await problem(create(a, ' wESSER ', categoryId))).toBe(
      'duplicate_source_name',
    )
    expect(await problem(create(a, 'street'))).toBe('duplicate_source_name')
    expect(await problem(create(a, '001', detailId))).toBe(
      'duplicate_source_name',
    )
    // The same name under another parent is fine, and so the full codes
    // stay unique.
    const online = await category(a, 'Online')
    const { versionId } = await create(a, 'Wesser', online)
    expect((await part(a, versionId!)).code).toBe('Online-Wesser-001')
    // Renaming onto a sibling's name is refused too.
    const other = await create(a, 'Fundraisers', categoryId)
    expect(await problem(save(a, other.id, { name: 'WESSER' }))).toBe(
      'duplicate_source_name',
    )
    // Inner whitespace is tidied.
    expect((await part(a, (await create(a, ' Big   Day ')).id)).name).toBe(
      'Big Day',
    )
  })

  test('levels: three deep, dates only below a category, parent of this tenant', async () => {
    const { a, b } = await setup()
    const { categoryId, versionId } = await street(a)
    expect(await errorData(create(a, 'Deeper', versionId))).toMatchObject({
      kind: 'rejected',
      reason: 'too_deep',
    })
    expect(
      await errorData(create(a, 'Dated', undefined, { startDate: TODAY })),
    ).toMatchObject({ kind: 'invalid' })
    expect(
      await errorData(save(a, categoryId, { endDate: TODAY })),
    ).toMatchObject({ kind: 'invalid' })
    expect(
      await errorData(
        create(a, 'Backwards', categoryId, {
          startDate: '2026-10-19',
          endDate: '2026-10-01',
        }),
      ),
    ).toMatchObject({ kind: 'invalid' })
    expect(
      await errorData(create(a, 'Sloppy', categoryId, { startDate: '19/10' })),
    ).toMatchObject({ kind: 'invalid' })
    // Tenant A's category, from tenant B, reads as missing.
    expect(await errorData(create(b, 'Sneaky', categoryId))).toMatchObject({
      kind: 'rejected',
      reason: 'unknown_parent',
    })
  })

  test('a rename changes every code under the part; ids and history stay', async () => {
    const { t, a } = await setup()
    const { categoryId, detailId, versionId } = await street(a)
    await save(a, categoryId, { name: 'Face to face' })
    expect((await part(a, versionId)).code).toBe('Face to face-Wesser-001')
    expect((await part(a, detailId)).saveVersion).toBe(0)
    expect(
      await t.run((ctx) =>
        describeCode(scopeWriter(ctx, a.tenantId), versionId),
      ),
    ).toMatchObject({
      code: 'Face to face-Wesser-001',
      categoryId,
      categoryName: 'Face to face',
    })
    // The old name is in history, and restoring it reads as before.
    const first = await t.run(async (ctx) =>
      (await ctx.db.query('revisions').collect()).find(
        (r) => r.entityId === categoryId && r.counter === 0,
      ),
    )
    expect(first!.payload.name).toBe('Street')
    await t.run((ctx) =>
      restore(scoped(ctx, a.tenantId), sourceContracts, first!._id),
    )
    expect((await part(a, versionId)).code).toBe('Street-Wesser-001')
  })

  test('a stale save is refused', async () => {
    const { a } = await setup()
    const { detailId } = await street(a)
    await save(a, detailId, { description: 'Agency' })
    expect(
      await errorData(
        a.as.mutation(api.sources.mutations.save, {
          tenantId: a.tenantId,
          id: detailId,
          expected: 0,
          name: 'Wesser',
          isActive: true,
        }),
      ),
    ).toMatchObject({ kind: 'stale', current: 1 })
  })
})

// ── describe and markUsed ──────────────────────────────────────────────────

describe('describe', () => {
  test('a version, its parents and its own dates; null for anything else', async () => {
    const { t, a, b } = await setup()
    const { categoryId, detailId, versionId } = await street(a)
    await save(a, versionId, { startDate: '2026-01-01', endDate: '2026-12-31' })
    const describeIn = (who: Tenant, id: CodeId) =>
      t.run((ctx) => describeCode(scopeWriter(ctx, who.tenantId), id))
    expect(await describeIn(a, versionId)).toEqual({
      code: 'Street-Wesser-001',
      versionId,
      detailId,
      categoryId,
      versionName: '001',
      detailName: 'Wesser',
      categoryName: 'Street',
      isActive: true,
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    })
    // Undated, a version shows its detail's dates, bound by bound.
    await save(a, detailId, { startDate: '2025-06-01', endDate: '2027-01-31' })
    await save(a, versionId, { startDate: '', endDate: '2026-11-30' })
    expect(await describeIn(a, versionId)).toMatchObject({
      startDate: '2025-06-01',
      endDate: '2026-11-30',
    })
    expect(await describeIn(a, detailId)).toBeNull()
    expect(await describeIn(a, categoryId)).toBeNull()
    expect(await describeIn(b, versionId)).toBeNull()
    await save(a, categoryId, { isActive: false })
    expect(await describeIn(a, versionId)).toMatchObject({ isActive: false })
    // The public query is the same.
    expect(
      await a.as.query(api.sources.queries.describe, {
        tenantId: a.tenantId,
        id: versionId,
      }),
    ).toMatchObject({ code: 'Street-Wesser-001' })
    expect(
      await b.as.query(api.sources.queries.describe, {
        tenantId: b.tenantId,
        id: versionId,
      }),
    ).toBeNull()
  })
  test('within one call, a write is seen by the next describe', async () => {
    const { t, a } = await setup()
    const { detailId, versionId } = await street(a)
    const seen = await t.run(async (ctx) => {
      const c = scoped(ctx, a.tenantId)
      const before = await describeCode(c.db, versionId)
      // Read twice: the second comes from the call's memo.
      await describeCode(c.db, versionId)
      await executeContract(
        c,
        code,
        { name: 'Wessex', isActive: false },
        { entityId: detailId, expected: 0, source: 'ui' },
      )
      const after = await describeCode(c.db, versionId)
      await markUsed(c, versionId, { allowArchived: true })
      const used = await describeCode(c.db, versionId)
      return { before, after, used, row: await c.db.get(detailId) }
    })
    expect([seen.before?.code, seen.before?.isActive]).toEqual([
      'Street-Wesser-001',
      true,
    ])
    expect([seen.after?.code, seen.after?.isActive]).toEqual([
      'Street-Wessex-001',
      false,
    ])
    expect(seen.used?.code).toBe('Street-Wessex-001')
    expect(seen.row?.used).toBe(true)
  })
})

describe('markUsed', () => {
  test('marks the version and both parents, once, and is idempotent', async () => {
    const { t, a, b } = await setup()
    const { categoryId, detailId, versionId } = await street(a)
    const sibling = await create(a, '002', detailId)
    const bBefore = await snapshot(t, b.tenantId)
    await mark(t, a, versionId)
    const used = async () =>
      Object.fromEntries((await tree(a)).map((p) => [p._id, p.used]))
    expect(await used()).toMatchObject({
      [categoryId]: true,
      [detailId]: true,
      [versionId]: true,
      [sibling.id]: false,
    })
    const after = await snapshot(t, a.tenantId)
    await mark(t, a, versionId)
    expect(await snapshot(t, a.tenantId)).toBe(after)
    // No revisions: a system-owned field.
    expect((await part(a, versionId)).saveVersion).toBe(0)
    expect(await snapshot(t, b.tenantId)).toBe(bBefore)
  })

  test('only a version of this tenant, not archived or under an archived parent; out of date is fine', async () => {
    const { t, a, b } = await setup()
    const { categoryId, detailId, versionId } = await street(a)
    const field = async (p: Promise<unknown>) => {
      const data = await errorData(p)
      expect(data.kind).toBe('invalid')
      return (data.problems as Array<{ field: string }>)[0].field
    }
    expect(await field(mark(t, a, categoryId))).toBe('sourceCode')
    expect(await field(mark(t, a, detailId))).toBe('sourceCode')
    expect(await field(mark(t, b, versionId))).toBe('sourceCode')

    await save(a, versionId, { endDate: '2020-01-01' })
    await mark(t, a, versionId)

    const { versionId: archived } = await create(a, 'Old', categoryId)
    await save(a, archived!, { isActive: false })
    expect(await field(mark(t, a, archived!))).toBe('sourceCode')
    await save(a, categoryId, { isActive: false })
    const { id: v2 } = await create(a, '002', detailId)
    expect(await field(mark(t, a, v2))).toBe('sourceCode')
    // Restore may put back a code archived since.
    await mark(t, a, v2, true)
    expect((await part(a, v2)).used).toBe(true)
  })

  test('the marker survives a save and a restore', async () => {
    const { t, a } = await setup()
    const { categoryId, versionId } = await street(a)
    await mark(t, a, versionId)
    await save(a, categoryId, { name: 'Face to face', isActive: false })
    await save(a, versionId, { description: 'First run' })
    const firstRevision = await t.run(async (ctx) =>
      (await ctx.db.query('revisions').collect()).find(
        (r) => r.entityId === versionId && r.counter === 0,
      ),
    )
    await t.run((ctx) =>
      restore(scoped(ctx, a.tenantId), sourceContracts, firstRevision!._id),
    )
    for (const id of [categoryId, versionId]) {
      expect((await part(a, id)).used).toBe(true)
    }
    expect((await part(a, versionId)).description).toBeUndefined()
  })
})

// ── delete ─────────────────────────────────────────────────────────────────

describe('remove', () => {
  test('an unused part goes with everything under it', async () => {
    const { t, a, b } = await setup()
    const { categoryId, detailId, versionId } = await street(a)
    const extra = await create(a, '002', detailId)
    const bBefore = await snapshot(t, b.tenantId)
    expect(await remove(a, extra.id)).toEqual({ deleted: 1 })
    expect(await remove(a, categoryId)).toEqual({ deleted: 3 })
    const ids = (await tree(a)).map((p) => p._id)
    for (const id of [categoryId, detailId, versionId, extra.id]) {
      expect(ids).not.toContain(id)
    }
    expect(await snapshot(t, b.tenantId)).toBe(bBefore)
  })

  test('once used, a part and its parents can only be archived', async () => {
    const { t, a } = await setup()
    const { categoryId, detailId, versionId } = await street(a)
    const unused = await create(a, '002', detailId)
    await mark(t, a, versionId)
    for (const id of [versionId, detailId, categoryId]) {
      expect(await errorData(remove(a, id))).toMatchObject({
        kind: 'rejected',
        reason: 'used',
      })
    }
    // Its unused sibling still goes.
    expect(await remove(a, unused.id)).toEqual({ deleted: 1 })
    await save(a, versionId, { isActive: false })
    expect((await part(a, versionId)).isActive).toBe(false)
  })

  test('stale, missing and other-tenant deletes are refused', async () => {
    const { a, b } = await setup()
    const { detailId } = await street(a)
    await save(a, detailId, { description: 'Agency' })
    const del = (who: Tenant, expected: number) =>
      who.as.mutation(api.sources.mutations.remove, {
        tenantId: who.tenantId,
        id: detailId,
        expected,
      })
    expect(await errorData(del(a, 0))).toMatchObject({
      kind: 'stale',
      current: 1,
    })
    expect(await errorData(del(b, 1))).toEqual({ kind: 'not_found' })
    await del(a, 1)
    expect(await errorData(del(a, 1))).toEqual({ kind: 'not_found' })
  })
})

// ── archive hiding and the picker ──────────────────────────────────────────

describe('picker', () => {
  test('archiving a parent hides its codes; reactivating restores their own state', async () => {
    const { a, b } = await setup()
    const { categoryId, detailId, versionId } = await street(a)
    const { id: v2 } = await create(a, '002', detailId)
    await save(a, v2, { isActive: false })
    const codes = async () => (await picker(a)).codes.map((c) => c.code)
    expect(await codes()).toEqual(['Street-Wesser-001'])

    await save(a, categoryId, { isActive: false })
    expect(await codes()).toEqual([])
    expect(
      (await tree(a))
        .filter((p) => [detailId, versionId, v2].includes(p._id))
        .map((p) => [p.code, p.isActive, p.visible]),
    ).toEqual([
      ['Street-Wesser', true, false],
      ['Street-Wesser-001', true, false],
      ['Street-Wesser-002', false, false],
    ])

    await save(a, categoryId, { isActive: true })
    expect(await codes()).toEqual(['Street-Wesser-001'])
    // Tenant B never sees A's codes.
    expect((await picker(b)).codes).toEqual([])
    expect((await tree(b)).map((p) => p.code)).not.toContain('Street-Wesser')
  })

  test('versions only, in date first, searched anywhere in the code', async () => {
    const { a } = await setup()
    const online = await category(a, 'Online')
    const event = await category(a, 'Event')
    // Detail dates cover its versions unless a version has its own.
    const xmas = await create(a, 'Xmas', online, {
      startDate: '2026-12-01',
      endDate: '2026-12-31',
      description: 'Christmas appeal',
    })
    const gala = await create(a, 'Gala', event, { endDate: '2026-06-30' })
    const { id: galaLate } = await create(a, 'Late', gala.id, {
      endDate: '2026-12-31',
    })
    await create(a, 'Web', online)

    const result = await picker(a)
    expect(result.codes.map((c) => [c.code, c.status, c.description])).toEqual([
      ['Event-Gala-Late', 'current', undefined],
      ['Online-Web-001', 'current', undefined],
      ['Online-Xmas-001', 'notStarted', 'Christmas appeal'],
      ['Event-Gala-001', 'ended', undefined],
    ])
    expect(result.truncated).toBe(false)
    expect(result.codes[0].versionId).toBe(galaLate)
    expect(result.codes[2]).toMatchObject({
      versionId: xmas.versionId,
      startDate: '2026-12-01',
      endDate: '2026-12-31',
    })
    expect((await picker(a, 'GALA')).codes.map((c) => c.code)).toEqual([
      'Event-Gala-Late',
      'Event-Gala-001',
    ])
    expect((await picker(a, 'line-x')).codes.map((c) => c.code)).toEqual([
      'Online-Xmas-001',
    ])
    // Another day, another order.
    expect(
      (await picker(a, 'xmas', '2026-12-10')).codes.map((c) => c.status),
    ).toEqual(['current'])
  })
})

// ── who manages ────────────────────────────────────────────────────────────

describe('list management', () => {
  test('admins always; staff only with the switch; viewers never; per tenant', async () => {
    const { t, a, b } = await setup()
    const staff = await member(t, a, 'staff')
    const viewer = await member(t, a, 'viewer')
    const { detailId } = await street(a)
    const kind = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (e: { data?: { kind?: string } }) => e.data?.kind ?? null,
      )
    const setSwitch = async (who: Tenant, on: boolean) => {
      const mine = await who.as.query(api.platform.tenants.mine, {})
      const prefs = mine.find((m) => m._id === who.tenantId)!
      await who.as.mutation(
        api.platform.preferences.setStaffCanManageSourceCodes,
        {
          tenantId: who.tenantId,
          expected: prefs.sourceCodesVersion ?? undefined,
          staffCanManageSourceCodes: on,
        },
      )
      return (await who.as.query(api.platform.tenants.mine, {})).find(
        (m) => m._id === who.tenantId,
      )!
    }

    // B's switch on opens nothing in A.
    await setSwitch(b, true)
    expect(await kind(create(staff, 'Agency', detailId))).toBe('forbidden')
    expect(await kind(save(staff, detailId, { name: 'X' }))).toBe('forbidden')
    expect(await kind(remove(staff, detailId))).toBe('forbidden')
    // The staff switch is admin-only.
    expect(
      await kind(
        staff.as.mutation(
          api.platform.preferences.setStaffCanManageSourceCodes,
          { tenantId: a.tenantId, staffCanManageSourceCodes: true },
        ),
      ),
    ).toBe('forbidden')

    const mine = await setSwitch(a, true)
    expect(mine).toMatchObject({
      staffCanManageSourceCodes: true,
      sourceCodesVersion: 0,
      canManageSourceCodes: true,
    })
    const { id: v2 } = await create(staff, '002', detailId)
    await save(staff, v2, { name: '003' })
    expect(await remove(staff, v2)).toEqual({ deleted: 1 })
    expect(await kind(create(viewer, 'Agency', detailId))).toBe('forbidden')
    expect(await kind(remove(viewer, detailId))).toBe('forbidden')
    // Viewers read.
    expect((await tree(viewer)).length).toBeGreaterThan(0)

    await setSwitch(a, false)
    expect(await kind(create(staff, '004', detailId))).toBe('forbidden')
    expect(await kind(create(a, '004', detailId))).toBeNull()
  })
})
