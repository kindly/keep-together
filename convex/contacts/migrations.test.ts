import { beforeEach, describe, expect, test, vi } from 'vitest'
import migrationsTest from '@convex-dev/migrations/test'
import { runToCompletion } from '@convex-dev/migrations'
import { api, components, internal } from '../_generated/api'
import type { Id } from '../_generated/dataModel'
import { errorData, setup, snapshot } from '../../test/fixture'
import type { Tenant } from '../../test/fixture'
import { MAX_BACKFILL_PER_TENANT } from './migrations'
import { FIRST_NUMBER } from './number'

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

const run = (
  fn:
    | typeof internal.contacts.migrations.backfillFieldsVersion
    | typeof internal.contacts.migrations.backfillContactSearch
    | typeof internal.contacts.migrations.backfillContactNumbers,
  opts: { batchSize?: number; cursor?: null } = {},
) => f.t.run((ctx) => runToCompletion(ctx, components.migrations, fn, opts))

describe('backfillFieldsVersion', () => {
  /** Contacts lose `fieldsVersion`, as if created before step 1. */
  const unbackfill = () =>
    f.t.run(async (ctx) => {
      for (const c of await ctx.db.query('contacts').collect()) {
        await ctx.db.patch('contacts', c._id, { fieldsVersion: undefined })
      }
    })

  const contacts = () => f.t.run((ctx) => ctx.db.query('contacts').collect())

  test('a new contact is created with 0 and no field values', async () => {
    await createContact(f.a, 'Lovelace')
    const [c] = await contacts()
    expect(c.fieldsVersion).toBe(0)
    expect(Object.keys(c).filter((k) => /^field\d+$/.test(k))).toEqual([])
  })

  test('sets 0 on every tenant’s contacts, in batches, and nothing else', async () => {
    await createContact(f.a, 'Lovelace')
    await createContact(f.a, 'Babbage')
    await createContact(f.b, 'Herschel')
    await unbackfill()
    const before = await contacts()
    expect(before.every((c) => c.fieldsVersion === undefined)).toBe(true)
    expect(new Set(before.map((c) => c.tenantId)).size).toBe(2)

    const status = await run(
      internal.contacts.migrations.backfillFieldsVersion,
      { batchSize: 1 },
    )
    expect(status.isDone).toBe(true)
    expect(status.processed).toBe(3)
    expect(await contacts()).toEqual(
      before.map((c) => ({ ...c, fieldsVersion: 0 })),
    )
  })

  test('a contact that already has a counter keeps it; a rerun changes nothing', async () => {
    await createContact(f.a, 'Lovelace')
    await createContact(f.b, 'Herschel')
    await unbackfill()
    // One contact as if its fields slice had been saved since.
    await f.t.run(async (ctx) => {
      const [c] = await ctx.db.query('contacts').collect()
      await ctx.db.patch('contacts', c._id, { fieldsVersion: 3 })
    })
    await run(internal.contacts.migrations.backfillFieldsVersion)
    const done = await contacts()
    expect(done.map((c) => c.fieldsVersion).sort()).toEqual([0, 3])
    const status = await run(
      internal.contacts.migrations.backfillFieldsVersion,
      { cursor: null },
    )
    expect(status.isDone).toBe(true)
    expect(await contacts()).toEqual(done)
  })
})

describe('backfillContactSearch fills contactSearch.sortName', () => {
  const rows = () => f.t.run((ctx) => ctx.db.query('contactSearch').collect())

  test('projected rows carry sortName; old rows get it from the backfill, per tenant, and a rerun is a no-op', async () => {
    await createContact(f.a, 'Lovelace')
    await createContact(f.b, 'Herschel')
    expect((await rows()).map((r) => r.sortName).sort()).toEqual([
      'Herschel, Ada',
      'Lovelace, Ada',
    ])

    // As projected before step 1: no sortName.
    await f.t.run(async (ctx) => {
      for (const r of await ctx.db.query('contactSearch').collect()) {
        await ctx.db.patch('contactSearch', r._id, { sortName: undefined })
      }
    })
    await run(internal.contacts.migrations.backfillContactSearch)
    const done = await rows()
    expect(
      done
        .map((r) => [r.tenantId, r.sortName])
        .sort((x, y) => String(x[1]).localeCompare(String(y[1]))),
    ).toEqual([
      [f.b.tenantId, 'Herschel, Ada'],
      [f.a.tenantId, 'Lovelace, Ada'],
    ])
    await run(internal.contacts.migrations.backfillContactSearch, {
      cursor: null,
    })
    expect(await rows()).toEqual(done)
  })
})

