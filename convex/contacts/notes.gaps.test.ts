/**
 * Tester gaps for S6 (notes backend): races between toggles and body saves,
 * restore after flag changes, ordering, the 200 cap, blank bodies, archived
 * contacts, author/editor across users, and tenant isolation per function.
 */
import { beforeEach, describe, expect, test } from 'vitest'
import type { Id } from '../_generated/dataModel'
import { api } from '../_generated/api'
import { errorData, setup, snapshot } from '../../test/fixture'
import { executeContract } from '../lib/contracts'
import { scopeWriter } from '../lib/tenancy'
import { note, noteFlags } from './contracts'

type Fixture = Awaited<ReturnType<typeof setup>>

const individual = (lastName: string) => ({
  kind: 'individual' as const,
  title: '',
  firstName: 'Ada',
  lastName,
  nickname: '',
  name: '',
  isDeceased: false,
})

let f: Fixture
let ada: Id<'contacts'>

beforeEach(async () => {
  f = await setup()
  ada = await f.a.as.mutation(api.contacts.mutations.create, {
    tenantId: f.a.tenantId,
    ...individual('Lovelace'),
  })
})

const create = (body: string, pinned?: boolean) =>
  f.a.as.mutation(api.contacts.notes.create, {
    tenantId: f.a.tenantId,
    contactId: ada,
    body,
    pinned,
  })
const save = (id: Id<'contactNotes'>, expected: number, body: string) =>
  f.a.as.mutation(api.contacts.notes.save, {
    tenantId: f.a.tenantId,
    id,
    expected,
    body,
  })
const setPinned = (id: Id<'contactNotes'>, pinned: boolean) =>
  f.a.as.mutation(api.contacts.notes.setPinned, {
    tenantId: f.a.tenantId,
    id,
    pinned,
  })
const setArchived = (id: Id<'contactNotes'>, archived: boolean) =>
  f.a.as.mutation(api.contacts.notes.setArchived, {
    tenantId: f.a.tenantId,
    id,
    archived,
  })
const forAda = async () =>
  (
    await f.a.as.query(api.contacts.notes.forContact, {
      tenantId: f.a.tenantId,
      id: ada,
    })
  ).notes
const archivedForAda = async () =>
  (
    await f.a.as.query(api.contacts.notes.archivedForContact, {
      tenantId: f.a.tenantId,
      id: ada,
    })
  ).notes
const noteDoc = (id: Id<'contactNotes'>) => f.t.run((ctx) => ctx.db.get(id))
const revisionsOf = (id: Id<'contactNotes'>) =>
  f.t.run((ctx) =>
    ctx.db
      .query('revisions')
      .withIndex('by_tenant_entity', (q) =>
        q
          .eq('tenantId', f.a.tenantId)
          .eq('entity', 'contactNotes')
          .eq('entityId', id),
      )
      .collect(),
  )
const restore = (revisionId: Id<'revisions'>) =>
  f.a.as.mutation(api.contacts.mutations.restoreRevision, {
    tenantId: f.a.tenantId,
    revisionId,
  })

/** Many notes on Ada in one transaction, in order; returns their ids. */
const bulk = (
  specs: Array<{ body: string; pinned?: boolean; archived?: boolean }>,
) =>
  f.t.run(async (ctx) => {
    const c = { db: scopeWriter(ctx, f.a.tenantId), userId: f.a.userId }
    const ids: Array<Id<'contactNotes'>> = []
    for (const s of specs) {
      const { id } = await executeContract(
        c,
        note,
        { body: s.body },
        { source: 'test', createWith: { contactId: ada } },
      )
      if (s.pinned || s.archived) {
        await executeContract(
          c,
          noteFlags,
          { pinned: s.pinned ?? false, archived: s.archived ?? false },
          { entityId: id, source: 'test' },
        )
      }
      ids.push(id)
    }
    return ids
  })

/** A second member (staff) of tenant A. */
const addStaff = async (slug: string) => {
  const userId = await f.t.run(async (ctx) => {
    const id = await ctx.db.insert('users', { email: `${slug}@example.com` })
    await ctx.db.insert('memberships', {
      tenantId: f.a.tenantId,
      userId: id,
      role: 'staff',
    })
    return id
  })
  return {
    userId,
    as: f.t.withIdentity({ subject: `${userId}|session-${slug}` }),
  }
}

