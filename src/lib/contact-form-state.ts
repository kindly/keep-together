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
import { sortValues } from '../../convex/contacts/fieldValues'
import type { Payloads } from '../../convex/contacts/validators'
import { same, threeWayMerge } from './merge'
import type { Unsaved } from './unsaved'

/**
 * A new child row's key, or a create's client key: 32 lower-case hex
 * characters, the only shape the api takes for an id the client chooses
 * (rs/README.md; F1 L5). A v4 UUID without its dashes.
 */
export function newKey(): string {
  return crypto.randomUUID().replaceAll('-', '')
}

export type SliceName =
  'details' | 'methods' | 'addresses' | 'identifiers' | 'fields'
export type Slices = {
  details: Payloads['details']
  methods: Payloads['methods']
  addresses: Payloads['addresses']
  identifiers: Payloads['identifiers']
  fields: Payloads['fields']
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
  'identifiers',
  'fields',
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
  | {
      type: 'server'
      slices: Slices
      counters: Counters
      /** Slices to take although their counter is unchanged (`tornSlices`). */
      torn?: Array<SliceName>
    }
  | { type: 'edit'; slice: SliceName; value: Slices[SliceName] }
  /** The user finished an edit (blur, select, checkbox, remove): request a save. */
  | { type: 'commit' }
  | { type: 'saving' }
  /** A queued save found nothing to submit. */
  | { type: 'nothingToSave' }
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
 * Identifier rows are immutable per key, so they merge as a set of rows:
 * our adds and removes are replayed onto the remote rows, so two people
 * adding identifiers to one contact never conflict.
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
 * Dropdown field values merge per field: a field we set or cleared (local
 * against base) keeps our choice, every other field takes the remote one.
 * A field both sides changed to different values keeps ours and is
 * reported as a conflict (`fields.<fieldId>`). Values stay in field-id
 * order, as the server sorts them.
 */
export function mergeFieldValues(
  base: Slices['fields'],
  local: Slices['fields'],
  remote: Slices['fields'],
): { value: Slices['fields']; conflicts: Array<string> } {
  const of = (s: Slices['fields']) =>
    new Map<string, string>(s.values.map((x) => [x.fieldId, x.optionId]))
  const [was, ours, theirs] = [of(base), of(local), of(remote)]
  const ids = new Set([...was.keys(), ...ours.keys(), ...theirs.keys()])
  const values: Slices['fields']['values'] = []
  const conflicts: Array<string> = []
  for (const fieldId of ids) {
    const mine = ours.get(fieldId) !== was.get(fieldId)
    const chosen = mine ? ours.get(fieldId) : theirs.get(fieldId)
    if (
      mine &&
      theirs.get(fieldId) !== was.get(fieldId) &&
      theirs.get(fieldId) !== ours.get(fieldId)
    )
      conflicts.push(fieldId)
    if (chosen)
      values.push({
        fieldId: fieldId as Slices['fields']['values'][number]['fieldId'],
        optionId: chosen as Slices['fields']['values'][number]['optionId'],
      })
  }
  return { value: { values: sortValues(values) }, conflicts }
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

/**
 * The page assembles its view from one query per slice and relies on
 * Convex delivering a save's re-runs together (one transition, one render),
 * so a slice's rows and its counter on the root arrive at once. If they
 * ever came apart (a torn view), the reducer could take a counter with the
 * old rows and then drop the new rows as "no change", and the next save
 * would overwrite them unseen. So a slice whose rows changed while its
 * counter stayed where the previous delivery had it is a remote change
 * too: these are the slices to pass as `torn`. Our own save's echo can't
 * look like that: the delivery before it still had the old counter.
 */
export function tornSlices(
  previous: { slices: Slices; counters: Counters },
  delivered: { slices: Slices; counters: Counters },
): Array<SliceName> {
  return SLICES.filter(
    (s) =>
      delivered.counters[s] === previous.counters[s] &&
      !sameRows(delivered.slices[s], previous.slices[s]),
  )
}

/**
 * Same rows, whatever their order: the server sorts identifiers by type
 * name, so a rename elsewhere reorders them without changing them.
 */
function sameRows(a: unknown, b: unknown): boolean {
  const byKey = (_: string, v: unknown) =>
    Array.isArray(v) && v.every((r) => typeof r === 'object' && r && 'key' in r)
      ? [...(v as Array<{ key: string }>)].sort((x, y) =>
          x.key < y.key ? -1 : x.key > y.key ? 1 : 0,
        )
      : v
  return JSON.stringify(a, byKey) === JSON.stringify(b, byKey)
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
      identifiers: false,
      fields: false,
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
      // Slices the server changed: a new counter, or rows that changed
      // under the same one (`torn`, see `tornSlices`).
      const torn = action.torn ?? []
      const changed = (s: SliceName) =>
        action.counters[s] !== state.counters[s] || torn.includes(s)
      // Same counters everywhere: same state (or our own save echoing back).
      if (!SLICES.some(changed)) return state
      const next = {
        ...state,
        base: { ...state.base },
        local: { ...state.local },
        counters: { ...state.counters },
      }
      let conflicts = state.conflicts.filter(
        (c) => !SLICES.some((s) => c.startsWith(`${s}.`) && changed(s)),
      )
      let needsSave = state.needsSave
      for (const slice of SLICES) {
        if (!changed(slice)) continue // same state, or our own save echoing back
        next.counters[slice] = action.counters[slice]
        const remote = action.slices[slice]
        if (!state.dirty[slice]) {
          put(next.base, slice, remote)
          put(next.local, slice, remote)
          continue
        }
        const merged =
          slice === 'identifiers'
            ? {
                value: mergeIdentifiers(
                  state.base.identifiers,
                  state.local.identifiers,
                  remote as Slices['identifiers'],
                ),
                conflicts: [],
              }
            : slice === 'fields'
              ? mergeFieldValues(
                  state.base.fields,
                  state.local.fields,
                  remote as Slices['fields'],
                )
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
      const methods = rekey(state.base.methods, state.local.methods, newKey)
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
      // A counter moves only with the state it stands for: a submitted
      // slice the server saved or found unchanged, so `base` now holds
      // what that counter means. Every other slice keeps its old counter:
      // a stale one, a refused one (validity is checked before staleness,
      // so another tab may have moved it), one not submitted (its counter
      // comes without its rows). The newer state has not been seen yet,
      // and the next delivery must be allowed to merge it in: adopting the
      // counter alone would make that delivery look like an echo, and the
      // next save of the slice would overwrite the other change unseen.
      const counters = { ...state.counters }
      for (const slice of SLICES) {
        if (
          action.submitted[slice] !== undefined &&
          action.result.stale[slice] === undefined &&
          !action.result.problems[slice]
        )
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
      // A refusal names the value submitted. If the user has changed the
      // slice since (corrected it while the save was in flight), the
      // problem is about text no longer on screen: drop it and send the
      // new value. A slice still holding the refused value waits for an edit.
      const problems = { ...action.result.problems }
      const refused = (s: SliceName) =>
        problems[s] !== undefined &&
        same(clean(s, state.local[s]), action.submitted[s])
      for (const slice of SLICES)
        if (problems[slice] && !refused(slice)) delete problems[slice]
      return {
        ...state,
        base,
        dirty,
        conflicts,
        counters,
        problems,
        stale,
        status: 'saved',
        savedAt: action.result.saved.length ? action.at : state.savedAt,
        // Recomputed, not carried over: a commit during the save (the Save
        // click's own blur) queues it, and if this save took everything a
        // queued save submits nothing and would never clear it, leaving
        // the form `busy` and the leave guard waiting forever.
        needsSave: SLICES.some((s) => dirty[s] && !refused(s)),
        error: null,
      }
    }
    case 'nothingToSave':
      // A queued save found no dirty slice (a remote merge made them all
      // clean, say). Unqueue it, or the form stays `busy` for good. Kept
      // if a slice is dirty after all: an edit dispatched after the save
      // read its state is still to go.
      return {
        ...state,
        needsSave: state.needsSave && SLICES.some((s) => state.dirty[s]),
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
