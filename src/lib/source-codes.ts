/**
 * Pure state for the Settings "Source codes" tab: which parts the tree
 * shows, why a part can't be deleted, and how an open editor follows a
 * part someone else saves meanwhile (the usual three-way merge, ADR 0017).
 */
import { ConvexError } from 'convex/values'
import type { FunctionReturnType } from 'convex/server'
import type { api } from '../../convex/_generated/api'
import type { SourceCodePayload } from '../../convex/sources/validators'
import { threeWayMerge } from './merge'

/** One row of `sources.queries.tree`. */
export type Part = FunctionReturnType<typeof api.sources.queries.tree>[number]
export type Level = Part['level']

/** What a part under one of this level is called; null under a version. */
export function childNoun(level: Level): 'detail' | 'version' | null {
  if (level === 'category') return 'detail'
  if (level === 'detail') return 'version'
  return null
}

/**
 * The rows the tree shows. Without "show archived", a part that is
 * archived or under an archived parent (`visible` false) is left out, as
 * the picker leaves it out, unless it is in `open`: a row with an open
 * editor or add form stays until that closes, so an archive made
 * elsewhere never silently discards what someone is typing.
 */
export function shownParts(
  parts: ReadonlyArray<Part>,
  showArchived: boolean,
  open: ReadonlySet<string> = new Set(),
): Array<Part> {
  return showArchived
    ? [...parts]
    : parts.filter((p) => p.visible || open.has(p._id))
}

/** Why a part can't be deleted, or null if it can. */
export function deleteBlocked(part: Pick<Part, 'used'>): string | null {
  return part.used
    ? 'Used on a contact or gift, so it can only be archived'
    : null
}

/** How many parts a delete takes with it: the part and everything below. */
export function deleteCount(
  parts: ReadonlyArray<Pick<Part, '_id' | 'parentId'>>,
  id: Part['_id'],
): number {
  const doomed = new Set<string>([id])
  // Tree order lists every child after its parent, so one pass is enough.
  for (const p of parts) {
    if (p.parentId && doomed.has(p.parentId)) doomed.add(p._id)
  }
  return doomed.size
}

/**
 * What archiving `id` takes out of the picker, which lists versions: the
 * versions under it shown now (`visible`; ones already hidden by an
 * archive don't count), and how many details they sit in.
 */
export function archiveHides(
  parts: ReadonlyArray<Pick<Part, '_id' | 'parentId' | 'level' | 'visible'>>,
  id: Part['_id'],
): { details: number; versions: number } {
  const under = new Set<string>([id])
  const details = new Set<string>()
  let versions = 0
  // Tree order lists every child after its parent, as in deleteCount.
  for (const p of parts) {
    if (!p.parentId || !under.has(p.parentId)) continue
    under.add(p._id)
    if (p.level !== 'version' || !p.visible) continue
    versions++
    details.add(p.parentId)
  }
  return { details: details.size, versions }
}

/** The editable fields as the form holds them: blank, never absent. */
export type Fields = {
  name: string
  description: string
  startDate: string
  endDate: string
}

export function fieldsOf(part: Part): Fields {
  return {
    name: part.name,
    description: part.description ?? '',
    startDate: part.startDate ?? '',
    endDate: part.endDate ?? '',
  }
}

/**
 * An open editor. `base` and `baseVersion` are the part as last seen from
 * the server; `fields` is what the form holds; `conflicts` lists fields
 * someone else changed to something other than what this editor typed.
 */
export type Draft = {
  base: Fields
  baseVersion: number
  fields: Fields
  conflicts: Array<keyof Fields>
}

export function openDraft(part: Part): Draft {
  const base = fieldsOf(part)
  return { base, baseVersion: part.saveVersion, fields: base, conflicts: [] }
}

/**
 * Follow a newer save of the part from the live query. Fields changed only
 * there take theirs, fields changed only here keep ours, and fields changed
 * on both sides keep ours and are flagged. The next save goes against
 * their counter, so a stale save is a merge, then a retry.
 */
export function rebase(draft: Draft, live: Part): Draft {
  if (live.saveVersion <= draft.baseVersion) return draft
  const remote = fieldsOf(live)
  const { value, conflicts } = threeWayMerge(draft.base, draft.fields, remote)
  return conflictsOf({
    base: remote,
    baseVersion: live.saveVersion,
    fields: value,
    conflicts: [...new Set([...draft.conflicts, ...conflicts])],
  })
}

/**
 * The draft with only its live conflicts: a flagged field whose value
 * matches theirs again (retyped, or they changed it back) is no longer
 * one.
 */
export function conflictsOf(draft: Draft): Draft {
  const conflicts = draft.conflicts.filter(
    (f) => draft.fields[f] !== draft.base[f],
  )
  return conflicts.length === draft.conflicts.length
    ? draft
    : { ...draft, conflicts }
}

/** The `sources.code` payload for a draft; the archive switch is the part's own. */
export function payload(fields: Fields, isActive: boolean): SourceCodePayload {
  return {
    name: fields.name,
    description: fields.description || undefined,
    startDate: fields.startDate || undefined,
    endDate: fields.endDate || undefined,
    isActive,
  }
}

/** "from 1 Mar 2026 to 31 May 2026", or null with no dates. */
export function dateRange(p: {
  startDate?: string
  endDate?: string
}): string | null {
  const day = (d: string) =>
    new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    })
  if (p.startDate && p.endDate)
    return `${day(p.startDate)} to ${day(p.endDate)}`
  if (p.startDate) return `from ${day(p.startDate)}`
  if (p.endDate) return `until ${day(p.endDate)}`
  return null
}

/**
 * A failed source-code mutation as one line for the user. `from` is where
 * it was sent: the edit form (a stale save there has been merged, so the
 * user checks and saves again) or a row's archive / delete (nothing to
 * merge: the user tries again).
 */
export function failureMessage(
  err: unknown,
  from: 'form' | 'row' = 'form',
): string {
  const data =
    err instanceof ConvexError
      ? (err.data as {
          kind?: string
          message?: string
          problems?: Array<{ message: string }>
        })
      : null
  if (data?.kind === 'invalid' && data.problems?.length)
    return data.problems.map((p) => p.message).join('; ')
  if (data?.kind === 'stale')
    return from === 'form'
      ? 'Someone else changed this code just now. Their changes are merged in: check, then save again.'
      : 'Someone else changed this code just now; check it and try again.'
  if (data?.kind === 'forbidden')
    return 'You can no longer manage source codes in this group'
  if (data?.kind === 'not_found') return 'This code no longer exists'
  return data?.message ?? data?.kind ?? 'Could not save'
}
