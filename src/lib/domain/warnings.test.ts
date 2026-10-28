// Ported from the Convex era's pure warning tests (tag `convex-final`).
import { describe, expect, test } from 'vitest'
import {
  HMRC_MODEL_WORDING_VERSION,
  contactWarnings,
  declarationWarnings,
  giftWarnings,
} from './warnings'

describe('gift warnings', () => {
  const today = '2026-10-23'
  const warned = (receivedOn: string, amount = 2000n) =>
    giftWarnings({ receivedOn, amount }, today).map((w) => w.anchor)

  test.each([
    ['today', today, 2000n, []],
    ['tomorrow', '2026-10-24', 2000n, ['receivedOn']],
    ['exactly 4 years ago', '2022-10-23', 2000n, []],
    ['a day over 4 years ago', '2022-10-22', 2000n, ['receivedOn']],
    ['exactly £10,000', today, 1_000_000n, []],
    ['over £10,000', today, 1_000_001n, ['amount']],
  ] as const)('%s', (_name, date, amount, anchors) => {
    expect(warned(date, amount)).toEqual(anchors)
  })
})

describe('shared-email warning (pure)', () => {
  const sharers = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      displayName: `P${i + 1}`,
      archived: false,
    }))
  const warn = (n: number, truncated = false) =>
    contactWarnings(
      {
        emails: [
          { key: 'k1', address: 'a@x.com' },
          { key: 'k2', address: 'b@x.com' },
        ],
        phones: [],
        addresses: [],
      },
      { k2: { contacts: sharers(n), truncated } },
    )

  test('anchored by row key, not position', () => {
    expect(warn(1)).toEqual([
      { anchor: 'emails#k2', label: 'email 2', message: 'Also used by P1' },
    ])
  })

  test('names the first three, then counts the rest', () => {
    expect(warn(3)[0].message).toBe('Also used by P1, P2, P3')
    expect(warn(4)[0].message).toBe('Also used by P1, P2, P3 and 1 other')
    expect(warn(6)[0].message).toBe('Also used by P1, P2, P3 and 3 others')
    expect(warn(6, true)[0].message).toBe(
      'Also used by P1, P2, P3 and at least 3 others',
    )
  })

  test('no sharers, no warning', () => {
    expect(warn(0)).toEqual([])
  })
})

describe('declaration warnings', () => {
  const full = {
    method: 'paperForm' as const,
    wordingVersion: HMRC_MODEL_WORDING_VERSION,
    firstName: 'Jo',
    lastName: 'Bloggs',
    addressLine1: '12',
    postcode: 'SW1A 1AA',
  }

  test('none for a complete written declaration', () => {
    expect(declarationWarnings(full)).toEqual([])
  })

  test('missing address, missing name, oral', () => {
    expect(
      declarationWarnings({ ...full, postcode: '' }).map((w) => w.anchor),
    ).toEqual(['postcode'])
    expect(
      declarationWarnings({ ...full, addressLine1: '', postcode: '' }).map(
        (w) => w.anchor,
      ),
    ).toEqual(['addressLine1'])
    expect(
      declarationWarnings({ ...full, lastName: '' }).map((w) => w.anchor),
    ).toEqual(['lastName'])
    expect(
      declarationWarnings({ ...full, method: 'oral' }).map((w) => w.anchor),
    ).toEqual(['method'])
  })

  test('staff ticked with no evidence; not the current wording', () => {
    expect(
      declarationWarnings({ ...full, method: 'staffTickedNoEvidence' }).map(
        (w) => w.label,
      ),
    ).toEqual(['No evidence yet'])
    expect(
      declarationWarnings({ ...full, wordingVersion: 'hmrc-2012' }).map(
        (w) => w.anchor,
      ),
    ).toEqual(['wordingVersion'])
  })
})
