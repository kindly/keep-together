import { describe, expect, test } from 'vitest'
import { skippedFieldsNote } from './contact-history'

describe('skippedFieldsNote', () => {
  test('nothing skipped says nothing', () => {
    expect(skippedFieldsNote([])).toBeNull()
  })

  test('names each skipped field with its reason', () => {
    expect(
      skippedFieldsNote([
        { label: 'Region', reason: 'retired' },
        { label: 'Type', reason: 'wrong_kind' },
        { label: 'Status', reason: 'added_after' },
      ]),
    ).toBe(
      'Restored, except: Region (the field has been retired); ' +
        'Type (the field no longer applies to this kind of contact); ' +
        'Status (the field was added after this point; its value is kept).',
    )
  })
})
