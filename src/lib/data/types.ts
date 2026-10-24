/**
 * The contacts pages' data interface: what each hook in `src/lib/data`
 * answers. The shapes are the ones the pages rendered from Convex before
 * the port (its types are read-only reference until cutover); the Rust
 * API's JSON is adapted into them (`rust/wire.ts`).
 */
import type { QueryClient } from '@tanstack/react-query'
import type { FunctionArgs, FunctionReturnType } from 'convex/server'
import type { api } from '../../../convex/_generated/api'
import type { Id } from '../../../convex/_generated/dataModel'
import type { Payloads } from '../../../convex/contacts/validators'
import type { FieldDefinition } from '../../../convex/contacts/fieldTypes'
import type { Action, FormState, Slices } from '../contact-form-state'
import type { Held } from '../email-hold'
import type { contactWarnings } from '../../../convex/contacts/warnings'

export type { ContactView } from '../contact-seed'
export type { FieldDefinition }
export type { ListFilters, ListRow, PagedList } from '../paged-list'

export type SearchArgs = FunctionArgs<typeof api.contacts.queries.search>

export type SearchResult = FunctionReturnType<
  typeof api.contacts.queries.search
>

/** A tenant member, as the form and history name who made a change. */
export type Member = { userId: Id<'users'>; name: string }

/**
 * The form's save: submits `submitted` (the dirty slices, against the
 * counters the form holds) and answers the reducer actions to dispatch,
 * in order. `current` reads the form's state as it is now. A stale slice
 * answers `saved` + `server`, so the reducer merges the slice's current
 * state and queues the retry itself (rust/save.ts).
 */
export type SaveContactForm = (
  submitted: Partial<Slices>,
  current: () => FormState,
) => Promise<Array<Action>>

/** What a create answers the new-contact page. */
export type CreateOutcome =
  | { type: 'created'; id: Id<'contacts'> }
  | { type: 'invalid'; problems: Array<{ field: string; message: string }> }
  | { type: 'failed'; message: string }

export type CreateContact = (
  details: Payloads['details'],
  /** A source code version, set in the same command group. */
  acquisitionCodeId?: Id<'sourceCodes'>,
) => Promise<CreateOutcome>

/** The saved addresses' "also used by" and holds (`email-context`). */
export type EmailContext = {
  alsoUsedBy: Parameters<typeof contactWarnings>[1]
  held: Held | undefined
}

/** An identifier type, archived ones included. */
export type IdentifierType = {
  _id: Id<'identifierTypes'>
  name: string
  isActive: boolean
  saveVersion: number
}

/** The router context route loaders get (`__root.tsx`). */
export type Loaders = { queryClient: QueryClient }
