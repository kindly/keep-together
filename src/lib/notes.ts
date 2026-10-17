/**
 * Pure state for the contact notes panel: the byte budget a note body is
 * held to, and how an open editor follows a note someone else edits.
 */
import { ConvexError } from 'convex/values'
import { NOTE_MAX_BYTES } from '../../convex/contacts/rules'

/** From this share of the cap on, the editor shows what is left. */
export const NEAR_FRACTION = 0.9

export type Budget = {
  bytes: number
  remaining: number
  level: 'ok' | 'near' | 'over'
}

/** Measured as the server measures: UTF-8 bytes of the trimmed body. */
export function budget(body: string, max = NOTE_MAX_BYTES): Budget {
  const bytes = new TextEncoder().encode(body.trim()).length
  const remaining = max - bytes
  const level =
    remaining < 0 ? 'over' : bytes >= max * NEAR_FRACTION ? 'near' : 'ok'
  return { bytes, remaining, level }
}

export function budgetMessage(b: Budget): string | null {
  const n = (x: number) => x.toLocaleString('en-GB')
  if (b.level === 'over')
    return `${n(-b.remaining)} bytes over the limit. Shorten it, or split it into two notes.`
  if (b.level === 'near')
    return `Nearly full: ${n(b.remaining)} bytes left. Accents, symbols and emoji take more than one byte each.`
  return null
}

/**
 * An open editor. `base` and `baseVersion` are the note's body and
 * `bodyVersion` the edit is saved against; `theirs` is set when someone
 * else changed the body while this one was being edited differently.
 */
export type Draft = {
  base: string
  baseVersion: number
  text: string
  theirs: string | null
}

export function openDraft(note: { body: string; bodyVersion: number }): Draft {
  return {
    base: note.body,
    baseVersion: note.bodyVersion,
    text: note.body,
    theirs: null,
  }
}

/**
 * Follow a newer body from the live query. Untouched text takes theirs;
 * text that already matches theirs simply rebases; otherwise ours is kept
 * and the next save goes against their version, with `theirs` flagged so
 * the panel can say so and offer theirs instead.
 */
export function rebase(
  draft: Draft,
  live: { body: string; bodyVersion: number },
): Draft {
  if (live.bodyVersion <= draft.baseVersion) return draft
  const mine = draft.text.trim()
  const untouched = mine === draft.base
  const agreed = mine === live.body
  return {
    base: live.body,
    baseVersion: live.bodyVersion,
    text: untouched ? live.body : draft.text,
    theirs: untouched || agreed ? null : live.body,
  }
}

/** A user-facing line for a failed note mutation. */
export function failureMessage(err: unknown): string {
  if (!(err instanceof ConvexError)) return 'Could not save the note'
  const d = err.data as {
    kind?: string
    message?: string
    problems?: Array<{ message: string }>
  }
  switch (d.kind) {
    case 'stale':
      return 'Someone else changed this note just now. Check the text, then save again.'
    case 'invalid':
      return d.problems?.map((p) => p.message).join('; ') ?? 'Invalid note'
    case 'not_found':
      return 'This note no longer exists'
    default:
      return d.message ?? 'Could not save the note'
  }
}

/** Why a note being edited is no longer in the live list. */
export type Gone = 'archived' | 'unlisted'

/**
 * The live list plus every note still open in an editor that has left it,
 * so a draft is never dropped by a list update. `open` holds each editor's
 * note as last seen; an archived copy, when loaded, says why it left.
 */
export function withOpenEdits<TNote extends { _id: string }>(
  listed: Array<TNote>,
  open: Record<string, TNote>,
  archived: Array<TNote> | undefined,
): Array<{ note: TNote; gone: Gone | null }> {
  const here = new Set(listed.map((n) => n._id))
  const out: Array<{ note: TNote; gone: Gone | null }> = listed.map((n) => ({
    note: n,
    gone: null,
  }))
  for (const [id, last] of Object.entries(open)) {
    if (here.has(id)) continue
    const copy = archived?.find((n) => n._id === id)
    out.push(
      copy
        ? { note: copy, gone: 'archived' }
        : { note: last, gone: 'unlisted' },
    )
  }
  return out
}
