import { convexTest } from 'convex-test'
import { describe, expect, test, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import schema from '../schema'
import { contactContracts } from '../contacts/contracts'
import { fieldContracts } from '../contacts/fields'
import { commsContracts } from '../comms/contracts'
import { sourceContracts } from '../sources/code'
import { givingContracts } from '../giving/contracts'
import {
  canonical,
  defineContract,
  missingUpcasterSteps,
  restoreEntityTo,
  upcast,
} from './contracts'
import { scopeWriter } from './tenancy'
import type { ScopedDatabaseWriter } from './tenancy'
import { errorData, modules, setup, snapshot } from '../../test/fixture'

const individual = {
  kind: 'individual' as const,
  title: '',
  firstName: 'Ada',
  lastName: 'Lovelace',
  nickname: '',
  name: '',
  isDeceased: false,
}

describe('command layer', () => {
  test('create saves entity and revision', async () => {
    const f = await setup()
    const id = await f.a.as.mutation(api.contacts.mutations.create, {
      tenantId: f.a.tenantId,
      ...individual,
    })
    const revisions = await f.t.run((ctx) =>
      ctx.db
        .query('revisions')
        .withIndex('by_tenant_entity', (q) =>
          q
            .eq('tenantId', f.a.tenantId)
            .eq('entity', 'contacts')
            .eq('entityId', id),
        )
        .collect(),
    )
    expect(revisions).toHaveLength(1)
    expect(revisions[0]).toMatchObject({
      contract: 'contacts.details',
      version: 2,
      counter: 0,
      source: 'ui',
      actor: f.a.userId,
    })
    expect(revisions[0].group).toBeUndefined()
    expect(revisions[0].payload.lastName).toBe('Lovelace')
  })

  test('update bumps only its counter and records it on the revision', async () => {
    const f = await setup()
    const id = await f.a.as.mutation(api.contacts.mutations.create, {
      tenantId: f.a.tenantId,
      ...individual,
    })
    const result = await f.a.as.mutation(api.contacts.mutations.saveDetails, {
      tenantId: f.a.tenantId,
      id,
      expected: 0,
      ...individual,
      nickname: 'Countess',
    })
    expect(result.counter).toBe(1)
    const contact = (await f.t.run((ctx) => ctx.db.get(id)))!
    expect(contact).toMatchObject({
      detailsVersion: 1,
      methodsVersion: 0,
      addressesVersion: 0,
      archiveVersion: 0,
    })
  })

  test('restore is a new command, not a rewind', async () => {
    const f = await setup()
    const id = await f.a.as.mutation(api.contacts.mutations.create, {
      tenantId: f.a.tenantId,
      ...individual,
    })
    await f.a.as.mutation(api.contacts.mutations.saveDetails, {
      tenantId: f.a.tenantId,
      id,
      expected: 0,
      ...individual,
      nickname: 'Countess',
    })
    const first = (await f.t.run((ctx) =>
      ctx.db
        .query('revisions')
        .withIndex('by_tenant_entity', (q) =>
          q
            .eq('tenantId', f.a.tenantId)
            .eq('entity', 'contacts')
            .eq('entityId', id),
        )
        .order('asc')
        .first(),
    ))!
    const result = await f.a.as.mutation(
      api.contacts.mutations.restoreRevision,
      { tenantId: f.a.tenantId, revisionId: first._id },
    )
    expect(result.counter).toBe(2)
    const contact = (await f.t.run((ctx) => ctx.db.get(id)))!
    expect(contact.nickname).toBe('')
    const latest = (await f.t.run((ctx) =>
      ctx.db
        .query('revisions')
        .withIndex('by_tenant_entity', (q) =>
          q
            .eq('tenantId', f.a.tenantId)
            .eq('entity', 'contacts')
            .eq('entityId', id),
        )
        .order('desc')
        .first(),
    ))!
    expect(latest).toMatchObject({
      source: 'restore',
      restoredFrom: first._id,
      counter: 2,
    })
  })

  test('revision newer than the running code is rejected', async () => {
    const f = await setup()
    const id = await f.a.as.mutation(api.contacts.mutations.create, {
      tenantId: f.a.tenantId,
      ...individual,
    })
    const rev = (await f.t.run((ctx) =>
      ctx.db
        .query('revisions')
        .withIndex('by_tenant_entity', (q) =>
          q
            .eq('tenantId', f.a.tenantId)
            .eq('entity', 'contacts')
            .eq('entityId', id),
        )
        .first(),
    ))!
    await f.t.run((ctx) => ctx.db.patch('revisions', rev._id, { version: 99 }))
    const data = await errorData(
      f.a.as.mutation(api.contacts.mutations.restoreRevision, {
        tenantId: f.a.tenantId,
        revisionId: rev._id,
      }),
    )
    expect(data.kind).toBe('newer_than_code')
  })

  test('a version bump with no upcaster blocks restore of old revisions', async () => {
    const f = await setup()
    const id = await f.a.as.mutation(api.contacts.mutations.create, {
      tenantId: f.a.tenantId,
      ...individual,
    })
    const rev = (await f.t.run((ctx) =>
      ctx.db
        .query('revisions')
        .withIndex('by_tenant_entity', (q) =>
          q
            .eq('tenantId', f.a.tenantId)
            .eq('entity', 'contacts')
            .eq('entityId', id),
        )
        .first(),
    ))!
    // Pretend the stored revision predates the code by one version.
    await f.t.run((ctx) => ctx.db.patch('revisions', rev._id, { version: 0 }))
    const data = await errorData(
      f.a.as.mutation(api.contacts.mutations.restoreRevision, {
        tenantId: f.a.tenantId,
        revisionId: rev._id,
      }),
    )
    expect(data).toMatchObject({
      kind: 'missing_upcaster',
      contract: 'contacts.details',
      from: 0,
    })
  })
})

// ── restore reads ──────────────────────────────────────────────────────────

/** Wraps a scoped db so every document a query or `get` returns is counted. */
function counting(db: ScopedDatabaseWriter) {
  const reads = { count: 0 }
  const docs = (result: unknown) => {
    if (Array.isArray(result)) reads.count += result.length
    else if (result !== null && result !== undefined) reads.count += 1
    return result
  }
  const wrapQuery = (q: object): object =>
    new Proxy(q, {
      get(target, prop) {
        const value: unknown = Reflect.get(target, prop, target)
        if (typeof value !== 'function') return value
        if (prop === Symbol.asyncIterator) {
          return async function* () {
            for await (const d of target as AsyncIterable<unknown>) {
              reads.count += 1
              yield d
            }
          }
        }
        if (prop === 'order' || prop === 'filter') {
          return (...args: Array<unknown>) =>
            wrapQuery(value.apply(target, args) as object)
        }
        if (['first', 'unique', 'collect', 'take'].includes(String(prop))) {
          return async (...args: Array<unknown>) =>
            docs(await value.apply(target, args))
        }
        if (prop === 'paginate') {
          return async (...args: Array<unknown>) => {
            const r = (await value.apply(target, args)) as { page: unknown }
            docs(r.page)
            return r
          }
        }
        return value.bind(target)
      },
    })
  const wrapped: ScopedDatabaseWriter = {
    ...db,
    get: async (...args: Array<unknown>) =>
      docs(await (db.get as any)(...args)) as never,
    query: ((table: never) => {
      const init = db.query(table)
      return {
        withIndex: (index: never, range?: never) =>
          wrapQuery(init.withIndex(index, range)),
        withSearchIndex: (index: never, filter: never) =>
          wrapQuery(init.withSearchIndex(index, filter)),
      }
    }) as ScopedDatabaseWriter['query'],
  }
  return { db: wrapped, reads }
}

describe('restore to a moment', () => {
  const email = (address: string) => ({
    label: 'home' as const,
    address,
    isPrimary: false,
  })
  const address = (line1: string) => ({
    label: 'home' as const,
    line1,
    line2: '',
    line3: '',
    town: 'Stroud',
    postcode: 'GL5 1AA',
    country: 'GB',
    isPrimary: false,
  })

  /**
   * A contact with one moment worth returning to, then `edits` more saves
   * of each of details, methods, addresses and archive. Returns the
   * documents the restore read.
   */
  async function restoreAfter(edits: number) {
    const f = await setup()
    const as = f.a.as
    const tenantId = f.a.tenantId
    const id = await as.mutation(api.contacts.mutations.create, {
      tenantId,
      ...individual,
    })
    await as.mutation(api.contacts.mutations.saveMethods, {
      tenantId,
      id,
      expected: 0,
      emails: [email('ada@example.com')],
      phones: [],
    })
    await as.mutation(api.contacts.mutations.saveAddresses, {
      tenantId,
      id,
      expected: 0,
      addresses: [address('1 High St')],
    })
    const moment = await f.t.run(async (ctx) => {
      const latest = await ctx.db
        .query('revisions')
        .withIndex('by_tenant_entity', (q) =>
          q
            .eq('tenantId', tenantId)
            .eq('entity', 'contacts')
            .eq('entityId', id),
        )
        .order('desc')
        .first()
      return latest!._creationTime
    })
    for (let i = 1; i <= edits; i++) {
      await as.mutation(api.contacts.mutations.saveDetails, {
        tenantId,
        id,
        expected: i - 1,
        ...individual,
        nickname: `n${i}`,
      })
      await as.mutation(api.contacts.mutations.saveMethods, {
        tenantId,
        id,
        expected: i,
        emails: [email(`ada${i}@example.com`)],
        phones: [],
      })
      await as.mutation(api.contacts.mutations.saveAddresses, {
        tenantId,
        id,
        expected: i,
        addresses: [address(`${i} High St`)],
      })
      await as.mutation(api.contacts.mutations.setArchived, {
        tenantId,
        id,
        expected: i - 1,
        archived: i % 2 === 1,
      })
    }
    const before = await snapshot(f.t, f.b.tenantId)
    const run = await f.t.run(async (ctx) => {
      const { db, reads } = counting(scopeWriter(ctx, tenantId))
      const result = await restoreEntityTo(
        { db, userId: f.a.userId, role: null },
        contactContracts,
        'contacts',
        id,
        moment,
        { exclude: ['contacts.archive'] },
      )
      return { result, reads: reads.count }
    })
    expect(await snapshot(f.t, f.b.tenantId)).toBe(before)
    const contact = await as.query(api.contacts.queries.get, {
      tenantId,
      id,
    })
    return { ...run, contact }
  }

  test('reads a bounded number of documents however long the history', async () => {
    const short = await restoreAfter(2)
    const long = await restoreAfter(30)
    for (const run of [short, long]) {
      expect(run.result.restored.sort()).toEqual([
        'contacts.addresses',
        'contacts.details',
        'contacts.methods',
      ])
      expect(run.contact?.contact.nickname).toBe('')
      expect(run.contact?.emails.map((e) => e.address)).toEqual([
        'ada@example.com',
      ])
      expect(run.contact?.addresses.map((a) => a.line1)).toEqual(['1 High St'])
    }
    // 123 revisions on the long contact; reading them all took 131 documents.
    expect(long.reads).toBe(short.reads)
    expect(long.reads).toBeLessThan(40)
  })

  test('a slice first written after the moment is left as it is', async () => {
    const f = await setup()
    const tenantId = f.a.tenantId
    const id = await f.a.as.mutation(api.contacts.mutations.create, {
      tenantId,
      ...individual,
    })
    const moment = await f.t.run(async (ctx) => {
      const created = await ctx.db
        .query('revisions')
        .withIndex('by_tenant_entity', (q) =>
          q
            .eq('tenantId', tenantId)
            .eq('entity', 'contacts')
            .eq('entityId', id),
        )
        .first()
      return created!._creationTime
    })
    const [tag, other] = await f.a.as.query(api.contacts.queries.tags, {
      tenantId,
    })
    await f.a.as.mutation(api.contacts.mutations.saveTags, {
      tenantId,
      id,
      expected: 0,
      tags: [{ tagId: tag._id }],
    })
    await f.a.as.mutation(api.contacts.mutations.saveTags, {
      tenantId,
      id,
      expected: 1,
      tags: [{ tagId: tag._id }, { tagId: other._id }],
    })
    await f.a.as.mutation(api.contacts.mutations.saveDetails, {
      tenantId,
      id,
      expected: 0,
      ...individual,
      nickname: 'Countess',
    })
    const result = await f.a.as.mutation(api.contacts.mutations.restoreTo, {
      tenantId,
      id,
      at: moment,
    })
    expect(result.restored).toEqual(['contacts.details'])
    const got = await f.a.as.query(api.contacts.queries.get, { tenantId, id })
    expect(got?.contact.nickname).toBe('')
    expect(got?.contact.tagsVersion).toBe(2)
    expect(got?.tags.map((t) => t.tagId).sort()).toEqual(
      [tag._id, other._id].sort(),
    )
  })

  test('a changed slice of an unregistered contract is refused', async () => {
    const f = await setup()
    const tenantId = f.a.tenantId
    const id = await f.a.as.mutation(api.contacts.mutations.create, {
      tenantId,
      ...individual,
    })
    const legacy = (payload: unknown) =>
      f.t.run(async (ctx) => {
        const revisionId = await ctx.db.insert('revisions', {
          tenantId,
          entity: 'contacts',
          entityId: id,
          contract: 'contacts.legacy',
          version: 1,
          counter: 0,
          payload,
          source: 'ui',
        })
        return (await ctx.db.get(revisionId))!._creationTime
      })
    const moment = await legacy({ note: 'before' })
    await legacy({ note: 'after' })
    const before = await snapshot(f.t, tenantId)
    expect(
      await errorData(
        f.a.as.mutation(api.contacts.mutations.restoreTo, {
          tenantId,
          id,
          at: moment,
        }),
      ),
    ).toEqual({ kind: 'unknown_contract', contract: 'contacts.legacy' })
    expect(await snapshot(f.t, tenantId)).toBe(before)
  })
})

describe('upcasters (pure)', () => {
  const contract = defineContract({
    name: 'test.thing',
    entity: 'contacts',
    version: 3,
    counter: 'detailsVersion',
    fields: {},
    apply: async () => {
      throw new Error('unused')
    },
    upcasters: {
      1: (p) => ({ ...(p as object), fromOne: true }),
      2: (p) => ({ ...(p as object), fromTwo: true }),
    },
  })

  test('chain runs in order and stops at the code version', () => {
    expect(upcast(contract, { a: 1 }, 1)).toEqual({
      a: 1,
      fromOne: true,
      fromTwo: true,
    })
    expect(upcast(contract, { a: 1 }, 2)).toEqual({ a: 1, fromTwo: true })
    expect(upcast(contract, { a: 1 }, 3)).toEqual({ a: 1 })
  })

  test('missing steps are listed statically', () => {
    expect(missingUpcasterSteps(contract, 0)).toEqual([0])
    expect(missingUpcasterSteps(contract, 1)).toEqual([])
  })
})

describe('registry invariants (meta-test)', () => {
  test('every contract has its own numeric counter field on its root table', () => {
    const seen = new Map<string, Set<string>>()
    for (const c of [
      ...Object.values(contactContracts),
      ...Object.values(commsContracts),
      ...Object.values(sourceContracts),
      ...Object.values(fieldContracts),
      ...Object.values(givingContracts),
    ]) {
      const table = (
        schema.tables as Record<
          string,
          { validator: { fields?: Record<string, { kind: string }> } }
        >
      )[c.entity]
      expect(table, `${c.name}: unknown entity ${c.entity}`).toBeDefined()
      const field = table.validator.fields?.[c.counter]
      expect(
        field?.kind,
        `${c.name}: counter ${c.counter} must be v.number()`,
      ).toBe('float64')
      const counters = seen.get(c.entity) ?? new Set<string>()
      expect(
        counters.has(c.counter),
        `${c.name} reuses counter ${c.counter}`,
      ).toBe(false)
      counters.add(c.counter)
      seen.set(c.entity, counters)
    }
  })

  // A version bump without its upcaster would otherwise surface only when
  // someone restores an old revision. Every registry restore uses goes
  // in REGISTRIES.
  const REGISTRIES = {
    contactContracts,
    commsContracts,
    sourceContracts,
    fieldContracts,
    givingContracts,
  }
  test.each(
    Object.entries(REGISTRIES).flatMap(([registryName, reg]) =>
      Object.values(reg).map((c) => [registryName, c.name, c] as const),
    ),
  )('%s: %s upcasts from version 1 to its current version', (_r, _n, c) => {
    expect(c.version).toBeGreaterThanOrEqual(1)
    expect(missingUpcasterSteps(c, 1)).toEqual([])
  })
})

describe('canonical', () => {
  test('is order-independent for keys and keyed rows', () => {
    expect(
      canonical({
        b: 1,
        a: [
          { key: 'z', v: 1 },
          { key: 'a', v: 2 },
        ],
      }),
    ).toBe(
      canonical({
        a: [
          { key: 'a', v: 2 },
          { key: 'z', v: 1 },
        ],
        b: 1,
      }),
    )
    expect(canonical({ a: undefined, b: 1 })).toBe(canonical({ b: 1 }))
  })
  test('writes an int64 as Convex JSON, so stored and sent payloads agree', () => {
    expect(canonical({ amount: 2000n })).toBe(
      '{"amount":{"$integer":"0AcAAAAAAAA="}}',
    )
    expect(canonical({ amount: 5n })).not.toBe(canonical({ amount: 5 }))
    expect(canonical({ amount: 5n })).not.toBe(canonical({ amount: '5n' }))
    expect(
      canonical([
        { key: 'b', amount: -1n },
        { key: 'a', amount: 0n },
      ]),
    ).toBe(
      canonical([
        { key: 'a', amount: 0n },
        { key: 'b', amount: -1n },
      ]),
    )
  })

  /** `canonical` before int64 support: its output must not change. */
  function canonicalBeforeInt64(payload: unknown): string {
    const sortDeep = (value: unknown): unknown => {
      if (Array.isArray(value)) {
        const items = value.map(sortDeep)
        if (
          items.length > 0 &&
          items.every(
            (i): i is { key: unknown } =>
              typeof i === 'object' && i !== null && 'key' in i,
          )
        ) {
          return [...items].sort((a, b) =>
            String(a.key).localeCompare(String(b.key)),
          )
        }
        return items
      }
      if (typeof value === 'object' && value !== null) {
        const out: Record<string, unknown> = {}
        for (const k of Object.keys(value).sort()) {
          const item = (value as Record<string, unknown>)[k]
          if (item !== undefined) out[k] = sortDeep(item)
        }
        return out
      }
      return value
    }
    return JSON.stringify(sortDeep(payload))
  }

  const hasBigint = (value: unknown): boolean =>
    typeof value === 'bigint' ||
    (typeof value === 'object' &&
      value !== null &&
      Object.values(value).some(hasBigint))

  test('is byte-identical to before for payloads without int64s', () => {
    const samples: Array<unknown> = [
      null,
      'x',
      0,
      -0,
      1.5,
      true,
      [],
      {},
      [1, 'a', null],
      { b: [{ key: 'é' }, { key: 'e' }, { key: 'E' }], a: { z: 1, y: [] } },
      { rows: [{ key: 'k', v: undefined }, { notKey: 1 }] },
      { emails: [{ label: 'home', address: 'a@b.c', isPrimary: true }] },
    ]
    for (const p of samples) expect(canonical(p)).toBe(canonicalBeforeInt64(p))
  })

  test('is byte-identical to before for every seeded revision', async () => {
    vi.stubEnv('QC_SEED_ENABLED', '1')
    try {
      const t = convexTest(schema, modules)
      await t.action(internal.platform.qcSeed.fixture, {
        runId: '1',
        worker: 1,
        password: 'qc-password-123',
      })
      await t.finishAllScheduledFunctions(() => {})
      const revisions = await t.run((ctx) =>
        ctx.db.query('revisions').collect(),
      )
      const plain = revisions.filter((r) => !hasBigint(r.payload))
      // The seed writes contacts, lists and source codes: many contracts.
      expect(new Set(plain.map((r) => r.contract)).size).toBeGreaterThan(3)
      for (const r of plain) {
        expect(canonical(r.payload)).toBe(canonicalBeforeInt64(r.payload))
      }
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
