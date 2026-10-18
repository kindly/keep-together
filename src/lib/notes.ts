/**
 * Pure state for the contact notes panel: the byte budget a note body is
 * held to, and how an open editor follows a note someone else edits.
 */
import { ConvexError } from 'convex/values'
import { NOTE_MAX_BYTES } from '../../convex/contacts/rules'
import type { Unsaved } from './unsaved'

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

/** Whether a body can be saved at all: not empty, within the byte cap. */
export function storable(body: string): boolean {
  const b = budget(body)
  return b.bytes > 0 && b.level !== 'over'
}

/** An open editor holds text the note doesn't. */
export function edited(draft: Draft): boolean {
  return draft.text.trim() !== draft.base
}

/**
 * What focus leaving an editor does. A plain edit saves, as the contact
 * form's fields do. Anything that needs a decision stays open for one:
 * a note someone archived meanwhile (saving would restore it), a body
 * someone else changed (saving would replace theirs), a body that can't
 * be stored. Unchanged text leaves the editor open too, so switching
 * window doesn't close it.
 */
export function editorBlur(
  draft: Draft,
  ctx: { gone: Gone | null; saving: boolean },
): 'save' | 'none' {
  if (ctx.saving || ctx.gone !== null || draft.theirs !== null) return 'none'
  return edited(draft) && storable(draft.text) ? 'save' : 'none'
}

/**
 * What focus leaving the composer does: any storable text becomes a note,
 * with the pin box as it stands. Empty or over-cap text stays put.
 */
export function composerBlur(
  text: string,
  ctx: { saving: boolean },
): 'create' | 'none' {
  return !ctx.saving && storable(text) ? 'create' : 'none'
}

/** The editor's share of the page's unsaved work (lib/unsaved). */
export function editorUnsaved(draft: Draft, saving: boolean): Unsaved {
  return saving ? 'busy' : edited(draft) ? 'unsaved' : 'clean'
}

/** The composer's share: any text not yet a note. */
export function composerUnsaved(text: string, saving: boolean): Unsaved {
  return saving ? 'busy' : text.trim() !== '' ? 'unsaved' : 'clean'
}
