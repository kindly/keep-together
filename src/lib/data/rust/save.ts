/**
 * The contact form's save on the Rust API, as reducer actions (pure; the
 * request itself is in `hooks.tsx`). `POST contacts/{id}/save` answers
 * Convex's `SaveResult` plus `current`, each stale slice's state now: stale
 * slices are skipped and the rest saved, as on Convex. With no live query
 * to deliver the newer state, `current` is dispatched as the `server`
 * update that a subscription would have brought, so the reducer (spike
 * 04, unchanged) merges it three-way and queues the retry against the new
 * counter, with no extra read.
 */
import type {
  Action,
  Counters,
  FormState,
  SaveResult,
  Slices,
} from '../../contact-form-state'
import { SLICES } from '../../contact-form-state'
import type { SaveForm } from '../rust-types/SaveForm'
import type { SaveFormResult } from '../rust-types/SaveFormResult'

export function saveRequest(
  submitted: Partial<Slices>,
  counters: Counters,
): SaveForm {
  const body: Record<string, unknown> = { source: 'autosave' }
  for (const [slice, payload] of Object.entries(submitted))
    body[slice] = { expected: counters[slice as keyof Counters], ...payload }
  return body
}

/**
 * The save's answer as actions: `saved`, then (if any slice was stale) a
 * `server` with those slices' current state. `state` is the form's state
 * as the answer arrives; the `server` action carries every other slice at
 * the counter the form will hold after `saved` (a slice not submitted or
 * refused keeps its own: its rows are not in the answer), so it changes
 * nothing else.
 */
export function saveActions(
  submitted: Partial<Slices>,
  state: FormState,
  answer: SaveFormResult,
  at: number,
): Array<Action> {
  const counters = answer.counters
  const result = {
    saved: answer.saved,
    problems: answer.problems,
    stale: answer.stale,
    counters,
  } as SaveResult
  const actions: Array<Action> = [{ type: 'saved', submitted, result, at }]
  const stale = SLICES.filter((s) => s in answer.stale && s in answer.current)
  if (stale.length === 0) return actions
  const slices = { ...state.base }
  const after = { ...state.counters }
  for (const s of SLICES)
    if (s in answer.stale) after[s] = answer.stale[s]
    else if (s in submitted && !(s in answer.problems)) after[s] = counters[s]
  for (const s of stale)
    (slices as Record<string, unknown>)[s] = answer.current[s]
  actions.push({ type: 'server', slices, counters: after })
  return actions
}
