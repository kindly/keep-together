import { beforeEach, describe, expect, test } from 'vitest'
import type { Id } from '../_generated/dataModel'
import { api } from '../_generated/api'
import { errorData, setup, snapshot } from '../../test/fixture'
import { executeContract } from '../lib/contracts'
import { scopeWriter } from '../lib/tenancy'
import { note } from './contracts'
import { NOTE_MAX_BYTES } from './rules'

type Fixture = Awaited<ReturnType<typeof setup>>

const individual = (lastName: string) => ({
  kind: 'individual' as const,
  title: '',
  firstName: 'Ada',
  lastName,
  nickname: '',
  name: '',
  isDeceased: false,
  externalIdentifier: '',
})

let f: Fixture
let ada: Id<'contacts'>
let bSnapshot: string

beforeEach(async () => {
  f = await setup()
  bSnapshot = await snapshot(f.t, f.b.tenantId)
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

const noteDoc = (id: Id<'contactNotes'>) => f.t.run((ctx) => ctx.db.get(id))

describe('notes', () => {
  test('create and edit; author and editor are stored on the note', async () => {
    const { id, counter } = await create('  Met at the fair  ')
    expect(counter).toBe(0)
    const edited = await save(id, 0, 'Met at the Christmas fair')
    expect(edited.counter).toBe(1)

    const [got] = await forAda()
    expect(got).toMatchObject({
      body: 'Met at the Christmas fair',
      bodyVersion: 1,
      flagsVersion: 0,
      createdBy: f.a.userId,
      editedBy: f.a.userId,
    })
    const revisions = await revisionsOf(id)
    expect(revisions.map((r) => [r.contract, r.counter])).toEqual([
      ['contacts.note', 0],
      ['contacts.note', 1],
    ])
    // Payloads are the normalised body only; contactId is not slice state.
    expect(revisions[0].payload).toEqual({ body: 'Met at the fair' })
    expect(got.editedAt).toBeGreaterThanOrEqual(revisions[0]._creationTime)
  })

  test('empty body is rejected', async () => {
    const data = await errorData(create('   '))
    expect(data.kind).toBe('invalid')
  })

  test('body is capped at NOTE_MAX_BYTES UTF-8 bytes', async () => {
    await create('x'.repeat(NOTE_MAX_BYTES))
    const data = await errorData(create('x'.repeat(NOTE_MAX_BYTES + 1)))
    expect(data.kind).toBe('invalid')
  })

  test('multi-byte text is capped by bytes, not characters', async () => {
    // '€' is 3 bytes in UTF-8: 6,667 characters, 20,001 bytes.
    const euros = '€'.repeat(6_667)
    expect(euros.length).toBeLessThan(NOTE_MAX_BYTES)
    expect(await errorData(create(euros))).toMatchObject({ kind: 'invalid' })
    await create('€'.repeat(6_666))
  })

  test('stale edit conflicts and leaves no trace', async () => {
    const { id } = await create('First')
    await save(id, 0, 'Second')
    const data = await errorData(save(id, 0, 'Lost update'))
    expect(data).toMatchObject({
      kind: 'stale',
      contract: 'contacts.note',
      current: 1,
    })
    expect((await forAda())[0].body).toBe('Second')
    expect(await revisionsOf(id)).toHaveLength(2)
  })

  test('two notes on one contact never conflict', async () => {
    const one = await create('One')
    const two = await create('Two')
    await save(one.id, 0, 'One, edited')
    await save(two.id, 0, 'Two, edited')
    expect((await forAda()).map((n) => n.body).sort()).toEqual([
      'One, edited',
      'Two, edited',
    ])
  })

  test('note on an unknown contact is rejected', async () => {
    await f.a.as.mutation(api.contacts.mutations.setArchived, {
      tenantId: f.a.tenantId,
      id: ada,
      expected: 0,
      archived: true,
    })
    // Archived contacts still take notes; a missing one does not.
    await create('Still fine')
    await f.t.run((ctx) => ctx.db.delete(ada))
    const data = await errorData(create('Nobody'))
    expect(data).toMatchObject({ kind: 'rejected', reason: 'unknown_contact' })
  })

  test('pinned first, then newest first', async () => {
    const old = await create('Old')
    const pinned = await create('Pinned')
    const newer = await create('Newer')
    await setPinned(pinned.id, true)
    expect((await forAda()).map((n) => n.body)).toEqual([
      'Pinned',
      'Newer',
      'Old',
    ])
    await setPinned(old.id, true)
    expect((await forAda()).map((n) => [n.body, n.pinned])).toEqual([
      ['Pinned', true],
      ['Old', true],
      ['Newer', false],
    ])
    expect(newer.counter).toBe(0)
  })

  test('create pinned is one command group of two contracts', async () => {
    const { id } = await create('Pinned at birth', true)
    const revisions = await revisionsOf(id)
    expect(revisions.map((r) => r.contract)).toEqual([
      'contacts.note',
      'contacts.noteFlags',
    ])
    expect(revisions[0].group).toBeDefined()
    expect(revisions[1].group).toBe(revisions[0].group)
    expect((await noteDoc(id))?.pinned).toBe(true)
  })

  test('archive hides and restores, on the flags counter', async () => {
    const { id } = await create('Sensitive', true)
    expect((await setArchived(id, true)).counter).toBe(2)
    expect(await forAda()).toEqual([])
    const archived = await archivedForAda()
    expect(archived.map((n) => [n.body, n.pinned])).toEqual([
      ['Sensitive', true],
    ])

    expect((await setArchived(id, false)).counter).toBe(3)
    expect((await forAda()).map((n) => n.body)).toEqual(['Sensitive'])
    expect(await archivedForAda()).toEqual([])
    expect((await noteDoc(id))?.bodyVersion).toBe(0)
  })

  test('no-op pin or archive writes nothing', async () => {
    const { id } = await create('Plain')
    expect(await setPinned(id, false)).toEqual({ id, counter: 0 })
    expect(await setArchived(id, false)).toEqual({ id, counter: 0 })
    expect(await revisionsOf(id)).toHaveLength(1)
  })

  test('a pin never makes a body edit stale, and is not an edit', async () => {
    const staff = await f.t.run(async (ctx) => {
      const userId = await ctx.db.insert('users', { email: 'ben@x.com' })
      await ctx.db.insert('memberships', {
        tenantId: f.a.tenantId,
        userId,
        role: 'staff',
      })
      return userId
    })
    const ben = f.t.withIdentity({ subject: `${staff}|session-ben` })
    const { id } = await create('Text')
    const before = (await noteDoc(id))!
    await ben.mutation(api.contacts.notes.setPinned, {
      tenantId: f.a.tenantId,
      id,
      pinned: true,
    })
    const pinned = (await noteDoc(id))!
    expect(pinned.editedBy).toBe(f.a.userId)
    expect(pinned.editedAt).toBe(before.editedAt)

    await save(id, 0, 'Edited')
    expect(await noteDoc(id)).toMatchObject({
      body: 'Edited',
      pinned: true,
      bodyVersion: 1,
      flagsVersion: 1,
    })
  })

  test('archived notes refuse body edits and pinning until restored', async () => {
    const { id } = await create('Text')
    await setArchived(id, true)
    for (const call of [save(id, 0, 'Edited'), setPinned(id, true)]) {
      expect(await errorData(call)).toMatchObject({
        kind: 'rejected',
        reason: 'archived',
      })
    }
    await setArchived(id, false)
    await save(id, 0, 'Edited')
    await setPinned(id, true)
    expect(await noteDoc(id)).toMatchObject({ body: 'Edited', pinned: true })
  })

  test('restoring a body revision leaves the flags alone', async () => {
    const { id } = await create('Original')
    await save(id, 0, 'Overwritten')
    await setPinned(id, true)
    const [first] = await revisionsOf(id)
    const restored = await f.a.as.mutation(
      api.contacts.mutations.restoreRevision,
      { tenantId: f.a.tenantId, revisionId: first._id },
    )
    expect(restored.counter).toBe(2)
    expect(await noteDoc(id)).toMatchObject({
      body: 'Original',
      pinned: true,
      archived: false,
      flagsVersion: 1,
    })
  })

  test('restore works wherever the note lives now', async () => {
    const { id } = await create('Original')
    await save(id, 0, 'Overwritten')
    const ben = await f.a.as.mutation(api.contacts.mutations.create, {
      tenantId: f.a.tenantId,
      ...individual('Babbage'),
    })
    // Stand-in for the future merge-owned `notes.move`.
    await f.t.run((ctx) => ctx.db.patch(id, { contactId: ben }))
    const [first] = await revisionsOf(id)
    await f.a.as.mutation(api.contacts.mutations.restoreRevision, {
      tenantId: f.a.tenantId,
      revisionId: first._id,
    })
    expect(await noteDoc(id)).toMatchObject({
      contactId: ben,
      body: 'Original',
    })
  })

  test('forContact reports truncation past 200', async () => {
    await f.t.run(async (ctx) => {
      const c = { db: scopeWriter(ctx, f.a.tenantId), userId: f.a.userId }
      for (let i = 0; i < 201; i++) {
        await executeContract(
          c,
          note,
          { body: `n${i}` },
          { source: 'test', createWith: { contactId: ada } },
        )
      }
    })
    const got = await f.a.as.query(api.contacts.notes.forContact, {
      tenantId: f.a.tenantId,
      id: ada,
    })
    expect(got.notes).toHaveLength(200)
    expect(got.truncated).toBe(true)
    expect(got.notes[0].body).toBe('n200')
  })
})

describe('tenant isolation', () => {
  test('tenant B observes nothing of tenant A and cannot reach its notes', async () => {
    const { id } = await create('A only', true)
    await save(id, 0, 'A only, edited')
    await setArchived(id, true)
    await setArchived(id, false)
    expect(await snapshot(f.t, f.b.tenantId)).toBe(bSnapshot)

    // A note in B against A's contact is rejected.
    const onA = await errorData(
      f.b.as.mutation(api.contacts.notes.create, {
        tenantId: f.b.tenantId,
        contactId: ada,
        body: 'Cross-tenant',
      }),
    )
    expect(onA).toMatchObject({ kind: 'rejected', reason: 'unknown_contact' })

    // B sees none of A's notes, and can't edit, pin or archive them.
    expect(
      await f.b.as.query(api.contacts.notes.forContact, {
        tenantId: f.b.tenantId,
        id: ada,
      }),
    ).toEqual({ notes: [], truncated: false })
    for (const call of [
      f.b.as.mutation(api.contacts.notes.save, {
        tenantId: f.b.tenantId,
        id,
        expected: 1,
        body: 'Hijack',
      }),
      f.b.as.mutation(api.contacts.notes.setPinned, {
        tenantId: f.b.tenantId,
        id,
        pinned: false,
      }),
      f.b.as.mutation(api.contacts.notes.setArchived, {
        tenantId: f.b.tenantId,
        id,
        archived: true,
      }),
    ]) {
      expect((await errorData(call)).kind).toBe('not_found')
    }
    expect(await snapshot(f.t, f.b.tenantId)).toBe(bSnapshot)
    expect((await forAda())[0].body).toBe('A only, edited')

    // B's member cannot call into A's tenant at all.
    const forbidden = await errorData(
      f.b.as.query(api.contacts.notes.forContact, {
        tenantId: f.a.tenantId,
        id: ada,
      }),
    )
    expect(forbidden.kind).toBe('forbidden')
  })
})
