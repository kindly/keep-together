/**
 * The contacts endpoints' JSON (step 2a), and the adapters between it and
 * the shapes the pages already render (the Convex view, `ListRow`,
 * `FieldDefinition`), so both backends feed the same components.
 *
 * PROVISIONAL: step 2a's ts-rs types (`../rust-types/`) replace the wire
 * types below once it lands; only this file should need to change. What is
 * assumed, from rs/README.md and the plan:
 *
 * - child rows carry `id` (32 hex, ADR 0014) where Convex's carry `key`;
 *   a row with no id is new and the server mints one;
 * - a slice's payload is otherwise Convex's (`Payloads[slice]`), and its
 *   contract is `contacts.<slice>`;
 * - the form's save is `POST contacts/{id}/save {source, slices: {<slice>:
 *   {expected, …payload}}}` → `{slices: {<slice>: Executed}}`, one
 *   transaction, so a 409 refuses every slice in it;
 * - a 422 `invalid` problem's `field` is `<slice>.<field within it>`.
 */
import type { Id } from '../../../../convex/_generated/dataModel'
import type { FieldDefinition } from '../../../../convex/contacts/fieldTypes'
import type { FieldSlot } from '../../../../convex/lib/fieldSlots'
import type { Payloads } from '../../../../convex/contacts/validators'
import type { ListRow } from '../../paged-list'
import type { SliceName, Slices } from '../../contact-form-state'
import type { ContactView, SearchResult } from '../types'
import type { Executed } from '../rust-types/Executed'
import type { Source } from '../rust-types/Source'

type Kind = Payloads['details']['kind']

/** A row of the list and of search. */
export type WireListRow = {
  id: string
  number: number
  kind: Kind
  displayName: string
  archived: boolean
  /** The first email, if any. */
  email: string | null
  /** Option ids, in field order. */
  fieldOptionIds: Array<string>
}

/** `GET contacts?…&after=<cursor>`: keyset paging on (sort key, id). */
export type WireListPage = { rows: Array<WireListRow>; next: string | null }

/** `GET contacts/search?q=…`: one window, as Convex's `search`. */
export type WireSearch = {
  rows: Array<WireListRow>
  truncated: boolean
  numberMatch: string | null
  invalidNumber: string | null
}

type WithId<T> = Omit<T, 'key'> & { id?: string }

export type WireEmail = WithId<Payloads['methods']['emails'][number]>
export type WirePhone = WithId<Payloads['methods']['phones'][number]>
export type WireAddress = WithId<Payloads['addresses']['addresses'][number]>

/** The slices the Rust backend has (no identifiers, no acquisition). */
export type RustSlice = Exclude<SliceName, 'identifiers'>
export const RUST_SLICES: Array<RustSlice> = [
  'details',
  'methods',
  'addresses',
  'fields',
]

/** `GET contacts/{id}`. */
export type WireContact = {
  id: string
  number: number
  displayName: string
  archived: boolean
  details: Payloads['details']
  emails: Array<WireEmail>
  phones: Array<WirePhone>
  addresses: Array<WireAddress>
  fields: Payloads['fields']['values']
  counters: Record<RustSlice | 'archive', number>
}

/** `GET fields`. */
export type WireField = {
  id: string
  label: string
  appliesTo: Array<Kind>
  isActive: boolean
  options: Array<{
    id: string
    label: string
    position: number
    isActive: boolean
  }>
}

export type WireSave = {
  source: Source
  slices: Partial<Record<RustSlice, Record<string, unknown>>>
}
export type WireSaved = { slices: Partial<Record<RustSlice, Executed>> }

// ── child-row ids ──────────────────────────────────────────────────────────

/**
 * Rows in a slice payload, `key` → `id`. The form mints keys with
 * `crypto.randomUUID()`; the server's ids are the same 128 bits as 32 hex
 * chars, so the dashes go. An empty key is a new row: no id.
 */
export function sliceToWire(value: unknown): Record<string, unknown> {
  return mapRows(value, (row) => {
    const { key, ...rest } = row as { key?: string }
    return key ? { ...rest, id: key.replace(/-/g, '') } : rest
  })
}

