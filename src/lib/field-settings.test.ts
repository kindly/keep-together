import { describe, expect, test } from 'vitest'
import {
  conflictsOf,
  failureMessage,
  fieldDeleteBlocked,
  kindsText,
  moveOption,
  openDraft,
  optionDeleteBlocked,
  rebase,
  shownFields,
  shownOptions,
  toggleKind,
} from './field-settings'
import { RustApiError } from './data/rust/client'
import type { Field, FieldFields, Option } from './field-settings'

const option = (id: string, isActive = true, used = false) =>
  ({ _id: id, label: id, isActive, used, saveVersion: 0 }) as unknown as Option

const field = (id: string, over: Partial<Field> = {}) =>
  ({
    _id: id,
    label: id,
    appliesTo: ['individual', 'organization', 'household'],
    isActive: true,
    retiring: false,
    slot: 1,
    saveVersion: 0,
    options: [],
    deletable: true,
    ...over,
  }) as unknown as Field

describe('kindsText', () => {
  test('all three is "all contacts"', () => {
    expect(kindsText(['household', 'individual', 'organization'])).toBe(
      'all contacts',
    )
  })
  test('names the rest in the form’s order', () => {
    expect(kindsText(['organization'])).toBe('Organisations')
    expect(kindsText(['organization', 'individual'])).toBe(
      'Individuals and Organisations',
    )
  })
})

describe('shown rows', () => {
  const fields = [
    field('a'),
    field('b', { isActive: false }),
    field('c', { isActive: false, retiring: true }),
  ]
  test('archived fields hide unless shown, open, or retiring', () => {
    expect(shownFields(fields, false).map((f) => f._id)).toEqual(['a', 'c'])
    expect(
      shownFields(fields, false, new Set(['b'])).map((f) => f._id),
    ).toEqual(['a', 'b', 'c'])
    expect(shownFields(fields, true)).toHaveLength(3)
  })
  test('archived options hide unless shown or open', () => {
    const options = [option('x'), option('y', false)]
    expect(shownOptions(options, false).map((o) => o._id)).toEqual(['x'])
    expect(shownOptions(options, false, new Set(['y']))).toHaveLength(2)
    expect(shownOptions(options, true)).toHaveLength(2)
  })
})

test('delete is blocked once used', () => {
  expect(optionDeleteBlocked(option('x'))).toBeNull()
  expect(optionDeleteBlocked(option('x', true, true))).toMatch(/archived/)
  expect(fieldDeleteBlocked({ deletable: true })).toBeNull()
  expect(fieldDeleteBlocked({ deletable: false })).toMatch(/retire/)
})

describe('moveOption', () => {
  const all = [option('a'), option('h', false), option('b'), option('c')]
  const shown = shownOptions(all, false)
  test('swaps with the neighbour on screen, names every option', () => {
    expect(moveOption(all, shown, 'b' as Option['_id'], -1)).toEqual([
      'b',
      'h',
      'a',
      'c',
    ])
    expect(moveOption(all, shown, 'b' as Option['_id'], 1)).toEqual([
      'a',
      'h',
      'c',
      'b',
    ])
  })
  test('null at either end', () => {
    expect(moveOption(all, shown, 'a' as Option['_id'], -1)).toBeNull()
    expect(moveOption(all, shown, 'c' as Option['_id'], 1)).toBeNull()
  })
})

test('toggleKind keeps the form’s order', () => {
  expect(toggleKind(['household'], 'individual', true)).toEqual([
    'individual',
    'household',
  ])
  expect(
    toggleKind(['individual', 'organization'], 'individual', false),
  ).toEqual(['organization'])
})

describe('rebase', () => {
  const base: FieldFields = { label: 'Region', appliesTo: ['individual'] }

  test('takes their change to a field left alone here', () => {
    const d = { ...openDraft(base, 1), fields: { ...base, label: 'Area' } }
    const next = rebase(
      d,
      { label: 'Region', appliesTo: ['individual', 'organization'] },
      2,
    )
    expect(next.fields).toEqual({
      label: 'Area',
      appliesTo: ['individual', 'organization'],
    })
    expect(next.conflicts).toEqual([])
    expect(next.baseVersion).toBe(2)
  })

  test('keeps ours and flags a field changed on both sides', () => {
    const d = { ...openDraft(base, 1), fields: { ...base, label: 'Area' } }
    const next = rebase(d, { ...base, label: 'Zone' }, 2)
    expect(next.fields.label).toBe('Area')
    expect(next.conflicts).toEqual(['label'])
    // Retyping theirs clears the flag.
    expect(
      conflictsOf({ ...next, fields: { ...next.fields, label: 'Zone' } })
        .conflicts,
    ).toEqual([])
  })

  test('ignores our own save echoing back', () => {
    const d = openDraft(base, 2)
    expect(rebase(d, { ...base, label: 'Old' }, 2)).toBe(d)
  })
})

describe('failureMessage', () => {
  test('stale reads differently from a form and a row', () => {
    const stale = new RustApiError(409, {
      kind: 'stale',
      contract: 'contacts.field',
      counter: 3,
      current: null,
    })
    expect(failureMessage(stale)).toMatch(/merged in/)
    expect(failureMessage(stale, 'row')).toMatch(/try again/)
  })
  test('a rejection shows its message; invalid lists its problems', () => {
    expect(
      failureMessage(
        new RustApiError(422, {
          kind: 'rejected',
          reason: 'field_limit',
          message: 'An organisation has at most 200 fields',
        }),
      ),
    ).toBe('An organisation has at most 200 fields')
    expect(
      failureMessage(
        new RustApiError(422, {
          kind: 'invalid',
          problems: [{ field: 'label', message: 'A field needs a label' }],
        }),
      ),
    ).toBe('A field needs a label')
    expect(failureMessage(new Error('network'))).toBe('Could not save')
  })
})