describe('toggle vs body save', () => {
  test('body save then pin: both survive', async () => {
    const { id } = await create('Draft')
    // Two clients both loaded the note at counter 0.
    await save(id, 0, 'Edited by one')
    await setPinned(id, true)
    const doc = await noteDoc(id)
    expect(doc).toMatchObject({
      body: 'Edited by one',
      pinned: true,
      bodyVersion: 1,
      flagsVersion: 1,
    })
  })

  test('body save then archive: archived note keeps the new body', async () => {
    const { id } = await create('Draft')
    await save(id, 0, 'Edited')
    await setArchived(id, true)
    expect((await archivedForAda()).map((n) => n.body)).toEqual(['Edited'])
  })

  test('pin then body save from before the pin: no conflict, both kept', async () => {
    const { id } = await create('Draft')
    await setPinned(id, true)
    // Separate counters: the editor's `expected` is still current.
    await save(id, 0, 'Edited after pin')
    expect(await noteDoc(id)).toMatchObject({
      body: 'Edited after pin',
      pinned: true,
      archived: false,
    })
  })

  test('archive then body save: refused until unarchived', async () => {
    const { id } = await create('Draft')
    await setArchived(id, true)
    expect(await errorData(save(id, 0, 'Late'))).toMatchObject({
      kind: 'rejected',
      reason: 'archived',
    })
    expect(await noteDoc(id)).toMatchObject({ body: 'Draft', archived: true })
    expect(await forAda()).toEqual([])
  })

  test('pin and archive interleaved keep each other', async () => {
    const { id } = await create('Draft')
    await setPinned(id, true)
    await setArchived(id, true)
    // The pin is frozen while archived.
    expect(await errorData(setPinned(id, false))).toMatchObject({
      kind: 'rejected',
      reason: 'archived',
    })
    await setArchived(id, false)
    await setPinned(id, false)
    await setPinned(id, true)
    expect(await noteDoc(id)).toMatchObject({ pinned: true, archived: false })
    expect((await noteDoc(id))!.flagsVersion).toBe(5)
  })
})

describe('restoreRevision after flag changes', () => {
  test('restoring the create revision brings back the body only', async () => {
    const { id } = await create('Original')
    await save(id, 0, 'Edited')
    await setPinned(id, true)
    const [first] = await revisionsOf(id)
    const restored = await restore(first._id)
    expect(restored.counter).toBe(2)
    expect(await noteDoc(id)).toMatchObject({
      body: 'Original',
      pinned: true,
      archived: false,
      bodyVersion: 2,
      flagsVersion: 1,
    })
    const last = (await revisionsOf(id)).at(-1)!
    expect(last).toMatchObject({ source: 'restore', restoredFrom: first._id })
  })

  test('restoring a body revision onto an archived note is refused', async () => {
    const { id } = await create('Original')
    await save(id, 0, 'Edited')
    await setArchived(id, true)
    const [first] = await revisionsOf(id)
    expect(await errorData(restore(first._id))).toMatchObject({
      kind: 'rejected',
      reason: 'archived',
    })
  })

  test('restoring the pin revision re-pins an unpinned note', async () => {
    const { id } = await create('Text')
    await setPinned(id, true)
    await setPinned(id, false)
    const pinRev = (await revisionsOf(id))[1]
    await restore(pinRev._id)
    expect((await forAda()).map((n) => [n.body, n.pinned])).toEqual([
      ['Text', true],
    ])
  })

  test('restore makes an open edit stale', async () => {
    const { id } = await create('One')
    await save(id, 0, 'Two')
    const [first] = await revisionsOf(id)
    await restore(first._id)
    expect(await errorData(save(id, 1, 'Three'))).toMatchObject({
      kind: 'stale',
      current: 2,
    })
  })
})

