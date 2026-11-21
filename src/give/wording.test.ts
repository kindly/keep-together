import { expect, test } from 'vitest'
import { wordingFor } from './wording'
import { HMRC_MODEL_WORDING_VERSION } from '#/lib/domain/warnings'

test('the page has the text of the wording the server records', () => {
  // `giftaid::HMRC_MODEL_WORDING_VERSION`, which `GET /api/give/{slug}`
  // answers and `POST …/donations` insists on.
  const w = wordingFor(HMRC_MODEL_WORDING_VERSION)!
  expect(w).not.toBeNull()
  // HMRC's model declaration for multiple donations, word for word.
  expect(w.declaration('£25', 'Riverside Food Bank')).toBe(
    'I want to Gift Aid my donation of £25 and any donations I make in the future or have made in the past 4 years to Riverside Food Bank.',
  )
  expect(w.taxpayer).toBe(
    'I am a UK taxpayer and understand that if I pay less Income Tax and/or Capital Gains Tax than the amount of Gift Aid claimed on all my donations in that tax year it is my responsibility to pay any difference.',
  )
})

test('a wording the page has no text for is not offered', () => {
  expect(wordingFor('hmrc-2031-01')).toBeNull()
  expect(wordingFor('')).toBeNull()
})
