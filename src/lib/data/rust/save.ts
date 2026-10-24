/**
 * The contact form's save on the Rust API, as reducer actions (pure; the
 * request itself is in `hooks.tsx`). The Convex `saveForm` saves what it
 * can and reports the rest per slice; the Rust save is one transaction,
 * so a refusal refuses all of it. These turn its answers back into the
 * `SaveResult` the reducer (spike 04, unchanged) already understands:
 *
 * - **409 stale** carries the slice's state now, so there is no read to
 *   wait for: a `saved` that marks every submitted slice not yet saved
 *   (`stale` at the counter it holds, which clears at once; the stale one
 *   at the server's), then a `server` delivering the stale slice, which
 *   merges it three-way and queues the retry against the new counter.
 * - **422 invalid** names fields as `<slice>.<field>`: the refused slices
 *   become `problems` and the rest are sent again on their own, which is
 *   what Convex's per-slice save would have done.
 */
import type {
  Action,
  Counters,
  FormState,
  Problem,
  SaveResult,
  SliceName,
  Slices,
} from '../../contact-form-state'
import { SLICES } from '../../contact-form-state'
import type { Problem as WireProblem } from '../rust-types/Problem'
import type { RustSlice, WireSave, WireSaved } from './wire'
import { sliceFromWire, sliceOfContract, sliceToWire } from './wire'

export function saveRequest(
  submitted: Partial<Slices>,
  counters: Counters,
): WireSave {
  const slices: WireSave['slices'] = {}
  for (const [slice, payload] of Object.entries(submitted) as Array<
    [RustSlice, Slices[RustSlice]]
  >)
    slices[slice] = { expected: counters[slice], ...sliceToWire(payload) }
  return { source: 'autosave', slices }
}

type Refused = Partial<Record<SliceName, Array<Problem>>>

function result(
  state: FormState,
  parts: Partial<Omit<SaveResult, 'counters'>> & {
    counters?: Partial<Counters>
  },
): SaveResult {
  return {
    saved: parts.saved ?? [],
    problems: parts.problems ?? {},
    stale: parts.stale ?? {},
    counters: { ...state.counters, ...parts.counters, archive: 0 },
  }
}

/** A 2xx: every slice sent is saved at its new counter. */
export function savedActions(
  submitted: Partial<Slices>,
  state: FormState,
  response: WireSaved,
  at: number,
  problems: Refused = {},
): Array<Action> {
  const counters: Partial<Counters> = {}
  for (const [slice, executed] of Object.entries(response.slices))
    counters[slice as RustSlice] = executed.counter
  return [
    {
      type: 'saved',
      submitted,
      result: result(state, {
        saved: Object.keys(counters) as Array<SliceName>,
        problems,
        counters,
      }),
      at,
    },
  ]
}

/**
 * A 409 stale. `state` must be the form's state as the answer arrives
 * (not as the save left): the `server` action carries every other slice
 * at the counter the form holds now, so it changes nothing else.
 */
export function staleActions(
  submitted: Partial<Slices>,
  state: FormState,
  refusal: { contract: string; counter: number; current: unknown },
  at: number,
  problems: Refused = {},
): Array<Action> {
  const slice = sliceOfContract(refusal.contract)
  if (!slice)
    return [
      { type: 'failed', message: `Changed elsewhere (${refusal.contract})` },
    ]
  const stale: SaveResult['stale'] = {}
  for (const s of SLICES)
    if (submitted[s] !== undefined && !problems[s]) stale[s] = state.counters[s]
  stale[slice] = refusal.counter
  return [
    {
      type: 'saved',
      submitted,
      result: result(state, { problems, stale }),
      at,
    },
    {
      type: 'server',
      slices: {
        ...state.base,
        [slice]: sliceFromWire(slice, refusal.current),
      },
      counters: { ...state.counters, [slice]: refusal.counter },
    },
  ]
}

/**
 * A 422 invalid, split by slice: the problems for the reducer, and what
 * is left to send. Null when a problem names no submitted slice (nothing
 * to blame it on: the whole save fails).
 */
export function splitInvalid(
  submitted: Partial<Slices>,
  problems: Array<WireProblem>,
): { problems: Refused; rest: Partial<Slices> } | null {
  const refused: Refused = {}
  for (const p of problems) {
    const at = p.field.indexOf('.')
    const slice = (at === -1 ? p.field : p.field.slice(0, at)) as SliceName
    if (submitted[slice] === undefined) return null
    ;(refused[slice] ??= []).push({
      field: at === -1 ? '' : p.field.slice(at + 1),
      message: p.message,
    })
  }
  const rest: Partial<Slices> = {}
  for (const s of SLICES)
    if (submitted[s] !== undefined && !refused[s])
      (rest as Record<SliceName, unknown>)[s] = submitted[s]
  return { problems: refused, rest }
}