describe('backfillContactNumbers', () => {
  /**
   * Every contact loses its number and every sequence row goes, as if
   * created before contact numbers step 1.
   */
  const unnumber = () =>
    f.t.run(async (ctx) => {
      for (const c of await ctx.db.query('contacts').collect()) {
        await ctx.db.patch('contacts', c._id, { number: undefined })
      }
      for (const s of await ctx.db.query('contactNumberSequences').collect()) {
        await ctx.db.delete('contactNumberSequences', s._id)
      }
    })

  /** The tenant's contacts, oldest first, as [lastName, number or null]. */
  const numbers = (who: Tenant) =>
    f.t.run(async (ctx) =>
      (await ctx.db.query('contacts').collect())
        .filter((c) => c.tenantId === who.tenantId)
        .map((c) => [c.lastName, c.number ?? null] as const),
    )

  const next = (who: Tenant) =>
    f.t.run(
      async (ctx) =>
        (await ctx.db.query('contactNumberSequences').collect()).find(
          (s) => s.tenantId === who.tenantId,
        )?.next,
    )

  const backfill = () =>
    run(internal.contacts.migrations.backfillContactNumbers, { cursor: null })

  test('numbers each tenant’s contacts in creation order from its first number', async () => {
    for (const name of ['Lovelace', 'Babbage', 'Somerville']) {
      await createContact(f.a, name)
    }
    await createContact(f.b, 'Herschel')
    await createContact(f.b, 'Fry')
    await unnumber()

    const status = await backfill()
    expect(status.isDone).toBe(true)
    expect(await numbers(f.a)).toEqual([
      ['Lovelace', FIRST_NUMBER],
      ['Babbage', FIRST_NUMBER + 1],
      ['Somerville', FIRST_NUMBER + 2],
    ])
    // Tenant B has its own sequence, untouched by A's contacts.
    expect(await numbers(f.b)).toEqual([
      ['Herschel', FIRST_NUMBER],
      ['Fry', FIRST_NUMBER + 1],
    ])
    expect(await next(f.a)).toBe(FIRST_NUMBER + 3)
    expect(await next(f.b)).toBe(FIRST_NUMBER + 2)
    // A create afterwards carries on above every backfilled number.
    await createContact(f.a, 'Hopper')
    expect((await numbers(f.a)).at(-1)).toEqual(['Hopper', FIRST_NUMBER + 3])
  })

  test('contacts numbered at create keep their numbers; old ones go above them', async () => {
    await createContact(f.a, 'Lovelace')
    await createContact(f.a, 'Babbage')
    await createContact(f.b, 'Herschel')
    await unnumber()
    // Created after step 1 deployed, before the backfill ran (plan g1q7).
    await createContact(f.a, 'Gap')
    expect(await numbers(f.a)).toEqual([
      ['Lovelace', null],
      ['Babbage', null],
      ['Gap', FIRST_NUMBER],
    ])

    await backfill()
    expect(await numbers(f.a)).toEqual([
      ['Lovelace', FIRST_NUMBER + 1],
      ['Babbage', FIRST_NUMBER + 2],
      ['Gap', FIRST_NUMBER],
    ])
    expect(await numbers(f.b)).toEqual([['Herschel', FIRST_NUMBER]])
  })

  test('creates between tenant batches never share or split a block', async () => {
    await createContact(f.a, 'Lovelace')
    await createContact(f.a, 'Babbage')
    await createContact(f.b, 'Herschel')
    await createContact(f.b, 'Fry')
    await unnumber()

    // One tenant per batch: run the first, create in both, run the rest.
    const fn = internal.contacts.migrations.backfillContactNumbers
    const firstBatch = await f.t.mutation(fn, {
      cursor: null,
      batchSize: 1,
      dryRun: false,
    })
    const [done, pending] =
      (await numbers(f.a))[0][1] === null ? [f.b, f.a] : [f.a, f.b]
    expect((await numbers(pending)).every(([, n]) => n === null)).toBe(true)
    await createContact(done, 'AfterDone')
    await createContact(pending, 'BeforeItsTurn')
    await f.t.run((ctx) =>
      runToCompletion(ctx, components.migrations, fn, {
        cursor: firstBatch.continueCursor,
      }),
    )

    // The done tenant: its block, then the create above it.
    expect((await numbers(done)).map(([, n]) => n)).toEqual([
      FIRST_NUMBER,
      FIRST_NUMBER + 1,
      FIRST_NUMBER + 2,
    ])
    // The pending tenant: the create took the first number; the old
    // contacts' block follows it whole, in creation order.
    expect((await numbers(pending)).map(([, n]) => n)).toEqual([
      FIRST_NUMBER + 1,
      FIRST_NUMBER + 2,
      FIRST_NUMBER,
    ])
    await createContact(pending, 'Later')
    expect((await numbers(pending)).at(-1)).toEqual(['Later', FIRST_NUMBER + 3])
  })

  test('a rerun changes nothing, and numbers stay unique per tenant', async () => {
    for (const name of ['Lovelace', 'Babbage', 'Somerville']) {
      await createContact(f.a, name)
    }
    await createContact(f.b, 'Herschel')
    await unnumber()
    await createContact(f.a, 'Gap')
    await backfill()
    const [a, b] = [
      await snapshot(f.t, f.a.tenantId),
      await snapshot(f.t, f.b.tenantId),
    ]

    const status = await backfill()
    expect(status.isDone).toBe(true)
    expect(await snapshot(f.t, f.a.tenantId)).toBe(a)
    expect(await snapshot(f.t, f.b.tenantId)).toBe(b)
    for (const who of [f.a, f.b]) {
      const ns = (await numbers(who)).map(([, n]) => n)
      expect(ns.every((n) => typeof n === 'number')).toBe(true)
      expect(new Set(ns).size).toBe(ns.length)
      // Contiguous from the first number: no number lost.
      expect(ns.map(Number).sort((x, y) => x - y)).toEqual(
        ns.map((_, i) => FIRST_NUMBER + i),
      )
      expect(await next(who)).toBe(FIRST_NUMBER + ns.length)
    }
  })

  test('a tenant over the cap is skipped whole and logged; the others are numbered', async () => {
    await createContact(f.a, 'Lovelace')
    await createContact(f.b, 'Herschel')
    await createContact(f.b, 'Fry')
    await unnumber()
    // Tenant A (created first, so its batch runs first) goes one over.
    expect((await f.t.run((ctx) => ctx.db.query('tenants').first()))?._id).toBe(
      f.a.tenantId,
    )
    await f.t.run(async (ctx) => {
      const c = (await ctx.db.query('contacts').collect()).find(
        (c) => c.tenantId === f.a.tenantId,
      )!
      const { _id, _creationTime, ...copy } = c
      for (let i = 1; i < MAX_BACKFILL_PER_TENANT + 1; i++) {
        await ctx.db.insert('contacts', copy)
      }
    })
    const before = await snapshot(f.t, f.a.tenantId)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const status = await backfill()
      expect(status.isDone).toBe(true)
      expect(error).toHaveBeenCalledWith(
        expect.stringMatching(
          new RegExp(
            `skipped tenant ${f.a.tenantId} .*more than ${MAX_BACKFILL_PER_TENANT}`,
          ),
        ),
      )
    } finally {
      error.mockRestore()
    }
    // A: no number taken, no sequence row, nothing written.
    expect(await snapshot(f.t, f.a.tenantId)).toBe(before)
    // (t.run returns the missing row's undefined as null.)
    expect(await next(f.a)).toBeNull()
    expect(await numbers(f.b)).toEqual([
      ['Herschel', FIRST_NUMBER],
      ['Fry', FIRST_NUMBER + 1],
    ])
  })

  test('the contact’s other fields and its search row are untouched', async () => {
    const id: Id<'contacts'> = await createContact(f.a, 'Lovelace')
    await unnumber()
    const read = () =>
      f.t.run(async (ctx) => ({
        contact: await ctx.db.get(id),
        search: await ctx.db.query('contactSearch').collect(),
        revisions: (await ctx.db.query('revisions').collect()).length,
      }))
    const before = await read()
    await backfill()
    const after = await read()
    expect(after.contact).toEqual({ ...before.contact, number: FIRST_NUMBER })
    expect(after.search).toEqual(before.search)
    expect(after.revisions).toBe(before.revisions)
  })
})