describe('ordering', () => {
  test('notes created in one transaction come back last-created first', async () => {
    const bodies = Array.from({ length: 10 }, (_, i) => `n${i}`)
    await bulk(bodies.map((body) => ({ body })))
    expect((await forAda()).map((n) => n.body)).toEqual([...bodies].reverse())
  })

  test('many pinned: all pinned first, each section newest first', async () => {
    const specs = Array.from({ length: 12 }, (_, i) => ({
      body: `n${i}`,
      pinned: i % 3 !== 0,
    }))
    await bulk(specs)
    const got = (await forAda()).map((n) => n.body)
    const pinned = specs
      .filter((s) => s.pinned)
      .map((s) => s.body)
      .reverse()
    const rest = specs
      .filter((s) => !s.pinned)
      .map((s) => s.body)
      .reverse()
    expect(got).toEqual([...pinned, ...rest])
  })

  test('pin order is creation order, not pin time', async () => {
    const [older, newer] = await bulk([{ body: 'older' }, { body: 'newer' }])
    await setPinned(newer, true)
    await setPinned(older, true)
    expect((await forAda()).map((n) => n.body)).toEqual(['newer', 'older'])
  })

  test('archived list mixes pinned and unpinned by creation time only', async () => {
    await bulk([
      { body: 'a', pinned: true, archived: true },
      { body: 'b', archived: true },
      { body: 'c', pinned: true, archived: true },
      { body: 'd', archived: true },
    ])
    expect((await archivedForAda()).map((n) => n.body)).toEqual([
      'd',
      'c',
      'b',
      'a',
    ])
  })
})

describe('200 cap', () => {
  test('forContact: 150 pinned + 100 unpinned → all pinned and the 50 newest unpinned', async () => {
    const specs = [
      ...Array.from({ length: 100 }, (_, i) => ({ body: `u${i}` })),
      ...Array.from({ length: 150 }, (_, i) => ({
        body: `p${i}`,
        pinned: true,
      })),
    ]
    await bulk(specs)
    const got = await forAda()
    expect(got).toHaveLength(200)
    expect(got.filter((n) => n.pinned)).toHaveLength(150)
    expect(got.slice(150).map((n) => n.body)).toEqual(
      Array.from({ length: 50 }, (_, i) => `u${99 - i}`),
    )
  })

  test('forContact: 250 unpinned → the 200 newest', async () => {
    await bulk(Array.from({ length: 250 }, (_, i) => ({ body: `u${i}` })))
    const got = await forAda()
    expect(got).toHaveLength(200)
    expect(got[0].body).toBe('u249')
    expect(got[199].body).toBe('u50')
  })

  test('forContact: 210 pinned → 200 pinned, no unpinned', async () => {
    await bulk([
      { body: 'plain' },
      ...Array.from({ length: 210 }, (_, i) => ({
        body: `p${i}`,
        pinned: true,
      })),
    ])
    const { notes: got, truncated } = await f.a.as.query(
      api.contacts.notes.forContact,
      { tenantId: f.a.tenantId, id: ada },
    )
    expect(got).toHaveLength(200)
    expect(got.every((n) => n.pinned)).toBe(true)
    expect(truncated).toBe(true)
  })

  test('forContact ignores archived notes when counting the cap', async () => {
    await bulk([
      { body: 'live' },
      ...Array.from({ length: 220 }, (_, i) => ({
        body: `x${i}`,
        archived: true,
      })),
    ])
    expect((await forAda()).map((n) => n.body)).toEqual(['live'])
  })

  test('archivedForContact: 150 pinned + 150 unpinned interleaved → the 200 newest', async () => {
    const specs = Array.from({ length: 300 }, (_, i) => ({
      body: `a${i}`,
      pinned: i % 2 === 0,
      archived: true,
    }))
    await bulk(specs)
    const got = (await archivedForAda()).map((n) => n.body)
    expect(got).toHaveLength(200)
    expect(got).toEqual(Array.from({ length: 200 }, (_, i) => `a${299 - i}`))
  })
})

describe('blank bodies', () => {
  for (const [label, body] of [
    ['spaces', '   '],
    ['newlines and tabs', '\n\t \r\n'],
    ['non-breaking spaces', '  '],
    ['empty', ''],
  ] as const) {
    test(`create with ${label} is invalid`, async () => {
      expect((await errorData(create(body))).kind).toBe('invalid')
    })
    test(`save with ${label} is invalid and changes nothing`, async () => {
      const { id } = await create('Keep me')
      const data = await errorData(save(id, 0, body))
      expect(data).toMatchObject({ kind: 'invalid' })
      expect(await noteDoc(id)).toMatchObject({
        body: 'Keep me',
        bodyVersion: 0,
      })
      expect(await revisionsOf(id)).toHaveLength(1)
    })
  }

  test('inner line breaks are kept, only the ends are trimmed', async () => {
    const { id } = await create('\n  Line one\n\nLine two  \n')
    expect((await noteDoc(id))!.body).toBe('Line one\n\nLine two')
  })
})

