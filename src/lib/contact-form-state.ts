/**
 * Pure state for the live contact form (ADR 0017 spike 4).
 *
 * `base` is the server state each slice was last reconciled against,
 * `local` is what the user sees and edits. A server update merges per field
 * into dirty slices (three-way) and replaces clean ones; our own save
 * coming back is recognised by counters and ignored. Saves submit only
 * dirty slices with their `expected` counters; the server diffs again and
 * reports invalid / stale slices while saving the rest.
 */
import type { Id } from '../../convex/_generated/dataModel'
import type { Payloads } from '../../convex/contacts/validators'
import { same, threeWayMerge } from './merge'
import type { Unsaved } from './unsaved'

export type SliceName =
  'details' | 'methods' | 'addresses' | 'tags' | 'identifiers'
export type Slices = {
  details: Payloads['details']
  methods: Payloads['methods']
  addresses: Payloads['addresses']
  tags: Payloads['tags']
  identifiers: Payloads['identifiers']
}
export type Counters = Record<SliceName, number>
/**
 * A blocking problem. An identifier clash names its row (`key`, minted
 * here so it matches) and the contact already holding the value.
 */
export type Problem = {
  field: string
  message: string
  key?: string
  contactId?: Id<'contacts'>
}

export const SLICES: Array<SliceName> = [
  'details',
  'methods',
  'addresses',
  'tags',
  'identifiers',
]

export type FormState = {
  base: Slices
  local: Slices
  counters: Counters
  dirty: Record<SliceName, boolean>
  /** `slice.field` pairs changed by both sides; local value kept. */
  conflicts: Array<string>
  problems: Partial<Record<SliceName, Array<Problem>>>
  /** Slices someone else changed since we loaded them (their counter). */
  stale: Partial<Record<SliceName, number>>
  status: 'idle' | 'saving' | 'saved' | 'error'
  savedAt: number | null
  needsSave: boolean
  error: string | null
}

export type SaveResult = {
  saved: Array<SliceName>
  problems: Partial<Record<SliceName, Array<Problem>>>
  stale: Partial<Record<SliceName, number>>
  counters: Counters & { archive: number }
}

export type Action =
  | { type: 'server'; slices: Slices; counters: Counters }
  | { type: 'edit'; slice: SliceName; value: Slices[SliceName] }
  /** The user finished an edit (blur, select, checkbox, remove): request a save. */
  | { type: 'commit' }
  | { type: 'saving' }
  | {
      type: 'saved'
      submitted: Partial<Slices>
      result: SaveResult
      at: number
    }
  | { type: 'failed'; message: string }

/**
 * Rows the user has added but not filled in are not part of the command
 * (ngo-go's rule): an email with no address, a phone with no number, an
 * address with no first line, an identifier without both a type and a
 * value stay on screen but are never submitted.
 */
export function clean<TSlice extends SliceName>(
  slice: TSlice,
  value: Slices[TSlice],
): Slices[TSlice] {
  if (slice === 'methods') {
    const m = value as Slices['methods']
    return {
      emails: m.emails.filter((e) => e.address.trim() !== ''),
      phones: m.phones.filter((p) => p.number.trim() !== ''),
    } as Slices[TSlice]
  }
  if (slice === 'identifiers') {
    const i = value as Slices['identifiers']
    return {
      identifiers: i.identifiers.filter(
        (r) => (r.typeId as string) !== '' && r.value.trim() !== '',
      ),
    } as Slices[TSlice]
  }
  if (slice === 'addresses') {
    const a = value as Slices['addresses']
    return {
      addresses: a.addresses.filter((r) => r.line1.trim() !== ''),
    } as Slices[TSlice]
  }
  return value
}

/**
 * An identity field (email address, phone number) edited on a saved row
 * becomes a new row: the key is replaced at commit time, so the server
 * sees remove + add (ADR 0014) and the input is not remounted mid-typing.
 */
export function rekey(
  base: Slices['methods'],
  local: Slices['methods'],
  mint: () => string,
): Slices['methods'] {
  const baseEmails = new Map(base.emails.map((e) => [e.key, e]))
  const basePhones = new Map(base.phones.map((p) => [p.key, p]))
  return {
    emails: local.emails.map((e) => {
      const saved = e.key ? baseEmails.get(e.key) : undefined
      return saved && saved.address !== e.address ? { ...e, key: mint() } : e
    }),
    phones: local.phones.map((p) => {
      const saved = p.key ? basePhones.get(p.key) : undefined
      return saved && saved.number !== p.number ? { ...p, key: mint() } : p
    }),
  }
}

/**
 * Tags merge as a set, not per field: our adds and removes (local against
 * base) are replayed onto the remote rows, so two people tagging one
 * contact never conflict. A tag both sides added keeps the remote row.
 */
