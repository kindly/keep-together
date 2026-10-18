import { beforeEach, describe, expect, test } from 'vitest'
import type { Id } from '../_generated/dataModel'
import { api } from '../_generated/api'
import { errorData, setup, snapshot } from '../../test/fixture'
import type { Tenant } from '../../test/fixture'
import { groupsToRead, joinMoments } from './history'
import type { Moment } from './history'
import { HISTORY_PAGE_LIMIT, SHARED_ADDRESS_LIMIT } from './queries'
import { contactWarnings } from './warnings'

type Fixture = Awaited<ReturnType<typeof setup>>

const individual = {
  kind: 'individual' as const,
  title: '',
  firstName: 'Ada',
  lastName: 'Lovelace',
  nickname: '',
  name: '',
  isDeceased: false,
}

let f: Fixture
let ada: Id<'contacts'>
let details: number

beforeEach(async () => {
  f = await setup()
  ada = await f.a.as.mutation(api.contacts.mutations.create, {
    tenantId: f.a.tenantId,
    ...individual,
  })
  details = 0
})

/** One details revision, no group. */
const rename = (nickname: string) =>
  f.a.as.mutation(api.contacts.mutations.saveDetails, {
    tenantId: f.a.tenantId,
    id: ada,
    expected: details++,
    ...individual,
    nickname,
  })

/** Two revisions (details + methods) under one "contact form save" group. */
const formSave = async (nickname: string, address: string, methods: number) =>
  f.a.as.mutation(api.contacts.mutations.saveForm, {
    tenantId: f.a.tenantId,
    id: ada,
    details: { expected: details++, ...individual, nickname },
    methods: {
      expected: methods,
      emails: [{ label: 'home', address, isPrimary: true }],
      phones: [],
    },
  })

const page = (who: Tenant, cursor: string | null, numItems = 10) =>
  who.as.query(api.contacts.queries.history, {
    tenantId: who.tenantId,
    id: ada,
    paginationOpts: { numItems, cursor },
  })

/** Every page, joined as the panel joins them. */
async function allMoments(): Promise<Array<Moment>> {
  const moments: Array<Moment> = []
  let cursor: string | null = null
  for (;;) {
    const p = await page(f.a, cursor)
    moments.push(...p.page)
    if (p.isDone) return joinMoments(moments)
    cursor = p.continueCursor
  }
}

/** Every revision of Ada, newest first, read directly. */
const revisions = () =>
  f.t.run((ctx) =>
    ctx.db
      .query('revisions')
      .withIndex('by_tenant_entity', (q) =>
        q
          .eq('tenantId', f.a.tenantId)
          .eq('entity', 'contacts')
          .eq('entityId', ada),
      )
      .order('desc')
      .collect(),
  )

