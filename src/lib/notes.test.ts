import { describe, expect, test } from 'vitest'
import { ConvexError } from 'convex/values'
import { NOTE_MAX_BYTES } from '../../convex/contacts/rules'
import {
  budget,
  budgetMessage,
  failureMessage,
  openDraft,
  rebase,
  withOpenEdits,
} from './notes'

describe('budget', () => {
  test('counts UTF-8 bytes of the trimmed body, as the server does', () => {
    expect(budget('  café \n').bytes).toBe(5)
    expect(budget('🙂').bytes).toBe(4)
  })

  test('ok below 90%, near from 90%, over past the cap', () => {
    expect(budget('a'.repeat(89), 100).level).toBe('ok')
    expect(budget('a'.repeat(90), 100).level).toBe('near')
    expect(budget('a'.repeat(100), 100)).toEqual({
      bytes: 100,
      remaining: 0,
      level: 'near',
    })
    expect(budget('a'.repeat(101), 100).level).toBe('over')
  })

  test('defaults to the server cap', () => {
    expect(budget('a'.repeat(NOTE_MAX_BYTES)).level).toBe('near')
    expect(budget('a'.repeat(NOTE_MAX_BYTES + 1)).level).toBe('over')
  })

  test('messages only near or over the cap', () => {
    expect(budgetMessage(budget('hi'))).toBeNull()
    expect(budgetMessage(budget('a'.repeat(95), 100))).toMatch(/5 bytes left/)
    expect(budgetMessage(budget('a'.repeat(1_250), 100))).toMatch(
      /1,150 bytes over/,
    )
  })
})

describe('rebase', () => {
  const note = { body: 'Met at fair', bodyVersion: 2 }

  test('ignores a body that is not newer', () => {
    const d = { ...openDraft(note), text: 'Met at the fair' }
    expect(rebase(d, note)).toBe(d)
  })

  test('untouched text follows their change', () => {
    const d = openDraft(note)
    expect(rebase(d, { body: 'Met at the fair', bodyVersion: 3 })).toEqual({
      base: 'Met at the fair',
      baseVersion: 3,
      text: 'Met at the fair',
      theirs: null,
    })
  })

  test('the same edit on both sides rebases quietly', () => {
    const d = { ...openDraft(note), text: 'Met at the fair  ' }
    const r = rebase(d, { body: 'Met at the fair', bodyVersion: 3 })
    expect(r.theirs).toBeNull()
    expect(r.baseVersion).toBe(3)
  })

  test('diverging edits keep ours, save against theirs, flag theirs', () => {
    const d = { ...openDraft(note), text: 'Met at the summer fair' }
    expect(rebase(d, { body: 'Met at the fair', bodyVersion: 3 })).toEqual({
      base: 'Met at the fair',
      baseVersion: 3,
      text: 'Met at the summer fair',
      theirs: 'Met at the fair',
    })
  })

  test('a later agreeing change clears the flag', () => {
    const d = rebase(
      { ...openDraft(note), text: 'X' },
      { body: 'Y', bodyVersion: 3 },
    )
    expect(d.theirs).toBe('Y')
    expect(rebase(d, { body: 'X', bodyVersion: 4 }).theirs).toBeNull()
  })
})

describe('failureMessage', () => {
  test('names each server error kind', () => {
    expect(
      failureMessage(new ConvexError({ kind: 'stale', current: 3 })),
    ).toMatch(/changed this note/)
    expect(
      failureMessage(
        new ConvexError({
          kind: 'invalid',
          problems: [{ field: 'body', message: 'A note needs some text' }],
        }),
      ),
    ).toBe('A note needs some text')
    expect(
      failureMessage(
        new ConvexError({
          kind: 'rejected',
          reason: 'archived',
          message: 'Restore the note before editing it',
        }),
      ),
    ).toBe('Restore the note before editing it')
    expect(failureMessage(new Error('boom'))).toBe('Could not save the note')
  })
})

describe('withOpenEdits', () => {
  const a = { _id: 'a', archived: false }
  const b = { _id: 'b', archived: false }

  test('the live list as is when every open note is in it', () => {
    expect(withOpenEdits([a, b], { a }, undefined)).toEqual([
      { note: a, gone: null },
      { note: b, gone: null },
    ])
  })

  test('keeps an open note that left the list, after the listed ones', () => {
    expect(withOpenEdits([a], { b }, undefined)).toEqual([
      { note: a, gone: null },
      { note: b, gone: 'unlisted' },
    ])
  })

  test('an archived copy says it was archived', () => {
    const archivedB = { _id: 'b', archived: true }
    expect(withOpenEdits([a], { b }, [archivedB])).toEqual([
      { note: a, gone: null },
      { note: archivedB, gone: 'archived' },
    ])
    expect(withOpenEdits([a], { b }, [])[1].gone).toBe('unlisted')
  })
})