/** Rows in a slice payload, `id` → `key`. */
export function sliceFromWire<TSlice extends SliceName>(
  _slice: TSlice,
  value: unknown,
): Slices[TSlice] {
  return mapRows(value, (row) => {
    const { id, ...rest } = row as { id?: string }
    return id ? { key: id, ...rest } : rest
  }) as Slices[TSlice]
}

function mapRows(
  value: unknown,
  row: (r: object) => object,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [
      k,
      // Field values are rows too, but carry no key or id of their own.
      Array.isArray(v)
        ? v.map((r: unknown) => (r && typeof r === 'object' ? row(r) : r))
        : v,
    ]),
  )
}

/** `contacts.methods` → `methods`; null for a contract the form doesn't know. */
export function sliceOfContract(contract: string): RustSlice | null {
  const slice = contract.replace(/^contacts\./, '')
  return (RUST_SLICES as Array<string>).includes(slice)
    ? (slice as RustSlice)
    : null
}

// ── reads into the pages' shapes ───────────────────────────────────────────

export function fieldsFromWire(
  fields: Array<WireField>,
): Array<FieldDefinition> {
  return fields.map((f, i) => ({
    _id: f.id as Id<'contactFields'>,
    label: f.label,
    appliesTo: f.appliesTo,
    isActive: f.isActive,
    retiring: false,
    // Only the order matters to the pages (the filters sort by it).
    slot: (i + 1) as FieldSlot,
    saveVersion: 0,
    options: f.options.map((o) => ({
      _id: o.id as Id<'contactFieldOptions'>,
      fieldId: f.id as Id<'contactFields'>,
      label: o.label,
      position: o.position,
      isActive: o.isActive,
      used: false,
      saveVersion: 0,
    })),
    deletable: false,
  }))
}

export function rowFromWire(r: WireListRow): ListRow {
  return {
    _id: r.id as Id<'contacts'>,
    kind: r.kind,
    displayName: r.displayName,
    sortName: r.displayName,
    number: r.number,
    archived: r.archived,
    email: r.email,
    fieldOptionIds: r.fieldOptionIds as Array<Id<'contactFieldOptions'>>,
  }
}

export function searchFromWire(s: WireSearch): SearchResult {
  return {
    rows: s.rows.map(rowFromWire),
    truncated: s.truncated,
    numberMatch: s.numberMatch as Id<'contacts'> | null,
    invalidNumber: s.invalidNumber,
    tooBroad: false,
    checked: s.rows.length,
  }
}

/**
 * The contact in the Convex view's shape (what the form renders), with
 * what Rust doesn't have left empty: no identifiers, no acquisition. The
 * root carries only the fields the pages read; the cast covers the rest
 * of `Doc<'contacts'>` (tenantId, slots, sortName), which no page reads.
 */
export function contactFromWire(
  c: WireContact,
  definitions: Array<FieldDefinition>,
): ContactView {
  const field = new Map(definitions.map((f) => [f._id as string, f]))
  const contact = {
    _id: c.id,
    _creationTime: 0,
    ...c.details,
    displayName: c.displayName,
    sortName: c.displayName,
    number: c.number,
    archived: c.archived,
    detailsVersion: c.counters.details,
    methodsVersion: c.counters.methods,
    addressesVersion: c.counters.addresses,
    fieldsVersion: c.counters.fields,
    archiveVersion: c.counters.archive,
    identifiersVersion: 0,
    acquisitionVersion: 0,
  }
  const methods = sliceFromWire('methods', {
    emails: c.emails,
    phones: c.phones,
  })
  const { addresses } = sliceFromWire('addresses', { addresses: c.addresses })
  return {
    contact,
    emails: methods.emails,
    phones: methods.phones,
    addresses,
    identifiers: [],
    acquisition: null,
    fields: c.fields.flatMap((v) => {
      const f = field.get(v.fieldId)
      if (!f) return []
      const o = f.options.find((x) => x._id === v.optionId)
      return [
        {
          fieldId: f._id,
          label: f.label,
          slot: f.slot,
          fieldActive: f.isActive,
          optionId: v.optionId,
          optionLabel: o?.label ?? '?',
          optionActive: o?.isActive ?? false,
        },
      ]
    }),
  } as unknown as ContactView
}
