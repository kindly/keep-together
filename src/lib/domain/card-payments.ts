// Card donations through Stripe (plan stripe.sv, S5): what the staff
// screens say, and the donation page's rules as the server holds them
// (`giving::stripe::prepare_page`: keep the two in step). Pence are
// bigint (rule 7).
import { formatPence } from '../gifts'
import { ONE_OFF_MAX } from './one-off'

/** Why a card payment is waiting for staff (`giving::stripe::UnmatchedReason`). */
export type UnmatchedReason =
  | 'ambiguous'
  | 'name_differs'
  | 'no_submission'
  | 'deceased'
  | 'contact_refused'

/** A few words for the queue's row. */
export const REASON_LABELS: Record<UnmatchedReason, string> = {
  ambiguous: 'Several contacts share this email',
  name_differs: 'Different last name',
  deceased: 'Contact is marked deceased',
  contact_refused: 'Couldn’t make a contact',
  no_submission: 'Not from the donation page',
}

/** Each reason plainly, with what staff do about it. */
export const REASON_MEANINGS: Record<UnmatchedReason, string> = {
  ambiguous:
    'More than one contact has the email address the donor typed, so we couldn’t tell whose gift this is. Choose the right contact.',
  name_differs:
    'One contact has the email address the donor typed, but under a different last name. Check it is the same person, or choose another contact.',
  deceased:
    'The only contact with the email address the donor typed is marked deceased. Someone else may be using the address: choose who gave.',
  contact_refused:
    'What the donor typed couldn’t be saved as a new contact. Choose the contact, or add them first and then match.',
  no_submission:
    'This payment arrived on the group’s Stripe account without coming through the donation page (a payment link or invoice made in Stripe, say). If it is a donation, match it to its donor; if it isn’t, set it aside.',
}

/**
 * Why a donor's ticked Gift Aid declaration wasn't recorded on the
 * contact their gift went to (`declarationRefused`: Gift Aid's own
 * reason code).
 */
export function declarationRefusedText(reason: string): string {
  switch (reason) {
    case 'not_individual':
      return 'The donor ticked Gift Aid, but this contact isn’t a person, so no declaration was recorded. If the donor is a person, record their declaration on their own contact.'
    case 'declaration_limit':
      return 'The donor ticked Gift Aid, but this contact already has as many declarations as can be held, so this one wasn’t recorded.'
    default:
      return `The donor ticked Gift Aid, but their declaration couldn’t be recorded on this contact (${reason}). Check the contact’s Gift Aid and add a declaration by hand if one is due.`
  }
}

/** Where donors give: `/give/<group>` on this site. */
export function givePageUrl(origin: string, slug: string): string {
  return `${origin}/give/${encodeURIComponent(slug)}`
}

/** The least a page ever takes (£1) and the most (a one-off's cap, £1,000). */
export const DONATION_FLOOR = 100n
export const DONATION_CEILING = ONE_OFF_MAX

export type PageAmounts = {
  amounts: [bigint | null, bigint | null, bigint | null]
  minimum: bigint | null
  maximum: bigint | null
}

export type PageProblems = Partial<
  Record<
    'minimum' | 'maximum' | 'amounts.0' | 'amounts.1' | 'amounts.2',
    string
  >
>

/**
 * What's wrong with the page's amounts, as the server would say it: a
 * minimum of at least £1, a maximum of at most £1,000, the minimum no
 * more than the maximum, three different buttons inside them. `null` is
 * something that isn't an amount.
 */
export function pageProblems(p: PageAmounts): PageProblems {
  const out: PageProblems = {}
  const notAmount = 'An amount in pounds, like 10 or 2.50'
  if (p.minimum === null) out.minimum = notAmount
  else if (p.minimum < DONATION_FLOOR)
    out.minimum = `The minimum is at least ${formatPence(DONATION_FLOOR)}`
  if (p.maximum === null) out.maximum = notAmount
  else if (p.maximum > DONATION_CEILING)
    out.maximum = `The maximum is at most ${formatPence(DONATION_CEILING)}: larger gifts come by bank transfer`
  if (
    p.minimum !== null &&
    p.maximum !== null &&
    !out.minimum &&
    p.minimum > p.maximum
  )
    out.minimum = 'The minimum can’t be more than the maximum'
  p.amounts.forEach((amount, i) => {
    const key = `amounts.${i}` as 'amounts.0' | 'amounts.1' | 'amounts.2'
    if (amount === null) {
      out[key] = notAmount
      return
    }
    // The buttons are judged against a range that is itself right.
    if (out.minimum || out.maximum || p.minimum === null || p.maximum === null)
      return
    if (amount < p.minimum || amount > p.maximum)
      out[key] =
        `Between ${formatPence(p.minimum)} and ${formatPence(p.maximum)}`
    else if (p.amounts.slice(0, i).includes(amount))
      out[key] = 'Each button needs its own amount'
  })
  return out
}

/** What Stripe's onboarding has got to, as `GET stripe` answers it. */
export type Onboarding = {
  connected: boolean
  chargesEnabled: boolean
  payoutsEnabled: boolean
  detailsSubmitted: boolean
  requirementsDue: number
  disabledReason: string | null
}

/**
 * Where the group's Stripe account stands, in a word and a sentence, and
 * what the button that carries on says (none: nothing to do at Stripe).
 */
export function connectionState(s: Onboarding): {
  label: string
  detail: string
  action: string | null
} {
  if (!s.connected)
    return {
      label: 'Not connected',
      detail:
        'Connecting makes a Stripe account for the group and takes you to Stripe’s own form for its details and bank account. Donors’ money goes straight to that account.',
      action: 'Connect Stripe',
    }
  if (s.chargesEnabled && s.detailsSubmitted) {
    if (s.requirementsDue > 0)
      return {
        label: 'Taking donations',
        detail:
          'Stripe is taking card payments for the group, and is asking for more details: answer it, or Stripe may pause payments.',
        action: 'Answer Stripe',
      }
    return {
      label: 'Taking donations',
      detail: s.payoutsEnabled
        ? 'Stripe takes card payments for the group and pays them out to its bank account.'
        : 'Stripe takes card payments for the group. It isn’t paying out to the bank account yet: check the group’s Stripe Dashboard.',
      action: null,
    }
  }
  if (!s.detailsSubmitted)
    return {
      label: 'Stripe’s form isn’t finished',
      detail:
        'The group’s Stripe account exists, but Stripe’s form hasn’t been sent in. No donations can be taken until it is.',
      action: 'Continue at Stripe',
    }
  return {
    label: 'Stripe is checking',
    detail: s.disabledReason
      ? `Stripe isn’t taking payments for the group yet (${s.disabledReason}). It may need more details.`
      : 'Stripe has the group’s details and isn’t taking payments yet. This usually clears by itself; if Stripe wants more, it says so on its form.',
    action: s.requirementsDue > 0 ? 'Answer Stripe' : 'Open Stripe’s form',
  }
}
