/**
 * Advisory validation (ADR 0015): storable but probably wrong. Never
 * blocks a save. Pure, over the *saved* entity; the server computes the
 * same warnings (`server/crates/{contacts,giving,giftaid}`), and these
 * are what the forms show as the user types.
 */
import type { DeclarationPayload } from '../data/rust-types/DeclarationPayload'

export type Warning = {
  /**
   * Field key like `emails.0` (saved-row index), or `emails#<row key>` for
   * a warning about the row's identity; empty = whole-entity notice.
   */
  anchor: string
  label: string
  message: string
}

// ── contacts ───────────────────────────────────────────────────────────────

const UK_POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}$/

export function looksLikeEmail(value: string): boolean {
  const at = value.lastIndexOf('@')
  return at > 0 && value.slice(at + 1).includes('.')
}

export function looksLikeUkPostcode(value: string): boolean {
  return UK_POSTCODE.test(value.toUpperCase().trim())
}

/**
 * Email row key → the other contacts in the group with the same address,
 * and whether the lookup was cut short. The caller looks them up, so
 * `contactWarnings` stays pure.
 */
export type Sharers = {
  contacts: Array<{ displayName: string; archived: boolean }>
  truncated: boolean
  /** Past the lookup's per-contact cap: nobody looked, so say so. */
  unchecked?: boolean
}
export type AlsoUsedBy = Partial<Record<string, Sharers>>

const NAMED_SHARERS = 3

function sharedEmailMessage({ contacts, truncated }: Sharers) {
  const names = contacts.map((c) =>
    c.archived ? `${c.displayName} (archived)` : c.displayName,
  )
  const shown = names.slice(0, NAMED_SHARERS)
  const rest = names.length - shown.length
  if (rest === 0 && !truncated) return `Also used by ${shown.join(', ')}`
  // Truncated: more exist than were read, so the count is a lower bound.
  const count = truncated ? `at least ${rest}` : `${rest}`
  const others = rest === 1 && !truncated ? 'other' : 'others'
  return `Also used by ${shown.join(', ')} and ${count} ${others}`
}

export function contactWarnings(
  contact: {
    emails: Array<{ key: string; address: string }>
    phones: Array<unknown>
    addresses: Array<{ country: string; postcode: string }>
  },
  alsoUsedBy: AlsoUsedBy = {},
): Array<Warning> {
  const warnings: Array<Warning> = []
  if (
    contact.emails.length === 0 &&
    contact.phones.length === 0 &&
    contact.addresses.length === 0
  ) {
    warnings.push({
      anchor: '',
      label: 'Contact',
      message: 'No email, phone or address yet',
    })
  }
  contact.emails.forEach((email, index) => {
    if (!looksLikeEmail(email.address)) {
      warnings.push({
        anchor: `emails.${index}`,
        label: `email ${index + 1}`,
        message: `“${email.address}” doesn’t look like an email address`,
      })
    }
    const shared = alsoUsedBy[email.key]
    if (shared?.unchecked) {
      warnings.push({
        anchor: `emails#${email.key}`,
        label: `email ${index + 1}`,
        message:
          'Not checked for other contacts using this address (too many addresses on this contact)',
      })
    } else if (shared && (shared.contacts.length || shared.truncated)) {
      // Anchored by key: the form's rows can be reordered or removed before
      // a save, and this warning names a person.
      warnings.push({
        anchor: `emails#${email.key}`,
        label: `email ${index + 1}`,
        message: sharedEmailMessage(shared),
      })
    }
  })
  contact.addresses.forEach((address, index) => {
    if (
      address.country === 'GB' &&
      address.postcode &&
      !looksLikeUkPostcode(address.postcode)
    ) {
      warnings.push({
        anchor: `addresses.${index}`,
        label: `address ${index + 1}`,
        message: `“${address.postcode}” doesn’t look like a UK postcode`,
      })
    }
  })
  return warnings
}

// ── gifts ──────────────────────────────────────────────────────────────────

/** Over this (pence) a gift is probably mistyped: £10,000. */
export const LARGE_GIFT = 1_000_000n

/** Years back Gift Aid can still be claimed. */
export const CLAIMABLE_YEARS = 4

/** `date` moved back `years` calendar years (ISO strings compare as dates). */
export function yearsBefore(date: string, years: number): string {
  const year = Number(date.slice(0, 4)) - years
  return `${String(year).padStart(4, '0')}${date.slice(4)}`
}

/** `today` is the caller's local ISO date. */
export function giftWarnings(
  gift: { receivedOn: string; amount: bigint },
  today: string,
): Array<Warning> {
  const warnings: Array<Warning> = []
  if (gift.receivedOn > today) {
    warnings.push({
      anchor: 'receivedOn',
      label: 'date',
      message: 'This date is in the future',
    })
  } else if (gift.receivedOn < yearsBefore(today, CLAIMABLE_YEARS)) {
    warnings.push({
      anchor: 'receivedOn',
      label: 'date',
      message: `More than ${CLAIMABLE_YEARS} years ago: too old to claim Gift Aid on`,
    })
  }
  if (gift.amount > LARGE_GIFT) {
    warnings.push({
      anchor: 'amount',
      label: 'amount',
      message: 'Over £10,000: check the amount',
    })
  }
  return warnings
}

// ── Gift Aid declarations ──────────────────────────────────────────────────

/** HMRC's current model declaration wording (`giftaid::HMRC_MODEL_WORDING_VERSION`). */
export const HMRC_MODEL_WORDING_VERSION = 'hmrc-2016-04'

/** What a saved declaration still lacks for HMRC. */
export function declarationWarnings(
  d: Pick<
    DeclarationPayload,
    | 'method'
    | 'wordingVersion'
    | 'firstName'
    | 'lastName'
    | 'addressLine1'
    | 'postcode'
  >,
): Array<Warning> {
  const warnings: Array<Warning> = []
  // 3.6.2: the donor's name (full name recommended).
  if (!d.firstName || !d.lastName) {
    warnings.push({
      anchor: d.firstName ? 'lastName' : 'firstName',
      label: 'Name',
      message: 'HMRC needs the donor’s first and last name',
    })
  }
  // 3.6.2: a UK home address is enough as house number or name + postcode.
  if (!d.addressLine1 || !d.postcode) {
    warnings.push({
      anchor: d.addressLine1 ? 'postcode' : 'addressLine1',
      label: 'Home address',
      message:
        'No house number or name and postcode: gifts can’t be claimed until the declaration has both',
    })
  }
  // 3.10.1: an oral declaration takes effect once the donor is sent a
  // written record of it; typing it into a database isn't enough.
  if (d.method === 'oral') {
    warnings.push({
      anchor: 'method',
      label: 'Made orally',
      message:
        'Not effective until the donor has been sent a written record of it',
    })
  }
  // Staff ticked with no form in hand: honest, but nothing yet shows the
  // donor made it. A claim leaves these out until evidence is recorded.
  if (d.method === 'staffTickedNoEvidence') {
    warnings.push({
      anchor: 'method',
      label: 'No evidence yet',
      message:
        'Gifts won’t be claimed until there is evidence the donor made this declaration',
    })
  }
  // 3.6.2: the donor must have been given HMRC's tax explanation; an older
  // wording may still be valid but is worth a look.
  if (d.wordingVersion !== HMRC_MODEL_WORDING_VERSION) {
    warnings.push({
      anchor: 'wordingVersion',
      label: 'Wording',
      message: 'Not HMRC’s current model declaration wording',
    })
  }
  return warnings
}
