/**
 * The contact history panel's moments, shared by `history` (which builds
 * them a page at a time) and the UI (which joins the pages). Pure: the
 * query does the reads.
 */
import type { Doc, Id } from '../_generated/dataModel'
import { RETIRED_CONTRACTS, isRetired } from './retired'

export type Moment = {
  /** The command group, or the revision when it had none. */
  key: string
  /** The moment's newest revision. */
  revisionId: Id<'revisions'>
  at: number
  actor: Id<'users'> | null
  source: Doc<'revisions'>['source']
  groupName: string | null
  slices: Array<string>
  restored: boolean
  /**
   * Every revision in it is of a retired contract (tags): history only, so
   * the panel offers no restore to it.
   */
  retired: boolean
}

/**
 * Pages of moments, newest first, as one list: a group cut by a page
 * boundary ends one page and starts the next, so join those two halves.
 */
export function joinMoments(moments: Array<Moment>): Array<Moment> {
  const out: Array<Moment> = []
  for (const m of moments) {
    const last = out.at(-1)
    if (last && last.key === m.key) {
      out[out.length - 1] = {
        ...last,
        slices: [...new Set([...last.slices, ...m.slices])],
        retired: last.retired && m.retired,
      }
    } else {
      out.push(m)
    }
  }
  return out
}

/**
 * The command groups `history` must read for their names: only those of
 * revisions written before `executeContract` stamped `groupName` (and not
 * yet backfilled). Stamped rows read nothing.
 */
export function groupsToRead(
  revisions: Array<Doc<'revisions'>>,
): Array<Id<'commandGroups'>> {
  return [
    ...new Set(
      revisions.flatMap((r) =>
        r.group && r.groupName === undefined ? [r.group] : [],
      ),
    ),
  ]
}

/**
 * How a moment names a slice: the contract's name within the module,
 * unless it reads badly to staff or the contract is retired.
 */
const SLICE_LABELS: Record<string, string> = {
  'contacts.acquisition': 'acquisition code',
  ...RETIRED_CONTRACTS,
}

export function sliceLabel(contract: string): string {
  return SLICE_LABELS[contract] ?? contract.replace(/^contacts\./, '')
}

/**
 * One page of revisions (newest first) as moments: revisions sharing a
 * command group collapse into one entry listing the slices it touched.
 * `groupNames` holds what `groupsToRead` asked for.
 */
export function toMoments(
  revisions: Array<Doc<'revisions'>>,
  groupNames: Map<Id<'commandGroups'>, string | undefined>,
): Array<Moment> {
  const moments: Array<Moment> = []
  const index = new Map<string, number>()
  for (const r of revisions) {
    const key = r.group ?? r._id
    const slice = sliceLabel(r.contract)
    const at = index.get(key)
    if (at !== undefined) {
      const m = moments[at]
      if (!m.slices.includes(slice)) m.slices.push(slice)
      m.retired &&= isRetired(r.contract)
      continue
    }
    index.set(key, moments.length)
    moments.push({
      key,
      revisionId: r._id,
      at: r._creationTime,
      actor: r.actor ?? null,
      source: r.source,
      groupName: r.group
        ? (r.groupName ?? groupNames.get(r.group) ?? null)
        : null,
      slices: [slice],
      restored: r.restoredFrom !== undefined,
      retired: isRetired(r.contract),
    })
  }
  return moments
}
