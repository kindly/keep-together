import { beforeEach, describe, expect, test } from 'vitest'
import type { Id } from '../_generated/dataModel'
import { api } from '../_generated/api'
import { errorData, setup, snapshot } from '../../test/fixture'
import type { Tenant } from '../../test/fixture'
import { executeContract } from '../lib/contracts'
import { scopeWriter } from '../lib/tenancy'
import { DOMAIN_TABLES } from '../lib/tables'
import { details } from './contracts'
import {
  FIRST_NUMBER,
  allocateNumbers,
  checkDigit,
  formatNumber,
} from './number'

type Fixture = Awaited<ReturnType<typeof setup>>

const person = (firstName: string, clientKey?: string) => ({
  kind: 'individual' as const,
  title: '',
  firstName,
  lastName: 'Lovelace',
  nickname: '',
  name: '',
  isDeceased: false,
  clientKey,
})

let f: Fixture

beforeEach(async () => {
  f = await setup()
})

const create = (who: Tenant, firstName: string, clientKey?: string) =>
  who.as.mutation(api.contacts.mutations.create, {
    tenantId: who.tenantId,
    ...person(firstName, clientKey),
  })

/** Every contact of the tenant as [number, _creationTime], oldest first. */
const numbered = (who: Tenant) =>
  f.t.run(async (ctx) =>
    (await ctx.db.query('contacts').collect())
      .filter((c) => c.tenantId === who.tenantId)
      .map((c) => [c.number, c._creationTime] as const),
  )

const numberOf = (id: Id<'contacts'>) =>
  f.t.run(async (ctx) => (await ctx.db.get(id))?.number)

/**
 * An import-style batch: one block of numbers, then a details create per
 * row with its number from the block, all in one mutation.
 */
const batch = (who: Tenant, names: Array<string>) =>
  f.t.run(async (ctx) => {
    const scoped = {
      db: scopeWriter(ctx, who.tenantId),
      userId: who.userId,
      role: null,
    }
    const first = await allocateNumbers(scoped.db, names.length)
    const ids = []
    for (const [i, name] of names.entries()) {
      const { id } = await executeContract(scoped, details, person(name), {
        source: 'import',
        createWith: { number: first + i },
      })
      ids.push(id)
    }
    return ids
  })

describe('allocation', () => {
  test('creates take consecutive numbers: higher is newer', async () => {
    const ids = [
      await create(f.a, 'Ada'),
      await create(f.a, 'Charles'),
      await create(f.a, 'Mary'),
    ]
    expect(await Promise.all(ids.map(numberOf))).toEqual([
      FIRST_NUMBER,
      FIRST_NUMBER + 1,
      FIRST_NUMBER + 2,
    ])
  })

  test('each tenant starts at the first number, unseen by the other', async () => {
    const bBefore = await snapshot(f.t, f.b.tenantId)
    await create(f.a, 'Ada')
    await create(f.a, 'Charles')
    expect(await snapshot(f.t, f.b.tenantId)).toBe(bBefore)

    const inB = await create(f.b, 'Grace')
    expect(await numberOf(inB)).toBe(FIRST_NUMBER)
    const sequences = await f.t.run((ctx) =>
      ctx.db.query('contactNumberSequences').collect(),
    )
    expect(
      sequences
        .sort((x, y) => x.next - y.next)
        .map((s) => [s.tenantId, s.next]),
    ).toEqual([
      [f.b.tenantId, FIRST_NUMBER + 1],
      [f.a.tenantId, FIRST_NUMBER + 2],
    ])
  })

  test('a batch takes one block, numbered in creation order', async () => {
    await create(f.a, 'Ada')
    const ids = await batch(f.a, ['Charles', 'Mary', 'Grace'])
    const after = await create(f.a, 'Alan')
    expect(await Promise.all(ids.map(numberOf))).toEqual([
      FIRST_NUMBER + 1,
      FIRST_NUMBER + 2,
      FIRST_NUMBER + 3,
    ])
    expect(await numberOf(after)).toBe(FIRST_NUMBER + 4)
    // The invariant over the whole tenant: number order is creation order.
    const rows = await numbered(f.a)
    const byTime = [...rows].sort((x, y) => x[1] - y[1]).map(([n]) => n)
    expect(byTime).toEqual([...byTime].sort((x, y) => x! - y!))
    expect(new Set(byTime).size).toBe(rows.length)
  })

  test('a duplicate clientKey is rejected without taking a number', async () => {
    const ada = await create(f.a, 'Ada', 'ck-1')
    expect(await errorData(create(f.a, 'Ada', 'ck-1'))).toMatchObject({
      reason: 'duplicate',
    })
    const next = await create(f.a, 'Charles')
    expect(await numberOf(ada)).toBe(FIRST_NUMBER)
    expect(await numberOf(next)).toBe(FIRST_NUMBER + 1)
  })

  test('the payload never carries the number', async () => {
    await expect(
      f.a.as.mutation(api.contacts.mutations.create, {
        tenantId: f.a.tenantId,
        ...person('Ada'),
        number: 99999,
      } as never),
    ).rejects.toThrow()
    const ada = await create(f.a, 'Ada')
    const revisions = await f.t.run((ctx) =>
      ctx.db.query('revisions').collect(),
    )
    const created = revisions.find((r) => r.entityId === ada)!
    expect(created.payload).not.toHaveProperty('number')
  })

  test('the sequence travels with the tenant (a domain table)', () => {
    expect(DOMAIN_TABLES).toContain('contactNumberSequences')
  })
})