describe('history pages', () => {
  test('a page holds at most HISTORY_PAGE_LIMIT revisions, newest first', async () => {
    for (let i = 0; i < 25; i++) await rename(`n${i}`)
    const first = await page(f.a, null, 1000)
    expect(first.page).toHaveLength(HISTORY_PAGE_LIMIT)
    expect(first.isDone).toBe(false)
    const all = await revisions()
    expect(first.page.map((m) => m.revisionId)).toEqual(
      all.slice(0, HISTORY_PAGE_LIMIT).map((r) => r._id),
    )
    // Paging to the end sees every revision once, in order.
    expect((await allMoments()).map((m) => m.revisionId)).toEqual(
      all.map((r) => r._id),
    )
  })

  test('a pinned first page grows with new saves; older pages leave no gap', async () => {
    for (let i = 0; i < 15; i++) await rename(`n${i}`)
    // What a live subscription does: convex-test has no query journal, so
    // pin the first page's end as the journal would.
    const first = await page(f.a, null)
    const older = await page(f.a, first.continueCursor)
    const before = [...first.page, ...older.page].map((m) => m.revisionId)
    await rename('later 1')
    await rename('later 2')
    const regrown = await f.a.as.query(api.contacts.queries.history, {
      tenantId: f.a.tenantId,
      id: ada,
      paginationOpts: {
        numItems: 10,
        cursor: null,
        endCursor: first.continueCursor,
      },
    })
    const olderAgain = await page(f.a, first.continueCursor)
    const after = [...regrown.page, ...olderAgain.page].map((m) => m.revisionId)
    expect(regrown.page).toHaveLength(first.page.length + 2)
    expect(after.slice(2)).toEqual(before)
    expect(after).toEqual((await revisions()).map((r) => r._id))
  })

  test('a re-anchored first page (a pagination id) is the newest page, nothing else', async () => {
    for (let i = 0; i < 25; i++) await rename(`n${i}`)
    const plain = await page(f.a, null)
    const anchored = await f.a.as.query(api.contacts.queries.history, {
      tenantId: f.a.tenantId,
      id: ada,
      paginationOpts: { numItems: 10, cursor: null, id: 3 },
    })
    expect(anchored).toEqual(plain)
    // Load older from it continues without a gap.
    const older = await page(f.a, anchored.continueCursor)
    expect([...anchored.page, ...older.page].map((m) => m.revisionId)).toEqual(
      (await revisions()).slice(0, 20).map((r) => r._id),
    )
  })

  test('a group cut by the page boundary joins into one moment', async () => {
    await formSave('grouped', 'a@x.com', 0)
    // Nine newer revisions: the group's newer half closes page one.
    for (let i = 0; i < 9; i++) await rename(`n${i}`)
    const first = await page(f.a, null)
    const second = await page(f.a, first.continueCursor)
    expect(first.page.at(-1)!.groupName).toBe('contact form save')
    expect(second.page[0].key).toBe(first.page.at(-1)!.key)
    const grouped = (await allMoments()).filter(
      (m) => m.groupName === 'contact form save',
    )
    expect(grouped).toHaveLength(1)
    expect(grouped[0].slices.sort()).toEqual(['details', 'methods'])
    // The joined moment is its newest revision's.
    expect(grouped[0].revisionId).toBe(first.page.at(-1)!.revisionId)
  })

  test('restore to a moment on an older page', async () => {
    await formSave('Countess', 'a@x.com', 0)
    for (let i = 0; i < 12; i++) await rename(`n${i}`)
    const old = (await allMoments()).find(
      (m) => m.groupName === 'contact form save',
    )!
    const firstIds = (await page(f.a, null)).page.map((m) => m.revisionId)
    expect(firstIds).not.toContain(old.revisionId)
    await f.a.as.mutation(api.contacts.mutations.restoreTo, {
      tenantId: f.a.tenantId,
      id: ada,
      at: old.at,
    })
    const got = await f.a.as.query(api.contacts.queries.get, {
      tenantId: f.a.tenantId,
      id: ada,
    })
    expect(got?.contact.nickname).toBe('Countess')
    expect(got?.emails.map((e) => e.address)).toEqual(['a@x.com'])
    const [newest] = (await page(f.a, null)).page
    expect(newest.restored).toBe(true)
    expect(newest.groupName).toMatch(/^restore to /)
  })

  test('another tenant can’t read the history, and B is untouched', async () => {
    const before = await snapshot(f.t, f.b.tenantId)
    await rename('x')
    const err = await errorData(
      f.b.as.query(api.contacts.queries.history, {
        tenantId: f.a.tenantId,
        id: ada,
        paginationOpts: { numItems: 10, cursor: null },
      }),
    )
    expect(err.kind).toBe('forbidden')
    // B asking in its own tenant sees nothing of A's contact.
    expect((await page(f.b, null)).page).toEqual([])
    expect(await snapshot(f.t, f.b.tenantId)).toBe(before)
  })
})

