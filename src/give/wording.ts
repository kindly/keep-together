/**
 * The Gift Aid declaration a donor is shown, by wording version. The
 * server says which version it will record (`GivePage.giftAid`, always
 * `giftaid::HMRC_MODEL_WORDING_VERSION`) and refuses a submission that
 * names any other, so what is stored is what was on screen. A version
 * this page has no text for is not offered at all.
 *
 * `hmrc-2016-04` is HMRC's model declaration for multiple donations (this
 * gift, future gifts and the past four years), revised October 2015 for
 * use from 6 April 2016:
 * https://www.gov.uk/guidance/gift-aid-declarations-claiming-tax-back-on-donations
 * A new HMRC wording is a new entry here and a new constant on the
 * server, never an edit to this one: declarations already made keep the
 * version they were made under.
 */

export interface Wording {
  /** Above the tick box. */
  heading: string
  intro: string
  /** The tick box's label: the declaration itself. */
  declaration: (amount: string, charity: string) => string
  /** The tax statement the donor agrees to with it (HMRC 3.6.2). */
  taxpayer: string
  /** Why the address is asked. */
  address: string
  /** What to tell the charity later. */
  notify: string
}

const WORDINGS: Record<string, Wording | undefined> = {
  'hmrc-2016-04': {
    heading: 'Boost your donation by 25p of Gift Aid for every £1 you donate',
    intro:
      'Gift Aid is reclaimed by the charity from the tax you pay for the current tax year.',
    declaration: (amount, charity) =>
      `I want to Gift Aid my donation of ${amount} and any donations I make in the future or have made in the past 4 years to ${charity}.`,
    taxpayer:
      'I am a UK taxpayer and understand that if I pay less Income Tax and/or Capital Gains Tax than the amount of Gift Aid claimed on all my donations in that tax year it is my responsibility to pay any difference.',
    address:
      'Your home address is needed to identify you as a current UK taxpayer.',
    notify:
      'Please tell the charity if you want to cancel this declaration, change your name or home address, or no longer pay sufficient tax on your income and/or capital gains.',
  },
}

/** The text for `version`, or null if this page doesn't have it. */
export function wordingFor(version: string): Wording | null {
  return WORDINGS[version] ?? null
}
