/**
 * A1's reads and writes on the Rust API: identifier types, a contact's
 * notes, its email context ("also used by" and holds) and a hold's
 * release. Each write shows its answer or refetches what it changed;
 * other people's changes arrive through the event stream (`../events.ts`). Nothing here is
 * optimistic: what shows is what the server answered.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Id } from '../../domain/ids'
import type { Note } from '../../domain/contacts'
import { useTenant } from '../../tenant'
import type { ContactView, EmailContext, IdentifierType } from '../types'
import type { EmailContext as WireEmailContext } from '../rust-types/EmailContext'
import type { Executed } from '../rust-types/Executed'
import type { IdentifierType as WireIdentifierType } from '../rust-types/IdentifierType'
import type { IdentifierTypeSaved } from '../rust-types/IdentifierTypeSaved'
import type { NoteSaved } from '../rust-types/NoteSaved'
import type { NoteView } from '../rust-types/NoteView'
import type { NotesPage } from '../rust-types/NotesPage'
import { showAnswer } from '../events'
import { get, post, postWrite, tenantPath } from './client'
import { keys } from './keys'

// ── identifier types ───────────────────────────────────────────────────────

const identifierType = (t: WireIdentifierType): IdentifierType => ({
  _id: t.id as Id<'identifierTypes'>,
  name: t.name,
  isActive: t.isActive,
  saveVersion: t.saveVersion,
})

/** Every identifier type, archived ones included, alphabetical. */
export function useIdentifierTypes(): Array<IdentifierType> | undefined {
  const { slug } = useTenant()
  return useQuery({
    queryKey: keys.identifierTypes(slug),
    queryFn: async () =>
      (
        await get<Array<WireIdentifierType>>(
          tenantPath(slug, 'identifier-types'),
          new URLSearchParams({ includeInactive: 'true' }),
        )
      ).map(identifierType),
  }).data
}

/**
 * Create a type (no `id`), or rename / archive / reactivate one against
 * the `expected` version it was read at. The answer carries every type,
 * which the page shows from it; the type's event refetches the contacts
 * (a rename shows on each holding it). Throws the `RustApiError`.
 */
export function useSaveIdentifierType() {
  const { slug } = useTenant()
  const qc = useQueryClient()
  return async (args: {
    id?: Id<'identifierTypes'>
    expected?: number
    name: string
    isActive: boolean
  }): Promise<Executed> => {
    try {
      const { id, counter } = await showAnswer(
        qc,
        slug,
        () =>
          postWrite<IdentifierTypeSaved>(
            tenantPath(slug, 'identifier-types'),
            args,
          ),
        (saved) => [
          [keys.identifierTypes(slug), saved.types.map(identifierType)],
        ],
      )
      return { id, counter }
    } catch (e) {
      // Refused (another admin's change won): show the types as they are.
      void qc.invalidateQueries({ queryKey: keys.identifierTypes(slug) })
      throw e
    }
  }
}

// ── email context ──────────────────────────────────────────────────────────

/**
 * The saved addresses' "also used by" and holds, asked for after the
 * contact (advisory: never on a save's path). Keyed by the saved
 * addresses too, so a save that changes them asks again.
 */
export function useEmailContext(
  id: Id<'contacts'>,
  emails: ContactView['emails'],
): EmailContext {
  const { slug } = useTenant()
  const addresses = emails.map((e) => e.address).join('\n')
  const data = useQuery({
    queryKey: [...keys.emailContext(slug, id), addresses],
    queryFn: () =>
      get<WireEmailContext>(tenantPath(slug, 'contacts', id, 'email-context')),
    // The last answer stays while the next loads: a warning or a badge
    // shouldn't blink on every save.
    placeholderData: (previous) => previous,
  }).data
  return {
    alsoUsedBy: data?.alsoUsedBy,
    held: data?.held,
  }
}

