/**
 * Advisory validation (ADR 0015): storable but probably wrong. Never blocks
 * a save. Runs over the *saved* entity and its children, so it is the same
 * whether one contract or three wrote them. Shared by backend and UI.
 */

export type Warning = {
  /** Field key like `emails.0`; empty = whole-contact notice. */
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

export function contactWarnings(contact: {
  emails: Array<{ address: string }>
  phones: Array<unknown>
  addresses: Array<{ country: string; postcode: string }>
}): Array<Warning> {
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
