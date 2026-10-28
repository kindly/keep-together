/**
 * The contact shapes the pages and the form render, and the few pure
 * rules they share with the server (`server/crates/contacts`, whose ts-rs
 * types the wire adapter turns into these: ids branded, the view's slices
 * flattened). Keep the rules in step with the Rust ones they name.
 */
import type { Id } from './ids'
import type { ChannelLabel } from '../data/rust-types/ChannelLabel'
import type { ContactKind } from '../data/rust-types/ContactKind'
import type { SourceCodeDescription as WireSourceCode } from '../data/rust-types/SourceCodeDescription'

export type { ChannelLabel, ContactKind }

// ── form slices (the `contacts.*` contract payloads) ──────────────────────

type DetailsPayload = {
  /** Create only; idempotency key. */
  clientKey?: string
  kind: ContactKind
  title: string
  firstName: string
  lastName: string
  nickname: string
  name: string
  birthDate?: string
  isDeceased: boolean
  deceasedDate?: string
}

/** A child row; `key` omitted = a new row (ADR 0014). */
type EmailPayloadRow = {
  key?: string
  label: ChannelLabel
  address: string
  isPrimary: boolean
}

type PhonePayloadRow = {
  key?: string
  label: ChannelLabel
  number: string
  isPrimary: boolean
}

type AddressPayloadRow = {
  key?: string
  label: ChannelLabel
  line1: string
  line2: string
  line3: string
  town: string
  postcode: string
  country: string
  isPrimary: boolean
}

type IdentifierPayloadRow = {
  key?: string
  /** Identity field: immutable per key. */
  typeId: Id<'identifierTypes'>
  /** Identity field: immutable per key. */
  value: string
}

/** One dropdown field's value on a contact. */
export type FieldValue = {
  fieldId: Id<'contactFields'>
  optionId: Id<'contactFieldOptions'>
}

/** The contact slices the form edits, as the save sends them. */
export type Payloads = {
  details: DetailsPayload
  methods: { emails: Array<EmailPayloadRow>; phones: Array<PhonePayloadRow> }
  addresses: { addresses: Array<AddressPayloadRow> }
  identifiers: { identifiers: Array<IdentifierPayloadRow> }
  fields: { values: Array<FieldValue> }
}

// ── dropdown field definitions ─────────────────────────────────────────────

export type FieldOptionView = {
  _id: Id<'contactFieldOptions'>
  fieldId: Id<'contactFields'>
  label: string
  position: number
  isActive: boolean
  /** Has been on a contact: archive only, never delete. */
  used: boolean
  saveVersion: number
}

/** A live field and its options in the admin's order. */
export type FieldDefinition = {
  _id: Id<'contactFields'>
  label: string
  appliesTo: Array<ContactKind>
  /** False: archived, hidden from the form and filters; values kept. */
  isActive: boolean
  /**
   * A retire is clearing its values (or stopped part way: run it again).
   * No new values, and it can't be reactivated.
   */
  retiring: boolean
  /** The field's place among the live ones (from 1): the pages order by it. */
  slot: number
  saveVersion: number
  /** Archived ones included. */
  options: Array<FieldOptionView>
  /** No option was ever used: the whole field can be deleted. */
  deletable: boolean
}

// ── the list and search ────────────────────────────────────────────────────

/** The list's and search's filters. */
export type ListFilters = {
  includeArchived?: boolean
  kind?: ContactKind
  source?: {
    id: Id<'sourceCodes'>
    level: 'version' | 'category' | 'detail'
  }
  /** `optionId: null` = contacts with no value for the field. */
  fields?: Array<{
    fieldId: Id<'contactFields'>
    optionId: Id<'contactFieldOptions'> | null
  }>
}

export type ListRow = {
  _id: Id<'contacts'>
  kind: ContactKind
  displayName: string
  sortName: string
  number: number
  archived: boolean
  /** The primary email, if any. */
  email: string | null
  fieldOptionIds: Array<Id<'contactFieldOptions'>>
}

