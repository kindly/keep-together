import { expect, test } from 'vitest'
import { LIMITS, tooLong } from './limits'

test('the widths the server stores (giving::stripe::prepare_submission)', () => {
  expect(LIMITS).toEqual({
    firstName: 200,
    lastName: 200,
    email: 254,
    addressLine1: 200,
    postcode: 20,
  })
})

test('a value is too long past its width, counted after trimming', () => {
  expect(tooLong('postcode', 'AB1 2CD')).toBeNull()
  expect(tooLong('postcode', 'x'.repeat(20))).toBeNull()
  expect(tooLong('postcode', 'x'.repeat(21))).toBe('At most 20 characters')
  expect(tooLong('postcode', `  ${'x'.repeat(20)}  `)).toBeNull()
  expect(tooLong('firstName', 'x'.repeat(201))).toBe('At most 200 characters')
  expect(tooLong('lastName', 'x'.repeat(200))).toBeNull()
  expect(tooLong('addressLine1', 'x'.repeat(201))).toBe(
    'At most 200 characters',
  )
  const at = '@example.org'
  expect(tooLong('email', 'a'.repeat(254 - at.length) + at)).toBeNull()
  expect(tooLong('email', 'a'.repeat(255 - at.length) + at)).toBe(
    'At most 254 characters',
  )
})

test('characters are counted as the server counts them, not UTF-16 units', () => {
  // 20 emoji are 40 UTF-16 units and 20 characters.
  expect(tooLong('postcode', '🎁'.repeat(20))).toBeNull()
  expect(tooLong('postcode', '🎁'.repeat(21))).not.toBeNull()
})
