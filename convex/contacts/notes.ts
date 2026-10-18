/**
 * Contact notes: one `contactNotes` root per note, written only through
 * two contracts that partition it: `contacts.note` (body, `bodyVersion`)
 * and `contacts.noteFlags` (pinned + archived, `flagsVersion`). A pin never
 * makes a body edit stale. Toggles are built from the note's fresh flags
 * inside the transaction, so they need no `expected`.
 */
import { ConvexError, v } from 'convex/values'
import type { Doc, Id } from '../_generated/dataModel'
import { commandGroup, executeContract } from '../lib/contracts'
import type { CommandGroup, ContractCtx } from '../lib/contracts'
import { tenantMutation, tenantQuery } from '../lib/tenancy'
import type { ScopedDatabaseReader } from '../lib/tenancy'
import { note, noteFlags } from './contracts'
import { noteCreateFields, noteFields } from './validators'

const LIMIT = 200

/** One section of a contact's live notes, newest first. */
function liveSection(
  db: ScopedDatabaseReader,
  contactId: Id<'contacts'>,
  pinned: boolean,
  limit: number,
) {
  return db
    .query('contactNotes')
    .withIndex('by_tenant_contact_archived_pinned', (q) =>
      q.eq('contactId', contactId).eq('archived', false).eq('pinned', pinned),
    )
    .order('desc')
    .take(limit)
}

/** At most LIMIT notes; `truncated` when there were more. */
function capped(notes: Array<Doc<'contactNotes'>>) {
  return { notes: notes.slice(0, LIMIT), truncated: notes.length > LIMIT }
}

/** Live notes: pinned first, then the rest, each newest first. */
export const forContact = tenantQuery({
  args: { id: v.id('contacts') },
  handler: async (ctx, { id }) => {
    // One row past the cap tells us whether anything was cut off. The
    // sections are read one after the other on purpose: reading both at
    // LIMIT + 1 concurrently would be ~2.5 ms faster but could read 402
    // notes, past what NOTE_MAX_BYTES is sized for (rules.ts).
    const pinned = await liveSection(ctx.db, id, true, LIMIT + 1)
    const room = LIMIT + 1 - pinned.length
    const rest = room > 0 ? await liveSection(ctx.db, id, false, room) : []
    return capped([...pinned, ...rest])
  },
})

/** Archived notes, newest first, so they can be restored. */
export const archivedForContact = tenantQuery({
  args: { id: v.id('contacts') },
  handler: async (ctx, { id }) =>
    capped(
      await ctx.db
        .query('contactNotes')
        .withIndex('by_tenant_contact_archived', (q) =>
          q.eq('contactId', id).eq('archived', true),
        )
        .order('desc')
        .take(LIMIT + 1),
    ),
})

export const create = tenantMutation({
  args: { ...noteCreateFields, ...noteFields, pinned: v.optional(v.boolean()) },
  handler: async (ctx, { contactId, body, pinned }) => {
    const group = pinned
      ? await commandGroup(ctx, 'add pinned note')
      : undefined
    const created = await executeContract(
      ctx,
      note,
      { body },
      { source: 'ui', createWith: { contactId }, group },
    )
    if (pinned) await setFlag(ctx, created.id, 'pinned', true, group)
    return created
  },
})

/** Edit the text. Stale only if the text changed since `expected`. */
export const save = tenantMutation({
  args: { id: v.id('contactNotes'), expected: v.number(), ...noteFields },
  handler: async (ctx, { id, expected, body }) =>
    executeContract(
      ctx,
      note,
      { body },
      { entityId: id, expected, source: 'ui' },
    ),
})

async function setFlag(
  ctx: ContractCtx,
  id: Id<'contactNotes'>,
  flag: 'pinned' | 'archived',
  value: boolean,
  group?: CommandGroup,
) {
  const n = await ctx.db.get(id)
  if (!n) throw new ConvexError({ kind: 'not_found' as const })
  // No-op toggles leave no revision and no counter bump.
  if (n[flag] === value) return { id, counter: n.flagsVersion }
  return executeContract(
    ctx,
    noteFlags,
    { pinned: n.pinned, archived: n.archived, [flag]: value },
    { entityId: id, source: 'ui', group },
  )
}

export const setPinned = tenantMutation({
  args: { id: v.id('contactNotes'), pinned: v.boolean() },
  handler: async (ctx, { id, pinned }) => setFlag(ctx, id, 'pinned', pinned),
})

/** Remove = archive (hidden from `forContact`); `false` restores it. */
export const setArchived = tenantMutation({
  args: { id: v.id('contactNotes'), archived: v.boolean() },
  handler: async (ctx, { id, archived }) =>
    setFlag(ctx, id, 'archived', archived),
})
