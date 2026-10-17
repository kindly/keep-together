import { describe, expect, test } from 'vitest'
import { api } from '../_generated/api'
import schema from '../schema'
import { contactContracts } from '../contacts/contracts'
import {
  canonical,
  defineContract,
  missingUpcasterSteps,
  upcast,
} from './contracts'
import { errorData, setup } from '../../test/fixture'

const individual = {
  kind: 'individual' as const,
  title: '',
  firstName: 'Ada',
  lastName: 'Lovelace',
  nickname: '',
  name: '',
  isDeceased: false,
  externalIdentifier: '',
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
      version: 1,
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
    for (const c of Object.values(contactContracts)) {
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
})
