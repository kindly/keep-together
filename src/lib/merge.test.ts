import { describe, expect, test } from 'vitest'
import { isEcho, threeWayMerge } from './merge'

const base = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  emails: [{ key: 'e1', address: 'a@x.com' }],
}

describe('threeWayMerge', () => {
  test('remote-only change is taken', () => {
    const r = threeWayMerge(base, base, { ...base, lastName: 'Byron' })
    expect(r.value.lastName).toBe('Byron')
    expect(r.conflicts).toEqual([])
  })

  test('local-only change is kept', () => {
    const r = threeWayMerge(base, { ...base, firstName: 'Augusta' }, base)
    expect(r.value.firstName).toBe('Augusta')
    expect(r.conflicts).toEqual([])
  })

  test('both changed to the same value is not a conflict', () => {
    const r = threeWayMerge(
      base,
      { ...base, lastName: 'Byron' },
      { ...base, lastName: 'Byron' },
    )
    expect(r.conflicts).toEqual([])
  })

  test('both changed differently keeps local and flags the field', () => {
    const r = threeWayMerge(
      base,
      { ...base, lastName: 'Byron' },
      { ...base, lastName: 'King' },
    )
    expect(r.value.lastName).toBe('Byron')
    expect(r.conflicts).toEqual(['lastName'])
  })

  test('fields are independent: a remote change elsewhere does not touch local typing', () => {
    const r = threeWayMerge(
      base,
      { ...base, firstName: 'Augus' },
      {
        ...base,
        emails: [
          { key: 'e1', address: 'a@x.com' },
          { key: 'e2', address: 'b@x.com' },
        ],
      },
    )
    expect(r.value.firstName).toBe('Augus')
    expect(r.value.emails).toHaveLength(2)
    expect(r.conflicts).toEqual([])
  })
})

describe('isEcho', () => {
  test('our own save coming back is an echo', () => {
    expect(isEcho({ details: 3, methods: 1 }, { details: 3, methods: 1 })).toBe(
      true,
    )
  })
  test('a newer counter on any slice is someone else', () => {
    expect(isEcho({ details: 3, methods: 1 }, { details: 3, methods: 2 })).toBe(
      false,
    )
  })
})
