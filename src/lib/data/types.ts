/**
 * The contacts pages' data interface (rust spike, step 2b): what each hook
 * in `src/lib/data` answers, whichever backend is behind it. The shapes are
 * the ones the pages rendered from Convex before the seam; the Rust side
 * adapts its JSON into them (`rust/wire.ts`).
 */
import type { QueryClient } from '@tanstack/react-query'
import type { ConvexReactClient } from 'convex/react'
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
 * in order. `current` reads the form's state as it is now. Convex answers
 * one `saved` or `failed`; Rust turns a 409 `stale` into `saved` +
 * `server`, so the reducer merges the slice's current state and queues
 * the retry itself (rust/save.ts).
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
  /** A source code version, Convex only. */
  acquisitionCodeId?: Id<'sourceCodes'>,
) => Promise<CreateOutcome>

/** The saved addresses' "also used by" and holds (Convex only). */
export type EmailContext = {
  alsoUsedBy: Parameters<typeof contactWarnings>[1]
  held: Held | undefined
}

/** An identifier type, archived ones included (Convex only). */
export type IdentifierType = FunctionReturnType<
  typeof api.contacts.queries.listIdentifierTypes
>[number]

/**
 * The router context route loaders get (`__root.tsx`): each backend uses
 * its own client. The other one is never constructed in that build.
 */
export type Loaders = { convex: ConvexReactClient; queryClient: QueryClient }
