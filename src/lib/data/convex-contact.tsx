/**
 * The contact page and the new-contact form on Convex: today's calls,
 * moved here unchanged from the routes and `contact-form.tsx`. The page's
 * queries go through the keep-alive cache (lib/query-cache); the saved
 * addresses' lookups don't (their args change with every email edit).
 */
import { useAuthActions } from '@convex-dev/auth/react'
import { useConvex, useMutation, useQuery as useLiveQuery } from 'convex/react'
import { ConvexError } from 'convex/values'
import { useMemo, useRef } from 'react'
import type { Id } from '../../../convex/_generated/dataModel'
import { api } from '../../../convex/_generated/api'
import { assembleView } from '../../../convex/contacts/view'
import type { SourceCodeDescription } from '../../../convex/sources/code'
import { useHistoryHold } from '../../components/contact-history'
import type { SaveResult, SliceName } from '../contact-form-state'
import { seedContact } from '../contact-seed'
import { useQuery } from '../query-cache'
import { cachedTenant, useTenant } from '../tenant'
import type {
  ContactView,
  CreateContact,
  EmailContext,
  FieldDefinition,
  IdentifierType,
  Loaders,
  Member,
  SaveContactForm,
} from './types'

export {
  AuthLoading as SessionLoading,
  Authenticated as SignedIn,
  Unauthenticated as SignedOut,
} from 'convex/react'
export { MyTenantsProvider, useMyTenants } from '../tenant'

export function useSignOut() {
  return useAuthActions().signOut
}

const SLICE_QUERIES = [
  api.contacts.queries.getRoot,
  api.contacts.queries.getChannels,
  api.contacts.queries.getIdentifiers,
] as const

/**
 * Every query the page subscribes to, at once, as the navigation starts
 * (or on hover), not one waterfall step per component as they mount.
 * Not `history`: it is fetched, never subscribed (ContactHistory), and a
 * prewarm would hold a subscription that every save then waits on.
 */
export function preloadContact({ convex }: Loaders, slug: string, id: string) {
  const tenant = cachedTenant(convex, slug)
  if (!tenant) return
  const args = { tenantId: tenant._id, id: id as Id<'contacts'> }
  for (const query of SLICE_QUERIES) convex.prewarmQuery({ query, args })
  convex.prewarmQuery({
    query: api.contacts.queries.listIdentifierTypes,
    args: { tenantId: tenant._id, includeInactive: true },
  })
  convex.prewarmQuery({ query: api.contacts.notes.forContact, args })
  convex.prewarmQuery({
    query: api.platform.tenants.members,
    args: { tenantId: tenant._id },
  })
  convex.prewarmQuery({
    query: api.contacts.fields.list,
    args: { tenantId: tenant._id },
  })
}

/**
 * The contact's view and the tenant's field definitions. The definitions
 * name the contact's values and are the form's dropdowns: one
 * subscription for both.
 */
export function useContact(id: Id<'contacts'>): {
  view: ContactView | null | undefined
  fields: Array<FieldDefinition> | undefined
} {
  const tenant = useTenant()
  const fields = useQuery(api.contacts.fields.list, { tenantId: tenant._id })
  const view = useContactView(tenant._id, id, fields)
  return { view, fields }
}

/**
 * `get`'s view, assembled from one query per slice, so a save re-runs (and
 * waits for) only the slices it wrote plus the root, not the whole view.
 * The parts come from one consistent snapshot: Convex applies a save's
 * re-runs in a single transition. The form doesn't rely on that alone: a
 * slice's rows arriving apart from its counter are still merged (`server`
 * in contact-form-state). Undefined until every part has answered, null
 * when there is no such contact (in this tenant).
 */
function useContactView(
  tenantId: Id<'tenants'>,
  id: Id<'contacts'>,
  fields: Array<FieldDefinition> | undefined,
): ContactView | null | undefined {
  const args = { tenantId, id }
  const root = useQuery(api.contacts.queries.getRoot, args)
  const channels = useQuery(api.contacts.queries.getChannels, args)
  const identifiers = useQuery(api.contacts.queries.getIdentifiers, args)
  // By the code's id, not the contact's, so a contact save doesn't re-run
  // it; an uncoded contact subscribes to nothing.
  const codeId = root?.acquisitionCodeId
  const described = useQuery(
    api.contacts.queries.getAcquisition,
    codeId ? { tenantId, codeId } : 'skip',
  )
  // The code's description last shown on this contact. A save that
  // changes the code moves the root a moment before the new description
  // may answer (the picker subscribes to it before saving, so usually
  // not): meanwhile the page keeps the last one rather than dropping to
  // "Loading…". Only the description is held, never the root or other
  // slices, so counters stay current; the picker shows its pending code
  // until the description catches up with the root (ContactAcquisition).
  const lastAcquisition = useRef<{
    id: Id<'contacts'>
    acquisition: SourceCodeDescription | null
  } | null>(null)
  const live = codeId ? described : null
  if (live !== undefined) lastAcquisition.current = { id, acquisition: live }
  const acquisition =
    live === undefined && lastAcquisition.current?.id === id
      ? lastAcquisition.current.acquisition
      : live
  // Shared with the form's type picker (archived types included).
  const types = useQuery(api.contacts.queries.listIdentifierTypes, {
    tenantId,
    includeInactive: true,
  })
  return useMemo(() => {
    if (root === null) return null
    if (
      root === undefined ||
      channels === undefined ||
      identifiers === undefined ||
      acquisition === undefined ||
      types === undefined ||
      fields === undefined
    )
      return undefined
    return assembleView({
      root,
      channels,
      identifiers,
      types,
      acquisition,
      fields,
    })
  }, [root, channels, identifiers, acquisition, types, fields])
}