export function mergeTags(
  base: Slices['tags'],
  local: Slices['tags'],
  remote: Slices['tags'],
): Slices['tags'] {
  const had = new Set(base.tags.map((t) => t.tagId))
  const has = new Set(local.tags.map((t) => t.tagId))
  const removed = new Set([...had].filter((id) => !has.has(id)))
  const kept = remote.tags.filter((t) => !removed.has(t.tagId))
  const present = new Set(kept.map((t) => t.tagId))
  const added = local.tags.filter(
    (t) => !had.has(t.tagId) && !present.has(t.tagId),
  )
  return { tags: [...kept, ...added] }
}

/**
 * Identifier rows are immutable per key, so they merge as a set of rows
 * like tags: our adds and removes are replayed onto the remote rows.
 */
export function mergeIdentifiers(
  base: Slices['identifiers'],
  local: Slices['identifiers'],
  remote: Slices['identifiers'],
): Slices['identifiers'] {
  const had = new Set(base.identifiers.map((r) => r.key))
  const has = new Set(local.identifiers.map((r) => r.key))
  const kept = remote.identifiers.filter(
    (r) => has.has(r.key) || !had.has(r.key),
  )
  const present = new Set(kept.map((r) => r.key))
  const added = local.identifiers.filter(
    (r) => !had.has(r.key) && !present.has(r.key),
  )
  return { identifiers: [...kept, ...added] }
}

/**
 * Per-field merge of the rows that would be submitted. base never holds
 * unfilled rows (`submission` cleans), so merging raw local would read a
 * blank row left on screen as a local change to its whole list, and the
 * retry would overwrite the remote rows. The unfilled rows ride along at
 * the end of their lists.
 */
function mergeFilled<TSlice extends SliceName>(
  slice: TSlice,
  base: Slices[TSlice],
  local: Slices[TSlice],
  remote: Slices[TSlice],
): { value: Slices[TSlice]; conflicts: Array<string> } {
  const filled = clean(slice, local) as Record<string, unknown>
  const merged = threeWayMerge(
    base as Record<string, unknown>,
    filled,
    remote as Record<string, unknown>,
  )
  const value: Record<string, unknown> = { ...merged.value }
  for (const [field, rows] of Object.entries(
    local as Record<string, unknown>,
  )) {
    if (!Array.isArray(rows)) continue
    const kept = filled[field] as Array<unknown>
    const unfilled = rows.filter((r) => !kept.includes(r))
    if (unfilled.length)
      value[field] = [...(value[field] as Array<unknown>), ...unfilled]
  }
  return { value: value as Slices[TSlice], conflicts: merged.conflicts }
}

/**
 * Identifier rows with a value but no type yet: not submitted (there is
 * nothing to save them as), but typed work all the same.
 */
export function untyped(
  value: Slices['identifiers'],
): Slices['identifiers']['identifiers'] {
  return value.identifiers.filter(
    (r) => (r.typeId as string) === '' && r.value.trim() !== '',
  )
}

function isDirty<TSlice extends SliceName>(
  slice: TSlice,
  local: Slices[TSlice],
  base: Slices[TSlice],
): boolean {
  return !same(clean(slice, local), base)
}

function put<TSlice extends SliceName>(
  slices: Slices,
  slice: TSlice,
  value: Slices[TSlice],
) {
  ;(slices as Record<SliceName, unknown>)[slice] = value
}

export function initialState(slices: Slices, counters: Counters): FormState {
  return {
    base: slices,
    local: slices,
    counters,
    dirty: {
      details: false,
      methods: false,
      addresses: false,
      tags: false,
      identifiers: false,
    },
    conflicts: [],
    problems: {},
    stale: {},
    status: 'idle',
    savedAt: null,
    needsSave: false,
    error: null,
  }
}