describe('the number never changes', () => {
  let ada: Id<'contacts'>
  beforeEach(async () => {
    ada = await create(f.a, 'Ada')
    await create(f.a, 'Charles')
  })

  test('details saves, form saves, archive and restores keep it', async () => {
    const tenantId = f.a.tenantId
    const first = await f.t.run(
      async (ctx) =>
        (await ctx.db.query('revisions').collect()).find(
          (r) => r.entityId === ada,
        )!._creationTime,
    )
    await f.a.as.mutation(api.contacts.mutations.saveDetails, {
      tenantId,
      id: ada,
      expected: 0,
      ...person('Augusta'),
    })
    await f.a.as.mutation(api.contacts.mutations.saveForm, {
      tenantId,
      id: ada,
      details: { expected: 1, ...person('Augusta Ada') },
      methods: {
        expected: 0,
        emails: [],
        phones: [{ label: 'home', number: '01234 567890', isPrimary: true }],
      },
    })
    expect(await numberOf(ada)).toBe(FIRST_NUMBER)
    for (const archived of [true, false]) {
      const { archiveVersion } = (await f.t.run((ctx) => ctx.db.get(ada)))!
      await f.a.as.mutation(api.contacts.mutations.setArchived, {
        tenantId,
        id: ada,
        expected: archiveVersion,
        archived,
      })
      expect(await numberOf(ada)).toBe(FIRST_NUMBER)
    }
    // Back to the first revision: the create's own payload.
    const restored = await f.a.as.mutation(api.contacts.mutations.restoreTo, {
      tenantId,
      id: ada,
      at: first,
    })
    expect(restored.restored).toContain('contacts.details')
    const revisions = await f.t.run((ctx) =>
      ctx.db.query('revisions').collect(),
    )
    const detailsRevision = revisions.find(
      (r) => r.entityId === ada && r.contract === 'contacts.details',
    )!
    await f.a.as.mutation(api.contacts.mutations.restoreRevision, {
      tenantId,
      revisionId: detailsRevision._id,
    })
    expect(await numberOf(ada)).toBe(FIRST_NUMBER)
    // And nothing took a number on the way.
    expect(await numberOf(await create(f.a, 'Mary'))).toBe(FIRST_NUMBER + 2)
  })
})

describe('the row shapes carry it', () => {
  test('the contact view and the list row', async () => {
    const ada = await create(f.a, 'Ada')
    const view = await f.a.as.query(api.contacts.queries.get, {
      tenantId: f.a.tenantId,
      id: ada,
    })
    expect(view!.contact.number).toBe(FIRST_NUMBER)
    const list = await f.a.as.query(api.contacts.queries.list, {
      tenantId: f.a.tenantId,
      paginationOpts: { numItems: 10, cursor: null },
    })
    expect(list.page.map((r) => r.number)).toEqual([FIRST_NUMBER])
  })

  test('an unnumbered contact (before the backfill) lists as null', async () => {
    const ada = await create(f.a, 'Ada')
    await f.t.run((ctx) => ctx.db.patch('contacts', ada, { number: undefined }))
    const list = await f.a.as.query(api.contacts.queries.list, {
      tenantId: f.a.tenantId,
      paginationOpts: { numItems: 10, cursor: null },
    })
    expect(list.page.map((r) => r.number)).toEqual([null])
  })
})

describe('check digit (Luhn)', () => {
  /** Whether a written number's last digit is its sequence's check digit. */
  const valid = (written: string) =>
    checkDigit(Number(written.slice(0, -1))) === Number(written.at(-1))

  test('known Luhn values', () => {
    // The textbook example: 7992739871 + 3.
    expect(checkDigit(7992739871)).toBe(3)
    expect(formatNumber(FIRST_NUMBER)).toBe('100016')
    expect(formatNumber(10002)).toBe('100024')
    expect(formatNumber(99999)).toBe('999995')
  })

  test('every single wrong digit is caught', () => {
    for (let seq = FIRST_NUMBER; seq < FIRST_NUMBER + 2000; seq++) {
      const written = formatNumber(seq)
      expect(valid(written)).toBe(true)
      for (let i = 0; i < written.length; i++) {
        for (let d = 0; d <= 9; d++) {
          if (String(d) === written[i]) continue
          const typo = written.slice(0, i) + d + written.slice(i + 1)
          if (valid(typo)) throw new Error(`${typo} passes for ${written}`)
        }
      }
    }
  })

  test('every neighbouring swap is caught but 09↔90', () => {
    let missed = 0
    for (let seq = FIRST_NUMBER; seq < FIRST_NUMBER + 2000; seq++) {
      const written = formatNumber(seq)
      for (let i = 0; i + 1 < written.length; i++) {
        const [x, y] = [written[i], written[i + 1]]
        if (x === y) continue
        const swapped = written.slice(0, i) + y + x + written.slice(i + 2)
        if (!valid(swapped)) continue
        expect([x + y, y + x].sort()).toEqual(['09', '90'])
        missed++
      }
    }
    expect(missed).toBeGreaterThan(0) // the exception is real, not untested
  })
})
