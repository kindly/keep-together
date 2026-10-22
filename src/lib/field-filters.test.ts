import { expect, test } from 'vitest'
import type { Id } from '../../convex/_generated/dataModel'
import type { FieldDefinition } from '../../convex/contacts/fieldTypes'
import { fieldArgs } from './field-filters'

const field = (
  id: string,
  extra: Partial<FieldDefinition> = {},
): FieldDefinition => ({
  _id: id as Id<'contactFields'>,
  label: id,
  appliesTo: ['individual', 'organization', 'household'],
  isActive: true,
  retiring: false,
  slot: 1,
  saveVersion: 0,
  options: [],
  deletable: true,
  ...extra,
})
const pick = (fieldId: string, optionId: string | null) => ({
  fieldId: fieldId as Id<'contactFields'>,
  optionId: optionId as Id<'contactFieldOptions'> | null,
})

test('set values go first (the index range), then "not set", each in pick order', () => {
  const fields = [field('a'), field('b'), field('c')]
  expect(
    fieldArgs([pick('a', null), pick('b', 'b1'), pick('c', 'c1')], fields, ''),
  ).toEqual([pick('b', 'b1'), pick('c', 'c1'), pick('a', null)])
})

test('a pick on a field the bar no longer shows is dropped', () => {
  const fields = [
    field('people', { appliesTo: ['individual'] }),
    field('archived', { isActive: false }),
  ]
  const picks = [
    pick('people', 'p1'),
    pick('archived', 'x1'),
    pick('gone', 'g'),
  ]
  expect(fieldArgs(picks, fields, '')).toEqual([pick('people', 'p1')])
  expect(fieldArgs(picks, fields, 'individual')).toEqual([pick('people', 'p1')])
  expect(fieldArgs(picks, fields, 'organization')).toEqual([])
  // Before the definitions load, no filter is sent.
  expect(fieldArgs(picks, undefined, '')).toEqual([])
})

test('equal picks give equal args, whatever key order they were built in', () => {
  const fields = [field('a')]
  const built = { optionId: 'a1', fieldId: 'a' } as unknown as ReturnType<
    typeof pick
  >
  expect(JSON.stringify(fieldArgs([built], fields, ''))).toBe(
    JSON.stringify([pick('a', 'a1')]),
  )
})
