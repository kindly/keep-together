import { beforeEach, describe, expect, test } from 'vitest'
import migrationsTest from '@convex-dev/migrations/test'
import { runToCompletion } from '@convex-dev/migrations'
import type { Id } from '../_generated/dataModel'
import { api, components, internal } from '../_generated/api'
import { executeContract } from '../lib/contracts'
import { scopeWriter } from '../lib/tenancy'
import { setup, snapshot } from '../../test/fixture'
import type { Tenant } from '../../test/fixture'
import { identifierType } from './contracts'

type Fixture = Awaited<ReturnType<typeof setup>>

let f: Fixture

beforeEach(async () => {
  f = await setup()
  migrationsTest.register(f.t)
})

const createContact = (who: Tenant, lastName: string) =>
  who.as.mutation(api.contacts.mutations.create, {
    tenantId: who.tenantId,
    kind: 'individual',
    title: '',
    firstName: 'Ada',
    lastName,
    nickname: '',
    name: '',
    isDeceased: false,
  })

/** A contact as created before X1: no counter, the old field set. */
const legacyContact = async (
  who: Tenant,
  lastName: string,
  externalIdentifier?: string,
) => {
  const id = await createContact(who, lastName)
  await f.t.run((ctx) =>
    ctx.db.patch('contacts', id, {
      identifiersVersion: undefined,
      externalIdentifier,
    }),
  )
  return id
}

const backfill = (opts: { batchSize?: number; cursor?: null } = {}) =>
  f.t.run((ctx) =>
    runToCompletion(
      ctx,
      components.migrations,
      internal.contacts.migrations.backfillExternalIdentifiers,
      opts,
    ),
  )

const doc = (id: Id<'contacts'>) => f.t.run((ctx) => ctx.db.get('contacts', id))

const get = (id: Id<'contacts'>, who: Tenant = f.a) =>
  who.as.query(api.contacts.queries.get, { tenantId: who.tenantId, id })

const typesOf = (who: Tenant) =>
  f.t.run(async (ctx) =>
    (await ctx.db.query('identifierTypes').collect()).filter(
      (t) => t.tenantId === who.tenantId,
    ),
  )

const identifierRevisions = (id: Id<'contacts'>) =>
  f.t.run(async (ctx) =>
    (await ctx.db.query('revisions').collect()).filter(
      (r) => r.entityId === id && r.contract === 'contacts.identifiers',
    ),
  )

const leftovers = (who: Tenant = f.a) =>
  f.t.query(internal.contacts.migrations.legacyLeftovers, {
    tenantId: who.tenantId,
  })

