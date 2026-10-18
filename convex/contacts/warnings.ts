/**
 * Advisory validation (ADR 0015): storable but probably wrong. Never blocks
 * a save. Runs over the *saved* entity and its children, so it is the same
 * whether one contract or three wrote them. Shared by backend and UI.
 */

export type Warning = {
  /**
   * Field key like `emails.0` (saved-row index), or `emails#<row key>` for
   * a warning about the row's identity; empty = whole-contact notice.
   */
  anchor: string
  label: string
  message: string
}

const UK_POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}$/

export function looksLikeEmail(value: string): boolean {
  const at = value.lastIndexOf('@')
  return at > 0 && value.slice(at + 1).includes('.')
}

export function looksLikeUkPostcode(value: string): boolean {
  return UK_POSTCODE.test(value.toUpperCase().trim())
}

/**
 * Email row key → the other contacts in the tenant with the same address,
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
