import { describe, expect, test } from 'vitest'
import { ConvexError } from 'convex/values'
import { holdLine, holdOn, releaseFailure } from './email-hold'
import type { Held } from './email-hold'

const hold = {
  reason: 'bounce' as const,
  since: Date.UTC(2026, 9, 12, 12),
  saveVersion: 2,
}
const held: Held = { 'ada@example.com': hold }

describe('holdOn', () => {
  test('finds a row by its address, in any case or spacing', () => {
    expect(holdOn('ada@example.com', held)).toBe(hold)
    expect(holdOn('  Ada@Example.COM ', held)).toBe(hold)
  })

  test('nothing for another address, no answer yet, or a prototype key', () => {
    expect(holdOn('bob@example.com', held)).toBeUndefined()
    expect(holdOn('ada@example.com', undefined)).toBeUndefined()
    expect(holdOn('constructor', held)).toBeUndefined()
    expect(holdOn('__proto__', held)).toBeUndefined()
  })
})

test('holdLine says when it bounced and what that means', () => {
  const line = holdLine(hold)
  expect(line).toMatch(/^Bounced on .*2026: we won't send to this address$/)
  expect(line).toContain('12')
})

describe('releaseFailure', () => {
  test('stale asks to check and retry', () => {
    expect(releaseFailure(new ConvexError({ kind: 'stale', current: 3 }))).toBe(
      'This hold changed just now. Check it, then release again.',
    )
  })

  test('not held, forbidden and invalid are named', () => {
    expect(
      releaseFailure(
        new ConvexError({ kind: 'rejected', reason: 'not_held', message: 'x' }),
      ),
    ).toBe('This address is no longer on hold')
    expect(releaseFailure(new ConvexError({ kind: 'forbidden' }))).toBe(
      'Only admins can release an address',
    )
    expect(
      releaseFailure(
        new ConvexError({
          kind: 'invalid',
          problems: [{ field: 'note', message: 'At most 500 characters' }],
        }),
      ),
    ).toBe('At most 500 characters')
  })

  test('anything else: its message, or a generic line', () => {
    expect(
      releaseFailure(
        new ConvexError({ kind: 'rejected', reason: 'r', message: 'Nope' }),
      ),
    ).toBe('Nope')
    expect(releaseFailure(new Error('network'))).toBe(
      'Could not release the address',
    )
  })
})