describe('backfillExternalIdentifiers', () => {
  test('moves each value into an "External reference" row, in batches, per tenant', async () => {
    const a1 = await legacyContact(f.a, 'Lovelace', 'LEGACY-0001')
    const a2 = await legacyContact(f.a, 'Babbage', ' LEGACY-0002 ')
    const a3 = await legacyContact(f.a, 'Byron')
    // The same value in the other tenant is a different identifier.
    const b1 = await legacyContact(f.b, 'Herschel', 'LEGACY-0001')

    const status = await backfill({ batchSize: 1 })
    expect(status.isDone).toBe(true)

    const [typeA] = await typesOf(f.a)
    const [typeB] = await typesOf(f.b)
    expect(await typesOf(f.a)).toHaveLength(1)
    expect(typeA).toMatchObject({ name: 'External reference', isActive: true })
    expect(typeB._id).not.toBe(typeA._id)

    for (const [id, who, value, type] of [
      [a1, f.a, 'LEGACY-0001', typeA],
      [a2, f.a, 'LEGACY-0002', typeA],
      [b1, f.b, 'LEGACY-0001', typeB],
    ] as const) {
      const contact = await doc(id)
      expect(contact?.externalIdentifier).toBeUndefined()
      expect(contact?.identifiersVersion).toBe(1)
      expect((await get(id, who))?.identifiers).toMatchObject([
        { typeId: type._id, value, typeName: 'External reference' },
      ])
      const revisions = await identifierRevisions(id)
      expect(revisions).toMatchObject([
        { source: 'system', counter: 1, version: 1 },
      ])
      expect(
        await f.t.query(internal.contacts.queries.findByIdentifier, {
          tenantId: who.tenantId,
          typeId: type._id,
          value: value.toLowerCase(),
        }),
      ).toMatchObject({ _id: id })
    }
    expect(await doc(a3)).toMatchObject({ identifiersVersion: 0 })
    expect(await doc(a3)).not.toHaveProperty('externalIdentifier')
    expect(await identifierRevisions(a3)).toEqual([])
    expect(await leftovers(f.a)).toEqual([])
    expect(await leftovers(f.b)).toEqual([])
  })

  test('a tenant with no values gets no type; blank values are just dropped', async () => {
    await legacyContact(f.a, 'Lovelace', 'LEGACY-0001')
    const b1 = await legacyContact(f.b, 'Herschel')
    const b2 = await legacyContact(f.b, 'Somerville', '')
    const b3 = await legacyContact(f.b, 'Fry', '   ')
    await backfill()
    expect(await typesOf(f.a)).toHaveLength(1)
    expect(await typesOf(f.b)).toEqual([])
    for (const id of [b1, b2, b3]) {
      expect(await doc(id)).toMatchObject({ identifiersVersion: 0 })
      expect(await doc(id)).not.toHaveProperty('externalIdentifier')
    }
  })

  test('leaves contacts created after X1 alone', async () => {
    const id = await createContact(f.a, 'Lovelace')
    const before = await snapshot(f.t, f.a.tenantId)
    await backfill()
    expect(await snapshot(f.t, f.a.tenantId)).toBe(before)
    expect(await doc(id)).toMatchObject({ identifiersVersion: 0 })
  })

  test('a clash: the older contact keeps the value, the other keeps its old field for review', async () => {
    const older = await legacyContact(f.a, 'Lovelace', 'LEGACY-0001')
    const newer = await legacyContact(f.a, 'Babbage', 'legacy-0001 ')
    const other = await legacyContact(f.b, 'Herschel', 'LEGACY-0001')

    const status = await backfill()
    expect(status.isDone).toBe(true)
    expect((await get(older))?.identifiers).toMatchObject([
      { value: 'LEGACY-0001' },
    ])
    // Counter set (X3 can make it required), value kept, nothing else.
    expect(await doc(newer)).toMatchObject({
      identifiersVersion: 0,
      externalIdentifier: 'legacy-0001 ',
    })
    expect(await identifierRevisions(newer)).toEqual([])
    expect(await leftovers(f.a)).toEqual([
      {
        contactId: newer,
        displayName: 'Ada Babbage',
        externalIdentifier: 'legacy-0001 ',
      },
    ])
    expect(await leftovers(f.b)).toEqual([])
    expect((await get(other, f.b))?.identifiers).toHaveLength(1)

    // A rerun retries it: still held, so nothing changes …
    const before = await snapshot(f.t, f.a.tenantId)
    await backfill({ cursor: null })
    expect(await snapshot(f.t, f.a.tenantId)).toBe(before)

    // … until the older contact's row is removed; then it moves.
    await f.a.as.mutation(api.contacts.mutations.saveForm, {
      tenantId: f.a.tenantId,
      id: older,
      identifiers: { expected: 1, identifiers: [] },
    })
    await backfill({ cursor: null })
    expect(await doc(newer)).not.toHaveProperty('externalIdentifier')
    expect((await get(newer))?.identifiers).toMatchObject([
      { value: 'legacy-0001' },
    ])
    expect(await leftovers(f.a)).toEqual([])
  })

  test('keeps rows a contact already has and uses the counter it has', async () => {
    const id = await legacyContact(f.a, 'Lovelace', 'LEGACY-0001')
    await backfill()
    // As if the old field came back after the contact gained rows.
    await f.t.run((ctx) =>
      ctx.db.patch('contacts', id, { externalIdentifier: 'LEGACY-0009' }),
    )
    await backfill({ cursor: null })
    expect((await get(id))?.identifiers.map((r) => r.value)).toEqual([
      'LEGACY-0001',
      'LEGACY-0009',
    ])
    expect(await doc(id)).toMatchObject({ identifiersVersion: 2 })
    expect(await doc(id)).not.toHaveProperty('externalIdentifier')
  })

  test('an archived "External reference" type leaves the value in place', async () => {
    const { id: typeId } = await f.t.run((ctx) =>
      executeContract(
        { db: scopeWriter(ctx, f.a.tenantId), userId: null },
        identifierType,
        { name: 'external reference', isActive: false },
        { source: 'test' },
      ),
    )
    const id = await legacyContact(f.a, 'Lovelace', 'LEGACY-0001')
    const b1 = await legacyContact(f.b, 'Herschel', 'LEGACY-0001')
    await backfill()
    expect(await doc(id)).toMatchObject({
      identifiersVersion: 0,
      externalIdentifier: 'LEGACY-0001',
    })
    expect(await typesOf(f.a)).toMatchObject([{ _id: typeId }])
    expect(await leftovers(f.a)).toHaveLength(1)
    expect((await get(b1, f.b))?.identifiers).toHaveLength(1)
  })

  test('a rerun from the start changes nothing', async () => {
    await legacyContact(f.a, 'Lovelace', 'LEGACY-0001')
    await legacyContact(f.a, 'Byron')
    await legacyContact(f.b, 'Herschel', 'LEGACY-0002')
    await backfill()
    const a = await snapshot(f.t, f.a.tenantId)
    const b = await snapshot(f.t, f.b.tenantId)
    const status = await backfill({ cursor: null })
    expect(status.isDone).toBe(true)
    expect(await snapshot(f.t, f.a.tenantId)).toBe(a)
    expect(await snapshot(f.t, f.b.tenantId)).toBe(b)
  })
})
