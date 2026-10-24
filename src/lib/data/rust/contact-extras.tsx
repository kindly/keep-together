/**
 * A1's reads and writes on the Rust API: identifier types, a contact's
 * notes, its email context ("also used by" and holds) and a hold's
 * release. Each write refetches what it changed; other people's changes
 * arrive through the event stream (`../events.ts`). Nothing here is
 * optimistic: what shows is what the server answered.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Doc, Id } from '../../../../convex/_generated/dataModel'
import { useTenant } from '../../tenant'
import type { ContactView, EmailContext, IdentifierType } from '../types'
import type { EmailContext as WireEmailContext } from '../rust-types/EmailContext'
import type { Executed } from '../rust-types/Executed'
import type { IdentifierType as WireIdentifierType } from '../rust-types/IdentifierType'
import type { NoteView } from '../rust-types/NoteView'
import type { NotesPage } from '../rust-types/NotesPage'
import { get, post, tenantPath } from './client'
import { keys } from './keys'

// ── identifier types ───────────────────────────────────────────────────────

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
      ).map((t) => ({
        _id: t.id as Id<'identifierTypes'>,
        name: t.name,
        isActive: t.isActive,
        saveVersion: t.saveVersion,
      })),
  }).data
}

/**
 * Create a type (no `id`), or rename / archive / reactivate one against
 * the `expected` version it was read at. Throws the `RustApiError`.
 */
export function useSaveIdentifierType() {
  const { slug } = useTenant()
  const qc = useQueryClient()
  return async (args: {
    id?: Id<'identifierTypes'>
    expected?: number
    name: string
    isActive: boolean
  }) => {
    try {
      return await post<Executed>(tenantPath(slug, 'identifier-types'), args)
    } finally {
      // A rename shows on every contact holding the type.
      void qc.invalidateQueries({ queryKey: keys.identifierTypes(slug) })
      void qc.invalidateQueries({ queryKey: keys.contacts(slug) })
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

/** A note in the shape the notes panel renders (Convex's document). */
export type Note = Doc<'contactNotes'>

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
      | Id<'users'>
      | undefined,
    editedBy: (n.editedBy === null ? undefined : String(n.editedBy)) as
      | Id<'users'>
      | undefined,
    editedAt: n.editedAt,
    bodyVersion: n.bodyVersion,
    flagsVersion: n.flagsVersion,
  } as Note
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

/**
 * The notes panel's writes. Each answers the note as it is now and
 * refetches the lists; failures throw the `RustApiError`.
 */
export function useNoteActions() {
  const { slug } = useTenant()
  const qc = useQueryClient()
  const run = async (path: Array<string>, body: unknown) => {
    try {
      return await post<NoteView>(tenantPath(slug, ...path), body)
    } finally {
      void qc.invalidateQueries({ queryKey: keys.notes(slug) })
    }
  }
  return {
    create: (args: {
      contactId: Id<'contacts'>
      body: string
      pinned: boolean
    }) => run(['notes'], args),
    save: async (args: {
      id: Id<'contactNotes'>
      expected: number
      body: string
    }) => {
      const n = await run(['notes', args.id, 'save'], {
        expected: args.expected,
        body: args.body,
      })
      return { id: n.id, counter: n.bodyVersion }
    },
    setPinned: (args: { id: Id<'contactNotes'>; pinned: boolean }) =>
      run(['notes', args.id, 'pin'], { value: args.pinned }),
    setArchived: (args: { id: Id<'contactNotes'>; archived: boolean }) =>
      run(['notes', args.id, 'archive'], { value: args.archived }),
  }
}