describe('group names on revisions', () => {
  test('stamped at insert, and history reads no group', async () => {
    await formSave('Countess', 'a@x.com', 0)
    const stamped = (await revisions()).filter((r) => r.group)
    expect(stamped.map((r) => r.groupName)).toEqual([
      'contact form save',
      'contact form save',
    ])
    // `history` reads exactly the groups `groupsToRead` names: none here.
    expect(groupsToRead(await revisions())).toEqual([])
    const [newest] = (await page(f.a, null)).page
    expect(newest.groupName).toBe('contact form save')
  })

  test('a row without the stamp falls back to its group', async () => {
    await formSave('Countess', 'a@x.com', 0)
    await f.t.run(async (ctx) => {
      for (const r of await ctx.db.query('revisions').collect()) {
        if (r.groupName !== undefined) {
          await ctx.db.patch('revisions', r._id, { groupName: undefined })
        }
      }
    })
    expect(groupsToRead(await revisions())).toEqual([
      (await revisions()).find((r) => r.group)!.group,
    ])
    const [newest] = (await page(f.a, null)).page
    expect(newest.groupName).toBe('contact form save')
    expect(newest.slices.sort()).toEqual(['details', 'methods'])
  })

  test('joinMoments merges only adjacent halves of one group', () => {
    const m = (key: string, slices: Array<string>) =>
      ({ key, slices }) as unknown as Moment
    expect(
      joinMoments([
        m('g1', ['details']),
        m('g1', ['methods', 'details']),
        m('r1', ['tags']),
        m('g2', ['details']),
      ]).map((x) => [x.key, x.slices]),
    ).toEqual([
      ['g1', ['details', 'methods']],
      ['r1', ['tags']],
      ['g2', ['details']],
    ])
  })
})

describe('sharedAddresses', () => {
  const saveEmails = (
    who: Tenant,
    id: Id<'contacts'>,
    expected: number,
    addresses: Array<string>,
  ) =>
    who.as.mutation(api.contacts.mutations.saveMethods, {
      tenantId: who.tenantId,
      id,
      expected,
      emails: addresses.map((address, i) => ({
        // Row keys are the tenant's, not the contact's.
        key: i === 0 ? `k-${id}` : `k-${id}-${i}`,
        label: 'home' as const,
        address,
        isPrimary: i === 0,
      })),
      phones: [],
    })
  /** The sharers of `id`'s first email row (as saved by `saveEmails`). */
  const shared = async (who: Tenant, id: Id<'contacts'>) =>
    (
      await who.as.query(api.contacts.queries.sharedAddresses, {
        tenantId: who.tenantId,
        id,
        emails: [{ key: `k-${id}`, address: 'Ann@Example.com' }],
      })
    )[`k-${id}`]

  test('names the others after a save, and nobody once they remove it', async () => {
    await saveEmails(f.a, ada, 0, ['ann@example.com'])
    expect(await shared(f.a, ada)).toEqual({ contacts: [], truncated: false })
    const bob = await f.a.as.mutation(api.contacts.mutations.create, {
      tenantId: f.a.tenantId,
      ...individual,
      firstName: 'Bob',
    })
    await saveEmails(f.a, bob, 0, ['ANN@example.com'])
    expect(await shared(f.a, ada)).toEqual({
      contacts: [{ displayName: 'Bob Lovelace', archived: false }],
      truncated: false,
    })
    await saveEmails(f.a, bob, 1, [])
    expect((await shared(f.a, ada))?.contacts).toEqual([])
  })

  test('another tenant’s use of the address is invisible', async () => {
    await saveEmails(f.a, ada, 0, ['ann@example.com'])
    const before = await snapshot(f.t, f.a.tenantId)
    const beta = await f.b.as.mutation(api.contacts.mutations.create, {
      tenantId: f.b.tenantId,
      ...individual,
    })
    await saveEmails(f.b, beta, 0, ['ann@example.com'])
    expect((await shared(f.b, beta))?.contacts).toEqual([])
    expect((await shared(f.a, ada))?.contacts).toEqual([])
    expect(await snapshot(f.t, f.a.tenantId)).toBe(before)
  })

  test('rows past the lookup cap come back unchecked, and say so', async () => {
    const n = SHARED_ADDRESS_LIMIT + 1
    const emails = Array.from({ length: n }, (_, i) => ({
      key: `cap-${i}`,
      address: `p${i}@example.com`,
    }))
    const answer = await f.a.as.query(api.contacts.queries.sharedAddresses, {
      tenantId: f.a.tenantId,
      id: ada,
      emails,
    })
    expect(answer[`cap-${n - 2}`]).toEqual({ contacts: [], truncated: false })
    expect(answer[`cap-${n - 1}`]?.unchecked).toBe(true)
    const warnings = contactWarnings(
      { emails, phones: [], addresses: [] },
      answer,
    )
    expect(warnings).toEqual([
      expect.objectContaining({
        anchor: `emails#cap-${n - 1}`,
        label: `email ${n}`,
        message: expect.stringMatching(/^Not checked/),
      }),
    ])
  })
})