describe('notes on an archived contact', () => {
  beforeEach(async () => {
    await f.a.as.mutation(api.contacts.mutations.setArchived, {
      tenantId: f.a.tenantId,
      id: ada,
      expected: 0,
      archived: true,
    })
  })

  test('existing and new notes stay listed, editable, pinnable, archivable', async () => {
    const { id } = await create('After archive')
    expect((await forAda()).map((n) => n.body)).toEqual(['After archive'])
    await save(id, 0, 'Edited')
    await setPinned(id, true)
    await setArchived(id, true)
    expect(await forAda()).toEqual([])
    expect((await archivedForAda()).map((n) => [n.body, n.pinned])).toEqual([
      ['Edited', true],
    ])
  })
})

describe('author and editedBy', () => {
  test('createdBy stays the creator; editedBy and editedAt follow body saves only', async () => {
    const bo = await addStaff('bo')
    const cy = await addStaff('cy')
    const { id } = await create('By owner')
    await bo.as.mutation(api.contacts.notes.save, {
      tenantId: f.a.tenantId,
      id,
      expected: 0,
      body: 'By Bo',
    })
    let [got] = await forAda()
    expect(got).toMatchObject({ createdBy: f.a.userId, editedBy: bo.userId })
    const boEditedAt = got.editedAt

    await cy.as.mutation(api.contacts.notes.save, {
      tenantId: f.a.tenantId,
      id,
      expected: 1,
      body: 'By Cy',
    })
    ;[got] = await forAda()
    expect(got).toMatchObject({ createdBy: f.a.userId, editedBy: cy.userId })
    expect(got.editedAt).toBeGreaterThanOrEqual(boEditedAt)
    const cyEditedAt = got.editedAt

    // A pin by Bo is not an edit.
    await bo.as.mutation(api.contacts.notes.setPinned, {
      tenantId: f.a.tenantId,
      id,
      pinned: true,
    })
    ;[got] = await forAda()
    expect(got).toMatchObject({
      createdBy: f.a.userId,
      editedBy: cy.userId,
      editedAt: cyEditedAt,
    })

    // A restore by Cy of the owner's create revision is an edit by Cy.
    const revisions = await revisionsOf(id)
    await cy.as.mutation(api.contacts.mutations.restoreRevision, {
      tenantId: f.a.tenantId,
      revisionId: revisions[0]._id,
    })
    ;[got] = await forAda()
    expect(got).toMatchObject({
      body: 'By owner',
      createdBy: f.a.userId,
      editedBy: cy.userId,
    })
  })

  test('a never-edited note has editedAt at its creation and editedBy = createdBy', async () => {
    const bo = await addStaff('bo')
    await bo.as.mutation(api.contacts.notes.create, {
      tenantId: f.a.tenantId,
      contactId: ada,
      body: 'Fresh',
    })
    const [got] = await forAda()
    expect(got).toMatchObject({ createdBy: bo.userId, editedBy: bo.userId })
    expect(got.editedAt).toBeLessThanOrEqual(got._creationTime)
  })
})