export type SearchArgs = ListFilters & { search?: string }

export type SearchResult = {
  rows: Array<ListRow>
  /** More matched than were read. */
  truncated: boolean
  /** Too few letters to search a large group: nothing was read. */
  tooBroad: boolean
  checked: number
  /** The contact whose number the search was. */
  numberMatch: Id<'contacts'> | null
  /** A six-digit entry whose check digit fails: the hint to show. */
  invalidNumber: string | null
}

// ── one contact ────────────────────────────────────────────────────────────

export type SourceCodeDescription = Omit<
  WireSourceCode,
  'versionId' | 'detailId' | 'categoryId'
> & {
  versionId: Id<'sourceCodes'>
  detailId: Id<'sourceCodes'>
  categoryId: Id<'sourceCodes'>
}

export type FieldValueView = {
  fieldId: Id<'contactFields'>
  label: string
  slot: number
  /** False: the field is archived (the value is kept and still shown). */
  fieldActive: boolean
  optionId: Id<'contactFieldOptions'>
  /** '?' when the option can't be found. */
  optionLabel: string
  /** False: the option is archived (kept on contacts that have it). */
  optionActive: boolean
}

/** A saved child row: it always has its key. */
type Saved<TRow extends { key?: string }> = Omit<TRow, 'key'> & { key: string }

/** A contact as its page and form render it: the root and its slices. */
export type ContactView = {
  contact: Omit<DetailsPayload, 'clientKey'> & {
    _id: Id<'contacts'>
    displayName: string
    sortName: string
    number: number
    archived: boolean
    acquisitionCodeId?: Id<'sourceCodes'>
    detailsVersion: number
    methodsVersion: number
    addressesVersion: number
    fieldsVersion: number
    archiveVersion: number
    identifiersVersion: number
    acquisitionVersion: number
  }
  emails: Array<Saved<EmailPayloadRow>>
  phones: Array<Saved<PhonePayloadRow>>
  addresses: Array<Saved<AddressPayloadRow>>
  identifiers: Array<
    Saved<IdentifierPayloadRow> & { typeName: string; typeActive: boolean }
  >
  acquisition: SourceCodeDescription | null
  fields: Array<FieldValueView>
}

/** A contact note as the notes panel renders it. */
export type Note = {
  _id: Id<'contactNotes'>
  /** When it was written (ms). */
  _creationTime: number
  contactId: Id<'contacts'>
  body: string
  pinned: boolean
  archived: boolean
  createdBy?: Id<'users'>
  editedBy?: Id<'users'>
  editedAt: number
  bodyVersion: number
  flagsVersion: number
}

// ── limits and pure rules (as `server/crates/contacts`) ────────────────────

/** The most identifier types a group can have. */
export const IDENTIFIER_TYPE_LIMIT = 200

/** The longest note, in UTF-8 bytes. */
export const NOTE_MAX_BYTES = 20_000

/** An email address as suppressions and "also used by" key it. */
export function normaliseEmail(address: string): string {
  return address.trim().toLowerCase()
}

/** Values in one order (by field id), so equal states compare equal. */
export function sortValues(values: Array<FieldValue>): Array<FieldValue> {
  return [...values].sort((a, b) => a.fieldId.localeCompare(b.fieldId))
}

/** A group's first contact number. */
export const FIRST_NUMBER = 10001

/**
 * The Luhn check digit for `sequence`: catches every single wrong digit
 * and every swap of two neighbouring digits except 09↔90.
 */
export function checkDigit(sequence: number): number {
  const digits = String(sequence)
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    // Doubled: the rightmost digit, then every second one leftwards.
    let d = Number(digits[digits.length - 1 - i])
    if (i % 2 === 0) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  return (10 - (sum % 10)) % 10
}

/** The number as staff see and write it: the sequence and its check digit. */
export function formatNumber(sequence: number): string {
  return `${sequence}${checkDigit(sequence)}`
}

/** The longest note an admin can give for releasing a held address. */
export const SUPPRESSION_NOTE_MAX = 500
