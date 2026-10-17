/**
 * Payload validators for the contact contracts (the blocking tier is
 * deliberately loose: types and references only — ADR 0015).
 */
import { v } from 'convex/values'
import type { ObjectType } from 'convex/values'
import { channelLabel, contactKind } from '../schema'

export const detailsFields = {
  clientKey: v.optional(v.string()), // create only; idempotency key
  kind: contactKind,
  title: v.string(),
  firstName: v.string(),
  lastName: v.string(),
  nickname: v.string(),
  name: v.string(),
  birthDate: v.optional(v.string()),
  isDeceased: v.boolean(),
  deceasedDate: v.optional(v.string()),
  externalIdentifier: v.string(),
}

export const emailRow = v.object({
  key: v.optional(v.string()), // omitted = new row
  label: channelLabel,
  address: v.string(), // malformed is storable; warned, not blocked
  isPrimary: v.boolean(),
})

export const phoneRow = v.object({
  key: v.optional(v.string()),
  label: channelLabel,
  number: v.string(),
  isPrimary: v.boolean(),
})

export const addressRow = v.object({
  key: v.optional(v.string()),
  label: channelLabel,
  line1: v.string(),
  line2: v.string(),
  line3: v.string(),
  town: v.string(),
  postcode: v.string(),
  country: v.string(),
  isPrimary: v.boolean(),
})

export const methodsFields = {
  emails: v.array(emailRow),
  phones: v.array(phoneRow),
}

export const addressesFields = { addresses: v.array(addressRow) }

export const archiveFields = { archived: v.boolean() }

export const relationshipTypeFields = {
  labelAB: v.string(),
  labelBA: v.string(),
  kindA: v.optional(contactKind),
  kindB: v.optional(contactKind),
  isActive: v.boolean(),
}

export const relationshipFields = {
  contactA: v.id('contacts'),
  contactB: v.id('contacts'),
  typeId: v.id('relationshipTypes'),
  startDate: v.optional(v.string()),
  endDate: v.optional(v.string()),
  isActive: v.boolean(),
  description: v.string(),
}

export const noteFields = { body: v.string() } // ≤ NOTE_MAX_BYTES, in prepareNote

export const noteFlagsFields = { pinned: v.boolean(), archived: v.boolean() }

/** Create-only argument of `contacts.note`: never part of a payload. */
export const noteCreateFields = { contactId: v.id('contacts') }

export type Payloads = {
  details: ObjectType<typeof detailsFields>
  methods: ObjectType<typeof methodsFields>
  addresses: ObjectType<typeof addressesFields>
  archive: ObjectType<typeof archiveFields>
  relationshipType: ObjectType<typeof relationshipTypeFields>
  relationship: ObjectType<typeof relationshipFields>
  note: ObjectType<typeof noteFields>
  noteFlags: ObjectType<typeof noteFlagsFields>
}