export function useMembers(): Array<Member> | undefined {
  return useQuery(api.platform.tenants.members, {
    tenantId: useTenant()._id,
  })
}

/**
 * Archived types too: the page names the contact's rows from the same
 * subscription. The picker offers active ones only, and a row of an
 * archived one names its type from `data.identifiers`.
 */
export function useIdentifierTypes(): Array<IdentifierType> | undefined {
  return useQuery(api.contacts.queries.listIdentifierTypes, {
    tenantId: useTenant()._id,
    includeInactive: true,
  })
}

export function useEmailContext(
  id: Id<'contacts'>,
  emails: ContactView['emails'],
): EmailContext {
  const tenant = useTenant()
  // "Also used by" lookups for the saved addresses: their own query, so a
  // save never waits on them; a new address's warning lands one round trip
  // after the save. Until the new answer comes, the last one stands: an
  // email row's address never changes under its key (ADR 0014). Not
  // cached: its args change with every email edit, so each edit would
  // leave an idle entry behind and fill the cache with stale address lists.
  const sharedNow = useLiveQuery(
    api.contacts.queries.sharedAddresses,
    emails.length === 0
      ? 'skip'
      : {
          tenantId: tenant._id,
          id,
          emails: emails.map((e) => ({ key: e.key, address: e.address })),
        },
  )
  const sharedLast = useRef(sharedNow)
  if (sharedNow !== undefined) sharedLast.current = sharedNow
  // Holds on the saved addresses (comms suppressions, ADR 0021), not
  // cached for the same reason. Keyed by address, so a row shows its hold
  // whichever contact it is on; the last answer stands meanwhile, so
  // removing and re-adding a held address still shows it held.
  const heldNow = useLiveQuery(
    api.comms.suppressions.held,
    emails.length === 0
      ? 'skip'
      : {
          tenantId: tenant._id,
          addresses: emails.map((e) => e.address),
        },
  )
  const heldLast = useRef(heldNow)
  if (heldNow !== undefined) heldLast.current = heldNow
  return {
    alsoUsedBy: sharedNow ?? sharedLast.current,
    held: heldNow ?? heldLast.current,
  }
}

export function useSaveContactForm(id: Id<'contacts'>): SaveContactForm {
  const tenant = useTenant()
  const saveForm = useMutation(api.contacts.mutations.saveForm)
  const history = useHistoryHold(id)
  return async (submitted, current) => {
    const state = current()
    const args: Record<string, unknown> = {
      tenantId: tenant._id,
      id,
      source: 'autosave',
    }
    for (const [slice, payload] of Object.entries(submitted)) {
      args[slice] = {
        expected: state.counters[slice as SliceName],
        ...payload,
      }
    }
    // No history fetch may be subscribed when the save commits, or "saved"
    // would wait on its run too.
    history.hold()
    try {
      const result: SaveResult = await saveForm(args as never)
      return [{ type: 'saved', submitted, result, at: Date.now() }]
    } catch (err) {
      const detail =
        err instanceof ConvexError
          ? (err.data as Record<string, unknown>)
          : null
      return [
        {
          type: 'failed',
          message: detail
            ? String(detail.message ?? detail.kind)
            : 'Could not save',
        },
      ]
    } finally {
      history.release()
    }
  }
}

export function useCreateContact(): CreateContact {
  const tenant = useTenant()
  const create = useMutation(api.contacts.mutations.create)
  // Minted once per form: a double submit lands on the existing contact.
  const clientKey = useMemo(() => crypto.randomUUID(), [])
  // Watch for the contact this form creates: it arrives with the create's
  // result, so the contact page can render without a second round trip.
  const convex = useConvex()
  const watchArgs = { tenantId: tenant._id, clientKey }
  useLiveQuery(api.contacts.queries.byClientKey, watchArgs)
  const seeded = (id: Id<'contacts'>) => {
    const view = convex
      .watchQuery(api.contacts.queries.byClientKey, watchArgs)
      .localQueryResult()
    if (view?.contact._id === id) seedContact(id, view)
    return { type: 'created' as const, id }
  }
  return async (details, acquisitionCodeId) => {
    try {
      return seeded(
        await create({
          tenantId: tenant._id,
          clientKey,
          ...details,
          ...(acquisitionCodeId && { acquisitionCodeId }),
        }),
      )
    } catch (err) {
      const data =
        err instanceof ConvexError
          ? (err.data as Record<string, unknown>)
          : null
      if (data?.kind === 'invalid')
        return {
          type: 'invalid',
          problems: data.problems as Array<{ field: string; message: string }>,
        }
      if (data?.kind === 'rejected' && data.reason === 'duplicate')
        return seeded(String(data.message) as Id<'contacts'>)
      return {
        type: 'failed',
        message: data ? String(data.message ?? data.kind) : 'Could not save',
      }
    }
  }
}
