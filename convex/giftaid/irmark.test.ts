import { describe, expect, test } from 'vitest'
import canonicalised from '../../test/fixtures/hmrc/irmarkexample-canonicalised.xml?raw'
import submission from '../../test/fixtures/hmrc/irmarkexample-submission.xml?raw'
import claim from '../../test/fixtures/hmrc/GAValidSample.xml?raw'
import {
  base32,
  base64,
  canonicalPayload,
  computeIrmark,
  stampIrmark,
} from './irmark'

describe('IRmark against HMRC samples', () => {
  test('canonical payload matches HMRC’s published canonical form byte for byte', () => {
    expect(canonicalPayload(submission)).toBe(canonicalised)
  })

  test('Gateway-protocol worked example (CTF)', async () => {
    const { base64: mark } = await computeIrmark(submission)
    expect(mark).toBe('RPfWtxHeCZRcwfitnIJmK9xc4OQ=')
  })

  test('Charities Online Gift Aid claim sample (HMRC-CHAR-CLM)', async () => {
    const mark = await computeIrmark(claim)
    expect(mark.base64).toBe('nMs6zamBGcmT7n0selJHXuiQUEw=')
    expect(mark.base32).toHaveLength(32)
  })

  test('stamping replaces the element content and is idempotent', async () => {
    const blank = claim.replace(
      /<IRmark Type="generic">[^<]*<\/IRmark>/,
      '<IRmark Type="generic"></IRmark>',
    )
    const once = await stampIrmark(blank)
    expect(once.irmark.base64).toBe('nMs6zamBGcmT7n0selJHXuiQUEw=')
    expect(once.message).toBe(claim)
    const twice = await stampIrmark(once.message)
    expect(twice.message).toBe(claim)
  })

  test('CRLF line endings normalise to LF before hashing', async () => {
    const crlf = submission.replace(/\n/g, '\r\n')
    expect((await computeIrmark(crlf)).base64).toBe(
      'RPfWtxHeCZRcwfitnIJmK9xc4OQ=',
    )
  })
})

describe('encoders', () => {
  test('base64 and base32 of a known digest', () => {
    const bytes = new Uint8Array([0x66, 0x6f, 0x6f, 0x62, 0x61, 0x72])
    expect(base64(bytes)).toBe('Zm9vYmFy')
    expect(base32(bytes)).toBe('MZXW6YTBOI======')
  })
})