export function reduce(state: FormState, action: Action): FormState {
  switch (action.type) {
    case 'server': {
      // Same counters everywhere: same state (or our own save echoing back).
      if (SLICES.every((s) => action.counters[s] === state.counters[s]))
        return state
      const next = {
        ...state,
        base: { ...state.base },
        local: { ...state.local },
        counters: { ...state.counters },
      }
      let conflicts = state.conflicts.filter(
        (c) =>
          !SLICES.some(
            (s) =>
              c.startsWith(`${s}.`) && action.counters[s] !== state.counters[s],
          ),
      )
      let needsSave = state.needsSave
      for (const slice of SLICES) {
        if (action.counters[slice] === state.counters[slice]) continue // same state, or our own save echoing back
        next.counters[slice] = action.counters[slice]
        const remote = action.slices[slice]
        if (!state.dirty[slice]) {
          put(next.base, slice, remote)
          put(next.local, slice, remote)
          continue
        }
        const merged =
          slice === 'tags'
            ? {
                value: mergeTags(
                  state.base.tags,
                  state.local.tags,
                  remote as Slices['tags'],
                ),
                conflicts: [],
              }
            : slice === 'identifiers'
              ? {
                  value: mergeIdentifiers(
                    state.base.identifiers,
                    state.local.identifiers,
                    remote as Slices['identifiers'],
                  ),
                  conflicts: [],
                }
              : mergeFilled(
                  slice,
                  state.base[slice] as never,
                  state.local[slice] as never,
                  remote as never,
                )
        put(next.base, slice, remote)
        put(next.local, slice, merged.value)
        conflicts = [
          ...conflicts,
          ...merged.conflicts.map((f) => `${slice}.${f}`),
        ]
        next.dirty[slice] = isDirty(slice, merged.value, remote)
        if (next.dirty[slice]) needsSave = true // retry the save against the new counter
      }
      // A stale notice is resolved once the newer state has arrived.
      const stale = { ...state.stale }
      for (const slice of SLICES) {
        if (
          stale[slice] !== undefined &&
          action.counters[slice] >= stale[slice]
        )
          delete stale[slice]
      }
      return { ...next, conflicts, stale, needsSave }
    }
    case 'edit': {
      const local = { ...state.local, [action.slice]: action.value }
      const dirty = {
        ...state.dirty,
        [action.slice]: isDirty(
          action.slice,
          action.value,
          state.base[action.slice],
        ),
      }
      // A slice edited back to its saved state submits nothing, so a
      // refusal of it (say, the clashing identifier row removed) is moot.
      const problems = { ...state.problems }
      if (!dirty[action.slice]) delete problems[action.slice]
      return {
        ...state,
        local,
        dirty,
        problems,
        status: state.status === 'saved' ? 'idle' : state.status,
      }
    }
    case 'commit': {
      const methods = rekey(state.base.methods, state.local.methods, () =>
        crypto.randomUUID(),
      )
      const local = { ...state.local, methods }
      const dirty = {
        ...state.dirty,
        methods: isDirty('methods', methods, state.base.methods),
      }
      return {
        ...state,
        local,
        dirty,
        needsSave: state.needsSave || SLICES.some((s) => dirty[s]),
      }
    }
    case 'saving':
      return { ...state, status: 'saving', needsSave: false, error: null }
    case 'saved': {
      const base = { ...state.base }
      const dirty = { ...state.dirty }
      const conflicts = state.conflicts.filter(
        (c) => !action.result.saved.some((s) => c.startsWith(`${s}.`)),
      )
      for (const slice of action.result.saved) {
        const submitted = action.submitted[slice]
        if (!submitted) continue
        base[slice] = submitted as never
        dirty[slice] = isDirty(slice, state.local[slice], submitted as never)
      }
      // Slices the server found unchanged are clean too.
      for (const slice of SLICES) {
        const submitted = action.submitted[slice]
        if (
          submitted &&
          !action.result.saved.includes(slice) &&
          !action.result.problems[slice] &&
          action.result.stale[slice] === undefined
        ) {
          base[slice] = submitted as never
          dirty[slice] = isDirty(slice, state.local[slice], submitted as never)
        }
      }
      // A stale slice keeps its old counter: the newer state has not been
      // seen yet, and the subscription must be allowed to merge it in.
      const counters = { ...state.counters }
      for (const slice of SLICES) {
        if (action.result.stale[slice] === undefined)
          counters[slice] = action.result.counters[slice]
      }
      // An earlier notice is resolved once this save holds the counter it
      // named. The echo of this save carries the same counters and stops at
      // the early return in `server`, so it can't be left to clear it.
      const stale = { ...state.stale }
      for (const slice of SLICES) {
        const was = stale[slice]
        if (was !== undefined && counters[slice] >= was) delete stale[slice]
      }
      Object.assign(stale, action.result.stale)
      return {
        ...state,
        base,
        dirty,
        conflicts,
        counters,
        problems: action.result.problems,
        stale,
        status: 'saved',
        savedAt: action.result.saved.length ? action.at : state.savedAt,
        // Recomputed, not carried over: a commit during the save (the Save
        // click's own blur) queues it, and if this save took everything a
        // queued save submits nothing and would never clear it, leaving
        // the form `busy` and the leave guard waiting forever.
        needsSave: SLICES.some((s) => dirty[s] && !action.result.problems[s]),
        error: null,
      }
    }
    case 'failed':
      return { ...state, status: 'error', error: action.message }
  }
}

/** Which slices a save should submit, without their unfilled rows. */
export function submission(state: FormState): Partial<Slices> {
  const out: Partial<Slices> = {}
  for (const slice of SLICES)
    if (state.dirty[slice])
      out[slice] = clean(slice, state.local[slice]) as never
  return out
}

/**
 * The form's share of the page's unsaved work (lib/unsaved). A save in
 * flight or queued (after a blur, or a stale retry waiting on the merge)
 * settles by itself; a dirty slice with nothing queued is an edit still
 * being typed, or one the server refused or failed to take.
 */
export function unsavedWork(state: FormState): Unsaved {
  if (state.status === 'saving' || state.needsSave) return 'busy'
  return SLICES.some((s) => state.dirty[s]) ||
    untyped(state.local.identifiers).length > 0
    ? 'unsaved'
    : 'clean'
}
