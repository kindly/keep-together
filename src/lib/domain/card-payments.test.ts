import { expect, test } from 'vitest'
import {
  REASON_LABELS,
  REASON_MEANINGS,
  connectionState,
  declarationRefusedText,
  givePageUrl,
  pageProblems,
} from './card-payments'
import type { Onboarding, UnmatchedReason } from './card-payments'
import type { UnmatchedReason as WireReason } from '../data/rust-types/UnmatchedReason'

test('every reason the server queues a payment for is said plainly', () => {
  // The two unions are the same: a reason added in Rust fails to compile here.
  const same: WireReason extends UnmatchedReason
    ? UnmatchedReason extends WireReason
      ? true
      : never
    : never = true
  expect(same).toBe(true)
  for (const reason of [
    'ambiguous',
    'name_differs',
    'no_submission',
    'deceased',
    'contact_refused',
  ] as const) {
    expect(REASON_LABELS[reason]).not.toMatch(/_/)
    expect(REASON_MEANINGS[reason].length).toBeGreaterThan(40)
  }
  expect(REASON_MEANINGS.deceased).toMatch(/marked deceased/)
  expect(REASON_MEANINGS.no_submission).toMatch(/set it aside/)
})

test('a refused declaration says why, and a reason it doesn’t know is shown', () => {
  expect(declarationRefusedText('not_individual')).toMatch(/isn’t a person/)
  expect(declarationRefusedText('something_new')).toMatch(/\(something_new\)/)
})

test('the page link is /give/<group> on this site', () => {
  expect(givePageUrl('https://keep.example', 'riverside')).toBe(
    'https://keep.example/give/riverside',
  )
})

const page = (
  amounts: [number, number, number],
  minimum: number,
  maximum: number,
) => ({
  amounts: amounts.map(BigInt) as [bigint, bigint, bigint],
  minimum: BigInt(minimum),
  maximum: BigInt(maximum),
})

test('the page’s amounts follow the server’s rules', () => {
  expect(pageProblems(page([1000, 2500, 5000], 200, 100_000))).toEqual({})
  // Never under £1 or over £1,000, whatever the group wants.
  expect(pageProblems(page([1000, 2500, 5000], 99, 100_000))).toEqual({
    minimum: 'The minimum is at least £1.00',
  })
  expect(pageProblems(page([1000, 2500, 5000], 200, 100_001)).maximum).toMatch(
    /at most £1,000.00/,
  )
  expect(pageProblems(page([1000, 2500, 5000], 6000, 5000))).toEqual({
    minimum: 'The minimum can’t be more than the maximum',
  })
  // Buttons inside the range, each its own.
  expect(pageProblems(page([100, 2500, 2500], 200, 5000))).toEqual({
    'amounts.0': 'Between £2.00 and £50.00',
    'amounts.2': 'Each button needs its own amount',
  })
  // Something that isn't an amount.
  expect(
    pageProblems({ ...page([1000, 2500, 5000], 200, 5000), minimum: null }),
  ).toEqual({ minimum: 'An amount in pounds, like 10 or 2.50' })
})

const account = (over: Partial<Onboarding> = {}): Onboarding => ({
  connected: true,
  chargesEnabled: false,
  payoutsEnabled: false,
  detailsSubmitted: false,
  requirementsDue: 0,
  disabledReason: null,
  ...over,
})

test('where the Stripe account stands, and what carries it on', () => {
  expect(connectionState(account({ connected: false })).action).toBe(
    'Connect Stripe',
  )
  expect(connectionState(account())).toMatchObject({
    label: 'Stripe’s form isn’t finished',
    action: 'Continue at Stripe',
  })
  expect(
    connectionState(account({ detailsSubmitted: true, requirementsDue: 2 })),
  ).toMatchObject({ label: 'Stripe is checking', action: 'Answer Stripe' })
  const live = account({
    detailsSubmitted: true,
    chargesEnabled: true,
    payoutsEnabled: true,
  })
  expect(connectionState(live)).toMatchObject({
    label: 'Taking donations',
    action: null,
  })
  expect(connectionState({ ...live, payoutsEnabled: false }).detail).toMatch(
    /isn’t paying out/,
  )
  expect(connectionState({ ...live, requirementsDue: 1 }).action).toBe(
    'Answer Stripe',
  )
})
