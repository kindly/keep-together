/**
 * Contact search text (search plan, Q1). Pure: no Convex imports except
 * types. `searchText` builds the `contactSearch.text` a contact is found
 * by; `searchProjection.ts` stores it. Convex's tokenizer splits on
 * whitespace and punctuation and lowercases, so the text is folded words
 * joined by single spaces; whole-email and spaced-postcode forms are kept
 * because they are what a person types.
 */
import type { Kind } from './rules'

/** Lowercased, accents stripped (NFD, then combining marks removed). */
export function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

/**
 * The matching form of a phone number: digits only, with a UK
 * international prefix (`+44`, `0044`, and the `(0)` written after it)
 * turned into the leading 0, so "+44 (0)7700 900123", "07700 900123" and
 * "07700900123" are one number.
 */
export function normalisePhone(number: string): string {
  let digits = number.replace(/\(0\)/g, '').replace(/\D/g, '')
  if (digits.startsWith('00')) digits = digits.slice(2)
  if (digits.startsWith('44') && digits.length > 10) {
    digits = `0${digits.slice(2)}`
  }
  return digits
}

/** How many trailing digits of a phone are indexed on their own. */
export const PHONE_TAIL = 6

/** A UK postcode without spaces, and with the space before the inward code. */
function postcodeForms(postcode: string): Array<string> {
  const compact = postcode.replace(/\s+/g, '')
  if (!compact) return []
  const spaced =
    compact.length >= 5 ? `${compact.slice(0, -3)} ${compact.slice(-3)}` : ''
  return [compact, spaced]
}

export type SearchContact = {
  kind: Kind
  firstName: string
  lastName: string
  nickname: string
  name: string
  sortName: string
}

export type SearchChildren = {
  emails: Array<string>
  phones: Array<string>
  addresses: Array<{ line1: string; town: string; postcode: string }>
  identifiers: Array<string>
  tagNames: Array<string>
}

/**
 * Everything a contact is found by, as de-duplicated folded words:
 * names (given, family, nickname, organisation, sort name), each email
 * whole and split at `@` and `.`, each phone as digits and its last
 * PHONE_TAIL digits, each postcode compact and spaced, address line 1 and
 * town, identifier values, tag names. Not notes, not relationships.
 */
export function searchText(
  contact: SearchContact,
  children: SearchChildren,
): string {
  const parts: Array<string> = [
    contact.firstName,
    contact.lastName,
    contact.nickname,
    contact.name,
    contact.sortName,
  ]
  for (const email of children.emails) {
    const whole = email.trim()
    parts.push(whole, whole.replace(/[@.]/g, ' '))
  }
  for (const number of children.phones) {
    const digits = normalisePhone(number)
    parts.push(digits)
    if (digits.length > PHONE_TAIL) parts.push(digits.slice(-PHONE_TAIL))
  }
  for (const a of children.addresses) {
    parts.push(a.line1, a.town, ...postcodeForms(a.postcode))
  }
  parts.push(...children.identifiers, ...children.tagNames)

  const words = new Set<string>()
  for (const part of parts) {
    // Name punctuation ("Smith, Ann", "O'Brien") splits like the index does.
    for (const word of fold(part).split(/[\s,]+/)) if (word) words.add(word)
  }
  return [...words].join(' ')
}

/** The `contactSearch` row for a contact, minus the ids. */
export function searchRow(
  contact: SearchContact & { archived: boolean },
  children: SearchChildren,
): {
  text: string
  archived: boolean
  kind: Kind
  phones: Array<string>
  sortName: string
} {
  return {
    text: searchText(contact, children),
    archived: contact.archived,
    kind: contact.kind,
    sortName: contact.sortName,
    phones: [...new Set(children.phones.map(normalisePhone).filter(Boolean))],
  }
}

/** How many terms Convex search takes in one query. */
export const MAX_SEARCH_TERMS = 16

/** Words the way the search index splits them (on anything not a letter or digit). */
export function tokens(s: string): Array<string> {
  return fold(s)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
}

/**
 * What a search box entry asks for. A phone-shaped entry (digits and phone
 * punctuation only, at least PHONE_TAIL digits) becomes one normalised
 * number, so "07700 900123" matches as typed; anything else is its folded
 * words. `phone` is set for the exact-phone ranking.
 */
export function parseSearch(term: string): {
  terms: Array<string>
  phone: string | null
} {
  if (/^[\d\s+().-]+$/.test(term)) {
    const phone = normalisePhone(term)
    if (phone.length >= PHONE_TAIL) return { terms: [phone], phone }
  }
  return { terms: tokens(term).slice(0, MAX_SEARCH_TERMS), phone: null }
}

/**
 * Whether a search text holds every term: whole words, the last one as a
 * prefix. Convex ranks documents matching *any* term; the list keeps only
 * those matching all of them.
 */
export function matchesAll(text: string, terms: Array<string>): boolean {
  if (terms.length === 0) return false
  const words = tokens(text)
  const have = new Set(words)
  const last = terms[terms.length - 1]
  return (
    terms.slice(0, -1).every((t) => have.has(t)) &&
    words.some((w) => w.startsWith(last))
  )
}