describe('tenant isolation, every function', () => {
  let aNote: Id<'contactNotes'>
  let bob: Id<'contacts'>
  let bNote: Id<'contactNotes'>
  let aSnap: string
  let bSnap: string

  beforeEach(async () => {
    aNote = (await create('A secret', true)).id
    await setArchived(aNote, true)
    await setArchived(aNote, false)
    bob = await f.b.as.mutation(api.contacts.mutations.create, {
      tenantId: f.b.tenantId,
      ...individual('Babbage'),
    })
    bNote = (
      await f.b.as.mutation(api.contacts.notes.create, {
        tenantId: f.b.tenantId,
        contactId: bob,
        body: 'B secret',
      })
    ).id
    aSnap = await snapshot(f.t, f.a.tenantId)
    bSnap = await snapshot(f.t, f.b.tenantId)
  })

  const unchanged = async () => {
    expect(await snapshot(f.t, f.a.tenantId)).toBe(aSnap)
    expect(await snapshot(f.t, f.b.tenantId)).toBe(bSnap)
  }

  test('create in B on A’s contact, and in A on B’s contact, is rejected', async () => {
    for (const call of [
      f.b.as.mutation(api.contacts.notes.create, {
        tenantId: f.b.tenantId,
        contactId: ada,
        body: 'x',
      }),
      f.a.as.mutation(api.contacts.notes.create, {
        tenantId: f.a.tenantId,
        contactId: bob,
        body: 'x',
        pinned: true,
      }),
    ]) {
      expect(await errorData(call)).toMatchObject({
        kind: 'rejected',
        reason: 'unknown_contact',
      })
    }
    await unchanged()
  })

  test('save / setPinned / setArchived with a foreign note id: not_found, no writes', async () => {
    const calls = [
      f.b.as.mutation(api.contacts.notes.save, {
        tenantId: f.b.tenantId,
        id: aNote,
        expected: 2,
        body: 'x',
      }),
      f.b.as.mutation(api.contacts.notes.setPinned, {
        tenantId: f.b.tenantId,
        id: aNote,
        pinned: false,
      }),
      // No-op value too: must not leak existence via a non-error return.
      f.b.as.mutation(api.contacts.notes.setPinned, {
        tenantId: f.b.tenantId,
        id: aNote,
        pinned: true,
      }),
      f.b.as.mutation(api.contacts.notes.setArchived, {
        tenantId: f.b.tenantId,
        id: aNote,
        archived: true,
      }),
      f.b.as.mutation(api.contacts.notes.setArchived, {
        tenantId: f.b.tenantId,
        id: aNote,
        archived: false,
      }),
      f.a.as.mutation(api.contacts.notes.save, {
        tenantId: f.a.tenantId,
        id: bNote,
        expected: 0,
        body: 'x',
      }),
      f.a.as.mutation(api.contacts.notes.setPinned, {
        tenantId: f.a.tenantId,
        id: bNote,
        pinned: true,
      }),
      f.a.as.mutation(api.contacts.notes.setArchived, {
        tenantId: f.a.tenantId,
        id: bNote,
        archived: true,
      }),
    ]
    for (const call of calls) {
      expect((await errorData(call)).kind).toBe('not_found')
    }
    await unchanged()
  })

  test('forContact / archivedForContact with a foreign contact id return nothing', async () => {
    await setArchived(aNote, true)
    aSnap = await snapshot(f.t, f.a.tenantId)
    for (const fn of [
      api.contacts.notes.forContact,
      api.contacts.notes.archivedForContact,
    ]) {
      const nothing = { notes: [], truncated: false }
      expect(
        await f.b.as.query(fn, { tenantId: f.b.tenantId, id: ada }),
      ).toEqual(nothing)
      expect(
        await f.a.as.query(fn, { tenantId: f.a.tenantId, id: bob }),
      ).toEqual(nothing)
    }
    await unchanged()
  })

  test('archivedForContact into the other tenant is forbidden', async () => {
    const data = await errorData(
      f.b.as.query(api.contacts.notes.archivedForContact, {
        tenantId: f.a.tenantId,
        id: ada,
      }),
    )
    expect(data.kind).toBe('forbidden')
  })

  test('mutations into the other tenant are forbidden', async () => {
    for (const call of [
      f.b.as.mutation(api.contacts.notes.create, {
        tenantId: f.a.tenantId,
        contactId: ada,
        body: 'x',
      }),
      f.b.as.mutation(api.contacts.notes.save, {
        tenantId: f.a.tenantId,
        id: aNote,
        expected: 2,
        body: 'x',
      }),
      f.b.as.mutation(api.contacts.notes.setPinned, {
        tenantId: f.a.tenantId,
        id: aNote,
        pinned: false,
      }),
      f.b.as.mutation(api.contacts.notes.setArchived, {
        tenantId: f.a.tenantId,
        id: aNote,
        archived: true,
      }),
    ]) {
      expect((await errorData(call)).kind).toBe('forbidden')
    }
    await unchanged()
  })

  test('restoreRevision of a foreign note revision: not_found', async () => {
    const [aRev] = await revisionsOf(aNote)
    const data = await errorData(
      f.b.as.mutation(api.contacts.mutations.restoreRevision, {
        tenantId: f.b.tenantId,
        revisionId: aRev._id,
      }),
    )
    expect(data.kind).toBe('not_found')
    await unchanged()
  })

  test('each tenant’s notes carry their own author and editor', async () => {
    const [aView] = await forAda()
    expect(aView).toMatchObject({
      createdBy: f.a.userId,
      editedBy: f.a.userId,
    })
    const {
      notes: [bView],
    } = await f.b.as.query(api.contacts.notes.forContact, {
      tenantId: f.b.tenantId,
      id: bob,
    })
    expect(bView).toMatchObject({
      body: 'B secret',
      createdBy: f.b.userId,
      editedBy: f.b.userId,
      bodyVersion: 0,
    })
  })
})
