import { describe, expect, test } from 'vitest'
import { nextTotp, totpAt } from './totp'

describe('totp', () => {
  test('RFC 6238 appendix B (SHA-1), as 6 digits', () => {
    // base32 of "12345678901234567890"; T = 59 s is step 1 → 94287082.
    expect(totpAt('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 1)).toBe('287082')
  })

  test('never hands out a step twice', async () => {
    const a = await nextTotp('GEZDGNBVGY3TQOJQ')
    const b = await nextTotp('GEZDGNBVGY3TQOJQ')
    expect(a).not.toBe(b)
  })
})
