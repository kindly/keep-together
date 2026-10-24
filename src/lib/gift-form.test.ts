import { describe, expect, test } from 'vitest'
import type { Id } from '../../convex/_generated/dataModel'
import {
  amountPence,
  asksForAddress,
  defaultCode,
  differsNote,
  draftProblems,
  freshDraft,
  giftAidOffer,
  isDirty,
  newDonor,
  noAddressWarning,
  partialHome,
  splitName,
  toArgs,
} from './gift-form'
import type { DonorChoice, DonorInfo, GiftDraft } from './gift-form'

const TODAY = '2026-10-23'
const JO = 'jo' as Id<'contacts'>
const STREET = 'street' as Id<'sourceCodes'>
const ONLINE = 'online' as Id<'sourceCodes'>

const existing: DonorChoice = {
  kind: 'existing',
  id: JO,
  displayName: 'Jo Bloggs',
}

function info(over: Partial<DonorInfo> = {}): DonorInfo {
  return {
    id: JO,
    kind: 'individual',
    displayName: 'Jo Bloggs',
    firstName: 'Jo',
    lastName: 'Bloggs',
    home: { line1: '', postcode: '', completable: false },
    acquisition: null,
    covering: null,
    ...over,
  }
}

const described = (
  versionId: Id<'sourceCodes'>,
  code: string,
  isActive = true,
) => ({ versionId, code, isActive }) as DonorInfo['acquisition']

function draft(over: Partial<GiftDraft> = {}): GiftDraft {
  return {
    ...freshDraft(TODAY),
    donor: existing,
    code: { id: STREET, shown: { code: 'Street-Wesser-001', isActive: true } },
    amountText: '20',
    ...over,
  }
}

describe('names typed in the search', () => {
  test('first word first, the rest last', () => {
    expect(splitName('  Jo  van Dyke ')).toEqual({
      firstName: 'Jo',
      lastName: 'van Dyke',
    })
    expect(splitName('Jo')).toEqual({ firstName: 'Jo', lastName: '' })
  })

  test('an organisation keeps the whole text', () => {
    expect(newDonor('organization', ' Acme Ltd ')).toMatchObject({
      kind: 'new',
      contactKind: 'organization',
      name: 'Acme Ltd',
    })
  })
})

describe('fresh and dirty', () => {
  test('a fresh form is clean; after a save the next keeps date and method', () => {
    const first = freshDraft(TODAY)
    expect(isDirty(first, first)).toBe(false)
    const next = freshDraft(TODAY, { receivedOn: '2026-10-01', method: 'card' })
    expect(next).toMatchObject({
      receivedOn: '2026-10-01',
      method: 'card',
      code: null,
      donor: null,
      amountText: '',
      reference: '',
    })
    expect(isDirty(next, next)).toBe(false)
    expect(isDirty({ ...next, amountText: '5' }, next)).toBe(true)
    expect(isDirty({ ...next, method: 'cash' }, next)).toBe(true)
  })
})

describe('Gift Aid offer', () => {
  test('a person: the tick; covered: ✓; organisation: none', () => {
    expect(giftAidOffer(existing, info())).toBe('tick')
    expect(
      giftAidOffer(
        existing,
        info({
          covering: {
            id: 'd',
            scope: 'future',
            method: 'paperForm',
            madeOn: '2026-03-03',
            cancelledFrom: null,
          },
        }),
      ),
    ).toBe('covered')
    expect(giftAidOffer(existing, info({ kind: 'organization' }))).toBe('none')
    expect(giftAidOffer(newDonor('individual', 'Jo B'), undefined)).toBe('tick')
    expect(giftAidOffer(newDonor('organization', 'Acme'), undefined)).toBe(
      'none',
    )
    // Not known yet.
    expect(giftAidOffer(existing, undefined)).toBe('none')
  })
})

describe('the address under the tick (g3q3, cash-2 L1)', () => {
  const complete = info({
    home: { line1: '12 High St', postcode: 'AB1 2CD', completable: false },
  })

  test('a complete address on file: no fields, and nothing typed is sent', () => {
    const d = draft({ giftAid: true, line1: '9', postcode: '' })
    expect(asksForAddress(d, complete)).toBe(false)
    expect(draftProblems(d, complete)).toEqual([])
    const args = toArgs(d, complete, 'k')
    expect(args.home).toBeUndefined()
    expect(args.giftAid).toEqual({
      scope: 'futureAndPast4y',
      method: 'staffTickedNoEvidence',
    })
  })

  test('no address on file: half typed blocks, either way round', () => {
    expect(
      draftProblems(draft({ giftAid: true, line1: '12 High St' }), info()),
    ).toEqual([
      { field: 'postcode', message: 'Add the postcode, or clear line 1' },
    ])
    expect(
      draftProblems(draft({ giftAid: true, postcode: 'AB1 2CD' }), info()).map(
        (p) => p.field,
      ),
    ).toEqual(['line1'])
  })

  test('both typed: sent as home', () => {
    const d = draft({
      giftAid: true,
      line1: ' 12 High St ',
      postcode: 'ab1 2cd',
    })
    expect(toArgs(d, info(), 'k').home).toEqual({
      line1: '12 High St',
      postcode: 'ab1 2cd',
    })
  })

  test('none typed: saves with a warning, no home sent', () => {
    const d = draft({ giftAid: true })
    expect(draftProblems(d, info())).toEqual([])
    expect(noAddressWarning(d, info())).toMatch(/can’t be claimed/)
    expect(toArgs(d, info(), 'k').home).toBeUndefined()
  })

  test('the fields start with the address on file only when it is completed in place', () => {
    expect(
      partialHome(
        info({
          home: { line1: '5 Engine St', postcode: '', completable: true },
        }),
      ),
    ).toEqual({ line1: '5 Engine St', postcode: '' })
    // An overseas or work row: what is typed is a new address.
    expect(
      partialHome(
        info({
          home: { line1: '9 Rue Haute', postcode: '', completable: false },
        }),
      ),
    ).toEqual({ line1: '', postcode: '' })
  })

  test('not ticked: no fields, nothing sent', () => {
    const d = draft({ line1: '12 High St' })
    expect(asksForAddress(d, info())).toBe(false)
    const args = toArgs(d, info(), 'k')
    expect(args.home).toBeUndefined()
    expect(args.giftAid).toBeUndefined()
  })

  test('a tick on an organisation is never sent', () => {
    const d = draft({ giftAid: true })
    expect(
      toArgs(d, info({ kind: 'organization' }), 'k').giftAid,
    ).toBeUndefined()
  })
})

