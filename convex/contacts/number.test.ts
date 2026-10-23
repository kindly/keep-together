import { beforeEach, describe, expect, test } from 'vitest'
import { ConvexError } from 'convex/values'
import type { Id } from '../_generated/dataModel'
import { api } from '../_generated/api'
import { errorData, setup, snapshot } from '../../test/fixture'
import type { Tenant } from '../../test/fixture'
import { executeContract } from '../lib/contracts'
import { scopeWriter } from '../lib/tenancy'
import { details } from './contracts'
import {
  FIRST_NUMBER,
  allocateNumbers,
  checkDigit,
  formatNumber,
  parseNumber,
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
 * An import-style batch: a details create per row, all in one mutation.
 * A row whose clientKey is already there is skipped, as an import would.
 */
const batch = (who: Tenant, rows: Array<[string, string?]>) =>
  f.t.run(async (ctx) => {
    const scoped = {
      db: scopeWriter(ctx, who.tenantId),
      userId: who.userId,
      role: null,
    }
    const ids = []
    for (const [name, clientKey] of rows) {
      try {
        const { id } = await executeContract(
          scoped,
          details,
          person(name, clientKey),
          { source: 'import' },
        )
        ids.push(id)
      } catch (e) {
        if (!(e instanceof ConvexError) || e.data.reason !== 'duplicate') {
          throw e
        }
      }
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

  test('a batch numbers its rows in creation order', async () => {
    await create(f.a, 'Ada')
    const ids = await batch(f.a, [['Charles'], ['Mary'], ['Grace']])
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

  test('a batch that skips a duplicate leaves no gap', async () => {
    await create(f.a, 'Ada', 'ck-1')
    const ids = await batch(f.a, [
      ['Charles', 'ck-2'],
      ['Ada again', 'ck-1'],
      ['Mary', 'ck-3'],
    ])
    expect(await Promise.all(ids.map(numberOf))).toEqual([
      FIRST_NUMBER + 1,
      FIRST_NUMBER + 2,
    ])
    expect(await numberOf(await create(f.a, 'Grace'))).toBe(FIRST_NUMBER + 3)
  })

  test('the backfill block (allocateNumbers) is skipped by creates', async () => {
    await create(f.a, 'Ada')
    const first = await f.t.run((ctx) =>
      allocateNumbers(scopeWriter(ctx, f.a.tenantId), 5),
    )
    expect(first).toBe(FIRST_NUMBER + 1)
    expect(await numberOf(await create(f.a, 'Charles'))).toBe(FIRST_NUMBER + 6)
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

  test('neither the payload nor a create argument carries the number', async () => {
    await expect(
      f.a.as.mutation(api.contacts.mutations.create, {
        tenantId: f.a.tenantId,
        ...person('Ada'),
        number: 99999,
      } as never),
    ).rejects.toThrow()
    await expect(
      f.t.run((ctx) =>
        executeContract(
          {
            db: scopeWriter(ctx, f.a.tenantId),
            userId: f.a.userId,
            role: null,
          },
          details,
          person('Ada'),
          { source: 'import', createWith: { number: 99999 } },
        ),
      ),
    ).rejects.toThrow(/createWith/)
    const ada = await create(f.a, 'Ada')
    expect(await numberOf(ada)).toBe(FIRST_NUMBER)
    const revisions = await f.t.run((ctx) =>
      ctx.db.query('revisions').collect(),
    )
    const created = revisions.find((r) => r.entityId === ada)!
    expect(created.payload).not.toHaveProperty('number')
  })

  // No "the sequence travels with the tenant" test: no per-tenant export
  // exists yet, and the whole-deployment snapshot import carries every
  // table. That test belongs with the export, when one is built.
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

describe('reading a typed number (parseNumber)', () => {
  test('the written number and the bare sequence both read as the sequence', () => {
    for (const typed of [
      '100016',
      '10001',
      ' 100 016 ',
      '10-00-16',
      '1000 1',
    ]) {
      expect(parseNumber(typed), typed).toEqual({ sequence: FIRST_NUMBER })
    }
    for (let seq = FIRST_NUMBER; seq < FIRST_NUMBER + 500; seq++) {
      expect(parseNumber(formatNumber(seq))).toEqual({ sequence: seq })
    }
  })

  test('a wrong check digit is flagged with the hint', () => {
    expect(parseNumber('100018')).toEqual({
      invalid: true,
      hint: '100018 isn’t a valid contact number. Check the last digit.',
    })
    expect(parseNumber('100 01-8')).toMatchObject({ invalid: true })
  })

  test('anything else is not a number: no prefix, no phone, no words', () => {
    for (const typed of [
      '',
      '1000',
      '1001',
      '1000163',
      '07700900123',
      '+44100016',
      '100016a',
      'ada',
      // Below the first number: never issued, so neither found nor flagged.
      '10000',
      '012345',
      '000000',
    ]) {
      expect(parseNumber(typed), typed).toBeNull()
    }
  })
})