/** Release a held address (admins only). Throws the `RustApiError`. */
export function useRelease() {
  const { slug } = useTenant()
  const qc = useQueryClient()
  return async (args: { address: string; expected: number; note: string }) => {
    try {
      return await post<Executed>(tenantPath(slug, 'comms', 'release'), args)
    } finally {
      // The hold belongs to the address: every contact using it.
      void qc.invalidateQueries({ queryKey: keys.emailContext(slug) })
    }
  }
}

// ── notes ──────────────────────────────────────────────────────────────────

export type { Note }

function noteFromWire(n: NoteView): Note {
  return {
    _id: n.id as Id<'contactNotes'>,
    _creationTime: n.createdAt,
    contactId: n.contactId as Id<'contacts'>,
    body: n.body,
    pinned: n.pinned,
    archived: n.archived,
    // Platform user ids; `useMembers` names them.
    createdBy: (n.createdBy === null ? undefined : String(n.createdBy)) as
      Id<'users'> | undefined,
    editedBy: (n.editedBy === null ? undefined : String(n.editedBy)) as
      Id<'users'> | undefined,
    editedAt: n.editedAt,
    bodyVersion: n.bodyVersion,
    flagsVersion: n.flagsVersion,
  }
}

/**
 * A contact's live notes (pinned first, then newest) or its archived
 * ones (newest first); 'skip' asks for nothing.
 */
export function useNotes(
  contactId: Id<'contacts'>,
  which: 'live' | 'archived' | 'skip',
): { notes: Array<Note>; truncated: boolean } | undefined {
  const { slug } = useTenant()
  const archived = which === 'archived'
  return useQuery({
    queryKey: keys.notes(slug, contactId, archived),
    enabled: which !== 'skip',
    queryFn: async () => {
      const page = await get<NotesPage>(
        archived
          ? tenantPath(slug, 'contacts', contactId, 'notes', 'archived')
          : tenantPath(slug, 'contacts', contactId, 'notes'),
      )
      return { notes: page.notes.map(noteFromWire), truncated: page.truncated }
    },
  }).data
}

/** A contact's notes list as `useNotes` holds it. */
const notesPage = (page: NotesPage) => ({
  notes: page.notes.map(noteFromWire),
  truncated: page.truncated,
})

/**
 * The notes panel's writes. Each answers the note and its contact's two
 * lists, which the panel shows from the answer (`showAnswer`: one round
 * trip, no refetch); failures throw the `RustApiError`.
 */
export function useNoteActions() {
  const { slug } = useTenant()
  const qc = useQueryClient()
  const run = async (path: Array<string>, body: unknown) => {
    try {
      return await showAnswer(
        qc,
        slug,
        () => postWrite<NoteSaved>(tenantPath(slug, ...path), body),
        ({ note, live, archived }) => [
          [keys.notes(slug, note.contactId, false), notesPage(live)],
          [keys.notes(slug, note.contactId, true), notesPage(archived)],
        ],
      )
    } catch (e) {
      // Refused (a stale save): show the notes as they are now.
      void qc.invalidateQueries({ queryKey: keys.notes(slug) })
      throw e
    }
  }
  return {
    create: async (args: {
      contactId: Id<'contacts'>
      body: string
      pinned: boolean
    }) => (await run(['notes'], args)).note,
    save: async (args: {
      id: Id<'contactNotes'>
      expected: number
      body: string
    }) => {
      const { note: n } = await run(['notes', args.id, 'save'], {
        expected: args.expected,
        body: args.body,
      })
      return { id: n.id, counter: n.bodyVersion }
    },
    setPinned: async (args: { id: Id<'contactNotes'>; pinned: boolean }) =>
      (await run(['notes', args.id, 'pin'], { value: args.pinned })).note,
    setArchived: async (args: { id: Id<'contactNotes'>; archived: boolean }) =>
      (await run(['notes', args.id, 'archive'], { value: args.archived })).note,
  }
}
