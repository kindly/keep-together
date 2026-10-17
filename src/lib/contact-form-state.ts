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
import type { Payloads } from '../../convex/contacts/validators'
import { same, threeWayMerge } from './merge'

export type SliceName = 'details' | 'methods' | 'addresses'
export type Slices = {
  details: Payloads['details']
  methods: Payloads['methods']
  addresses: Payloads['addresses']
}
export type Counters = Record<SliceName, number>
export type Problem = { field: string; message: string }

export const SLICES: Array<SliceName> = ['details', 'methods', 'addresses']

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
  | { type: 'saving' }
  | {
      type: 'saved'
      submitted: Partial<Slices>
      result: SaveResult
      at: number
    }
  | { type: 'failed'; message: string }

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
    dirty: { details: false, methods: false, addresses: false },
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
        const merged = threeWayMerge(
          state.base[slice] as Record<string, unknown>,
          state.local[slice] as Record<string, unknown>,
          remote as Record<string, unknown>,
        )
        put(next.base, slice, remote)
        put(next.local, slice, merged.value as Slices[typeof slice])
        conflicts = [
          ...conflicts,
          ...merged.conflicts.map((f) => `${slice}.${f}`),
        ]
        next.dirty[slice] = !same(merged.value, remote)
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
        [action.slice]: !same(action.value, state.base[action.slice]),
      }
      return {
        ...state,
        local,
        dirty,
        needsSave: dirty[action.slice] || state.needsSave,
        status: state.status === 'saved' ? 'idle' : state.status,
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
        dirty[slice] = !same(state.local[slice], submitted)
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
          dirty[slice] = !same(state.local[slice], submitted)
        }
      }
      // A stale slice keeps its old counter: the newer state has not been
      // seen yet, and the subscription must be allowed to merge it in.
      const counters = { ...state.counters }
      for (const slice of SLICES) {
        if (action.result.stale[slice] === undefined)
          counters[slice] = action.result.counters[slice]
      }
      return {
        ...state,
        base,
        dirty,
        conflicts,
        counters,
        problems: action.result.problems,
        stale: { ...state.stale, ...action.result.stale },
        status: 'saved',
        savedAt: action.result.saved.length ? action.at : state.savedAt,
        needsSave:
          state.needsSave ||
          SLICES.some((s) => dirty[s] && !action.result.problems[s]),
        error: null,
      }
    }
    case 'failed':
      return { ...state, status: 'error', error: action.message }
  }
}

/** Which slices a save should submit, with their expected counters. */
export function submission(state: FormState): Partial<Slices> {
  const out: Partial<Slices> = {}
  for (const slice of SLICES)
    if (state.dirty[slice]) out[slice] = state.local[slice] as never
  return out
}