describe('blocking checks', () => {
  test('no donor, no code, no amount', () => {
    const d = { ...freshDraft(TODAY) }
    expect(draftProblems(d, undefined).map((p) => p.field)).toEqual([
      'contact',
      'sourceCode',
      'amount',
    ])
  })

  test('the amount: not money, zero, negative', () => {
    const fields = (amountText: string) =>
      draftProblems(draft({ amountText }), info()).map((p) => p.message)
    expect(fields('20.505')).toEqual([
      'Write the amount in pounds, like 20 or 12.50',
    ])
    expect(fields('0')).toEqual(['The amount must be over £0'])
    expect(fields('-5')).toEqual(['The amount must be over £0'])
    expect(fields('£1,250.5')).toEqual([])
  })

  test('a new person needs both names; an organisation its name', () => {
    expect(
      draftProblems(draft({ donor: newDonor('individual', 'Jo') }), undefined),
    ).toEqual([{ field: 'lastName', message: 'A last name is needed' }])
    expect(
      draftProblems(draft({ donor: newDonor('organization', ' ') }), undefined),
    ).toEqual([{ field: 'name', message: 'A name is needed' }])
  })
})

describe('the args', () => {
  test('pence from the typed pounds, one allocation, the client key', () => {
    expect(toArgs(draft({ amountText: '£1,250.50' }), info(), 'key-1')).toEqual(
      {
        clientKey: 'key-1',
        contact: JO,
        receivedOn: TODAY,
        amount: 125050n,
        method: 'cash',
        allocations: [{ sourceCodeId: STREET, amount: 125050n }],
      },
    )
  })

  test('a reference only on card', () => {
    expect(
      toArgs(draft({ method: 'card', reference: ' SU-123 ' }), info(), 'k')
        .reference,
    ).toBe('SU-123')
    expect(
      toArgs(draft({ method: 'cash', reference: 'SU-123' }), info(), 'k')
        .reference,
    ).toBeUndefined()
  })

  test('a new person with email; a new organisation with only its name', () => {
    const jo = { ...newDonor('individual', 'Jo Bloggs'), email: ' jo@x.test ' }
    expect(
      toArgs(draft({ donor: jo as DonorChoice }), undefined, 'k').contact,
    ).toEqual({
      kind: 'individual',
      firstName: 'Jo',
      lastName: 'Bloggs',
      name: '',
      email: 'jo@x.test',
    })
    expect(
      toArgs(draft({ donor: newDonor('organization', 'Acme') }), undefined, 'k')
        .contact,
    ).toEqual({
      kind: 'organization',
      firstName: '',
      lastName: '',
      name: 'Acme',
    })
  })
})

describe('the source code', () => {
  test('defaults to the donor’s own unless archived (g2q1)', () => {
    expect(
      defaultCode(
        info({ acquisition: described(STREET, 'Street-Wesser-001') }),
      ),
    ).toMatchObject({ id: STREET, shown: { code: 'Street-Wesser-001' } })
    expect(
      defaultCode(
        info({ acquisition: described(STREET, 'Street-Wesser-001', false) }),
      ),
    ).toBeNull()
    expect(defaultCode(info())).toBeNull()
  })

  test('a different pick is noted (g2q2)', () => {
    const own = info({ acquisition: described(STREET, 'Street-Wesser-001') })
    expect(differsNote(draft(), own)).toBeNull()
    expect(
      differsNote(
        draft({
          code: {
            id: ONLINE,
            shown: { code: 'Online-Spring-001', isActive: true },
          },
        }),
        own,
      ),
    ).toBe('Differs from Jo’s source, Street-Wesser-001')
    // No code of their own: nothing to differ from.
    expect(differsNote(draft(), info())).toBeNull()
  })
})

describe('amounts', () => {
  test('a space inside is ambiguous; around it is fine', () => {
    expect(amountPence('12 50')).toBe('ambiguous')
    expect(amountPence('1 250.00')).toBe('ambiguous')
    expect(amountPence('12 .50')).toBe('ambiguous')
    expect(amountPence(' 12.50 ')).toBe(1250n)
    expect(amountPence('£ 12.50')).toBe(1250n)
  })

  // Pence travel as JSON integers: past 2^53 a number isn't exact.
  test('past what a JSON integer carries exactly is too large', () => {
    expect(amountPence('90071992547409.91')).toBe(
      BigInt(Number.MAX_SAFE_INTEGER),
    )
    expect(amountPence('90071992547409.92')).toBe('tooLarge')
  })
})