describe('dropTagData (dropdown fields step 8)', () => {
  /**
   * Tag data as step 7 left it, on every contact of `who`: a tag, a link
   * to it, the slice's counter, its revision; and the tenant's tag switch.
   * Returns the revision ids.
   */
  const tagEra = (who: Tenant) =>
    f.t.run(async (ctx) => {
      const tagId = await ctx.db.insert('tags', {
        tenantId: who.tenantId,
        name: 'Volunteer',
        nameNormalized: 'volunteer',
        isActive: true,
        saveVersion: 0,
      })
      const revisionIds: Array<Id<'revisions'>> = []
      for (const c of await ctx.db.query('contacts').collect()) {
        if (c.tenantId !== who.tenantId) continue
        await ctx.db.insert('contactTags', {
          tenantId: who.tenantId,
          contactId: c._id,
          key: `t-${c._id}`,
          tagId,
          name: 'Volunteer',
        })
        await ctx.db.patch('contacts', c._id, { tagsVersion: 1 })
        revisionIds.push(
          await ctx.db.insert('revisions', {
            tenantId: who.tenantId,
            entity: 'contacts',
            entityId: c._id,
            contract: 'contacts.tags',
            version: 1,
            counter: 0,
            payload: { tags: [{ key: `t-${c._id}`, tagId }] },
            source: 'ui',
            actor: who.userId,
          }),
        )
      }
      await ctx.db.insert('tenantPreferences', {
        tenantId: who.tenantId,
        staffCanManageTags: true,
        tagsVersion: 2,
        staffCanManageIdentifierTypes: false,
        identifierTypesVersion: 0,
        staffCanManageSourceCodes: true,
        sourceCodesVersion: 1,
        staffCanManageFields: false,
        fieldsVersion: 0,
      })
      return revisionIds
    })

  const read = () =>
    f.t.run(async (ctx) => ({
      tags: await ctx.db.query('tags').collect(),
      contactTags: await ctx.db.query('contactTags').collect(),
      contacts: await ctx.db.query('contacts').collect(),
      prefs: await ctx.db.query('tenantPreferences').collect(),
      search: await ctx.db.query('contactSearch').collect(),
      revisions: await ctx.db.query('revisions').collect(),
    }))

  /** The series, as the CLI starts it, run until every part is done. */
  const dropTagData = async (batchSize?: number) => {
    await f.t.mutation(internal.contacts.migrations.dropTagData, {
      batchSize,
    })
    await f.t.finishAllScheduledFunctions(() => {})
    const statuses = await f.t.run((ctx) =>
      ctx.runQuery(components.migrations.lib.getStatus, {}),
    )
    return Object.fromEntries(
      statuses.map((s) => [s.name.split(':').at(-1), s.isDone]),
    )
  }

  const PARTS = {
    deleteContactTags: true,
    deleteTags: true,
    unsetContactTagsVersion: true,
    unsetTagPreferences: true,
  }

  test('empties both tag tables and unsets the tag fields, in every tenant, and nothing else', async () => {
    await createContact(f.a, 'Lovelace')
    await createContact(f.a, 'Babbage')
    await createContact(f.b, 'Herschel')
    await tagEra(f.a)
    await tagEra(f.b)
    const before = await read()
    expect(before.contactTags).toHaveLength(3)
    expect(new Set(before.tags.map((t) => t.tenantId)).size).toBe(2)

    expect(await dropTagData(1)).toEqual(PARTS)
    const after = await read()
    expect(after.tags).toEqual([])
    expect(after.contactTags).toEqual([])
    expect(after.contacts).toEqual(
      before.contacts.map(({ tagsVersion: _, ...c }) => c),
    )
    expect(after.contacts.some((c) => 'tagsVersion' in c)).toBe(false)
    expect(after.prefs).toEqual(
      before.prefs.map(
        ({ staffCanManageTags: _s, tagsVersion: _v, ...row }) => row,
      ),
    )
    // Derived rows and history are untouched: tag revisions stay.
    expect(after.search).toEqual(before.search)
    expect(after.revisions).toEqual(before.revisions)
  })

  test('a contact created now has no tagsVersion to unset', async () => {
    await createContact(f.a, 'Lovelace')
    const { contacts } = await read()
    expect(contacts[0]).not.toHaveProperty('tagsVersion')
  })

  test('a rerun, and a run on a tenant with no tag data, change nothing', async () => {
    await createContact(f.a, 'Lovelace')
    await createContact(f.b, 'Herschel')
    await tagEra(f.a) // B never had tags
    const b = await snapshot(f.t, f.b.tenantId)
    await dropTagData()
    expect(await snapshot(f.t, f.b.tenantId)).toBe(b)
    const [a, settled] = [await snapshot(f.t, f.a.tenantId), await read()]

    await f.t.mutation(internal.contacts.migrations.dropTagData, {
      reset: true,
    })
    await f.t.finishAllScheduledFunctions(() => {})
    expect(await read()).toEqual(settled)
    expect(await snapshot(f.t, f.a.tenantId)).toBe(a)
    expect(await snapshot(f.t, f.b.tenantId)).toBe(b)
  })

  test('tag revisions still show in history and are still refused, per tenant', async () => {
    const ada = await createContact(f.a, 'Lovelace')
    await createContact(f.b, 'Herschel')
    const [revisionId] = await tagEra(f.a)
    await tagEra(f.b)
    await dropTagData()

    const history = (who: Tenant) =>
      who.as.query(api.contacts.queries.history, {
        tenantId: who.tenantId,
        id: ada,
        paginationOpts: { numItems: 10, cursor: null },
      })
    expect((await history(f.a)).page.some((m) => m.retired)).toBe(true)
    expect((await history(f.b)).page).toEqual([])
    expect(
      await errorData(
        f.a.as.mutation(api.contacts.mutations.restoreRevision, {
          tenantId: f.a.tenantId,
          revisionId,
        }),
      ),
    ).toMatchObject({ kind: 'rejected', reason: 'retired_contract' })
    expect(
      await errorData(
        f.b.as.mutation(api.contacts.mutations.restoreRevision, {
          tenantId: f.b.tenantId,
          revisionId,
        }),
      ),
    ).toEqual({ kind: 'not_found' })
  })
})
