import { expect, test } from 'vitest'
import { formatPence, fromWire, giftAidOn, parsePounds, toWire } from './money'

test('pounds as typed become pence, never through a float', () => {
  expect(parsePounds('20')).toBe(2000n)
  expect(parsePounds(' £20.5 ')).toBe(2050n)
  expect(parsePounds('1,000')).toBe(100000n)
  expect(parsePounds('.5')).toBe(50n)
  // 0.29 * 100 is 28.999… as a float.
  expect(parsePounds('0.29')).toBe(29n)
  expect(parsePounds('19.99')).toBe(1999n)
})

test('anything that is not an amount is no amount', () => {
  for (const text of [
    '',
    ' ',
    '£',
    'ten',
    '20.123',
    '-20',
    '1,00',
    '2e3',
    '20 pounds',
  ])
    expect(parsePounds(text), text).toBeNull()
})

test('pence read as pounds, with pennies only when there are some', () => {
  expect(formatPence(2500n)).toBe('£25')
  expect(formatPence(250n)).toBe('£2.50')
  expect(formatPence(100000n)).toBe('£1,000')
  expect(formatPence(5n)).toBe('£0.05')
})

test('Gift Aid adds a quarter, rounded down to a penny', () => {
  expect(giftAidOn(2500n)).toBe(625n)
  expect(giftAidOn(199n)).toBe(49n)
})

test('the wire carries whole pence', () => {
  expect(fromWire(2500)).toBe(2500n)
  expect(toWire(100000n)).toBe(100000)
})
