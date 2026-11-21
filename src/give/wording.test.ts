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
  // The model's own lines around them.
  expect(w.intro).toEqual([
    'Gift Aid is reclaimed by the charity from the tax you pay for the current tax year.',
    'Your address is needed to identify you as a current UK taxpayer.',
  ])
  expect(w.notify.lead).toBe('Please notify the charity if you:')
  expect(w.notify.items).toHaveLength(3)
  expect(w.higherRate).toBe(
    'If you pay Income Tax at the higher or additional rate and want to receive the additional tax relief due to you, you must include all your Gift Aid donations on your Self-Assessment tax return or ask HM Revenue and Customs to adjust your tax code.',
  )
})

test('a wording the page has no text for is not offered', () => {
  expect(wordingFor('hmrc-2031-01')).toBeNull()
  expect(wordingFor('')).toBeNull()
})
