// Ported from the Convex era's number tests (tag `convex-final`); the
// server's own copy is `server/crates/contacts/src/number.rs`.
import { describe, expect, test } from 'vitest'
import { FIRST_NUMBER, checkDigit, formatNumber } from './contacts'

describe('check digit (Luhn)', () => {
  /** Whether a written number's last digit is its sequence's check digit. */
  const valid = (written: string) =>
    checkDigit(Number(written.slice(0, -1))) === Number(written.at(-1))

  test('known Luhn values', () => {
    // The textbook example: 7992739871 + 3.
    expect(checkDigit(7992739871)).toBe(3)
    expect(formatNumber(FIRST_NUMBER)).toBe('100016')
    expect(formatNumber(10002)).toBe('100024')
    expect(formatNumber(99999)).toBe('999995')
  })

  test('every single wrong digit is caught', () => {
    for (let seq = FIRST_NUMBER; seq < FIRST_NUMBER + 2000; seq++) {
      const written = formatNumber(seq)
      expect(valid(written)).toBe(true)
      for (let i = 0; i < written.length; i++) {
        for (let d = 0; d <= 9; d++) {
          if (String(d) === written[i]) continue
          const typo = written.slice(0, i) + d + written.slice(i + 1)
          if (valid(typo)) throw new Error(`${typo} passes for ${written}`)
        }
      }
    }
  })

  test('every neighbouring swap is caught but 09↔90', () => {
    let missed = 0
    for (let seq = FIRST_NUMBER; seq < FIRST_NUMBER + 2000; seq++) {
      const written = formatNumber(seq)
      for (let i = 0; i + 1 < written.length; i++) {
        const [x, y] = [written[i], written[i + 1]]
        if (x === y) continue
        const swapped = written.slice(0, i) + y + x + written.slice(i + 2)
        if (!valid(swapped)) continue
        expect([x + y, y + x].sort()).toEqual(['09', '90'])
        missed++
      }
    }
    expect(missed).toBeGreaterThan(0) // the exception is real, not untested
  })
})
