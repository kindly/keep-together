import { authTables } from '@convex-dev/auth/server'
import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'

/**
 * Every domain table carries `tenantId` and every index on it starts with
 * `tenantId` — `convex/lib/tables.test.ts` fails otherwise. Platform tables
 * (listed in `convex/lib/tables.ts`) are the only exceptions. Domain code
 * never writes or filters by `tenantId`: the scoped db in
 * `convex/lib/tenancy.ts` stamps inserts and prefixes every index range.
 *
 * Schema changes are two-phase (loosen → deploy → backfill → tighten →
 * deploy); Convex validates every existing document on deploy.
 */

export const contactKind = v.union(
  v.literal('individual'),
  v.literal('organization'),
  v.literal('household'),
)
export const channelLabel = v.union(
  v.literal('home'),
  v.literal('work'),
  v.literal('other'),
)
export const revisionSource = v.union(
  v.literal('ui'),
  v.literal('autosave'),
  v.literal('import'),
  v.literal('restore'),
  v.literal('seed'),
  v.literal('system'),
  v.literal('test'),
  v.literal('comms'), // provider events (a hard bounce)
)
/**
 * Why an address is suppressed: only a hard bounce (ADR 0021, rule 5: a
 * complaint never blocks transactional mail); or `release`: an admin
 * lifted it.
 */
export const suppressionReason = v.union(
  v.literal('bounce'),
  v.literal('release'),
)

export default defineSchema({
  ...authTables,

  // ── platform ──────────────────────────────────────────────────────────
  tenants: defineTable({
    slug: v.string(), // hostname / path key; unique by convention (checked in platform.tenants)
    name: v.string(),
    status: v.union(
      v.literal('active'),
      v.literal('suspended'),
      v.literal('closed'),
    ),
  }).index('by_slug', ['slug']),

  memberships: defineTable({
    tenantId: v.id('tenants'),
    userId: v.id('users'),
    role: v.union(v.literal('admin'), v.literal('staff'), v.literal('viewer')),
  })
    .index('by_tenant_user', ['tenantId', 'userId'])
    .index('by_user', ['userId']),

  // Per-tenant secrets (payment tokens, webhook secrets, sender identity).
  // Values are AES-GCM ciphertext under a deployment-level key — never
  // deployment env vars.
  tenantSettings: defineTable({
    tenantId: v.id('tenants'),
    key: v.string(),
    ciphertext: v.string(),
    iv: v.string(),
  }).index('by_tenant_key', ['tenantId', 'key']),

  // Per-tenant preferences: plain, non-secret switches admins set on the
  // Settings page (convex/platform/preferences.ts). At most one row per
  // tenant, created on first save; no row means every default.
  //   tenantPreferences.tags → staffCanManageTags (tagsVersion)
  //   tenantPreferences.identifierTypes → staffCanManageIdentifierTypes
  //     (identifierTypesVersion)
  tenantPreferences: defineTable({
    tenantId: v.id('tenants'),
    staffCanManageTags: v.boolean(),
    tagsVersion: v.number(),
    staffCanManageIdentifierTypes: v.boolean(),
    identifierTypesVersion: v.number(),
  }).index('by_tenant', ['tenantId']),

  // ── command log (ADR 0013 / 0017) ─────────────────────────────────────
  // One row per *action*: several contracts executed in one mutation under
  // a name, so "this restore = these three revisions" is one query.
  commandGroups: defineTable({
    tenantId: v.id('tenants'),
    name: v.string(),
    actor: v.optional(v.id('users')),
  }).index('by_tenant', ['tenantId']),

  // One row per executed contract. `payload` is the normalised full-state
  // slice and is deliberately untyped: history is immutable and never under
  // schema pressure; only live documents are strictly typed.
  revisions: defineTable({
    tenantId: v.id('tenants'),
    entity: v.string(), // aggregate root table name
    entityId: v.string(), // root _id (table varies, so stored as string)
    contract: v.string(), // e.g. "contacts.details"
    version: v.number(), // declared contract version that validated payload
    counter: v.number(), // the counter value this command produced (0 = create)
    payload: v.any(),
    actor: v.optional(v.id('users')),
    source: revisionSource,
    group: v.optional(v.id('commandGroups')),
    // The group's name, copied at insert (a group's name never changes) so
    // `history` needs no second read. Optional for good: rows from before
    // perf-storage step 1 are backfilled, and `history` falls back to the
    // group document for any that aren't.
    groupName: v.optional(v.string()),
    restoredFrom: v.optional(v.id('revisions')),
  })
    .index('by_tenant_entity', ['tenantId', 'entity', 'entityId'])
    .index('by_tenant_entity_contract', [
      'tenantId',
      'entity',
      'entityId',
      'contract',
    ]),

  // ── contacts (ADR 0014) ───────────────────────────────────────────────
  // Aggregate root. Field ownership (contracts partition, never overlap):
  //   contacts.details   → kind + biographical/name fields (detailsVersion)
  //   contacts.methods   → contactEmails / contactPhones rows (methodsVersion)
  //   contacts.addresses → contactAddresses rows (addressesVersion)
  //   contacts.archive   → archived (archiveVersion)
  //   contacts.tags      → contactTags rows (tagsVersion)
  //   contacts.identifiers → contactIdentifiers rows (identifiersVersion)
  // System-managed (no contract): displayName / sortName, counters.
  contacts: defineTable({
    tenantId: v.id('tenants'),
    clientKey: v.optional(v.string()), // client-minted on create → idempotent double submits / retried imports
    kind: contactKind,
    title: v.string(),
    firstName: v.string(),
    lastName: v.string(),
    nickname: v.string(),
    name: v.string(), // organization / household
    birthDate: v.optional(v.string()), // ISO date
    isDeceased: v.boolean(),
    deceasedDate: v.optional(v.string()),
    displayName: v.string(),
    sortName: v.string(),
    archived: v.boolean(),
    detailsVersion: v.number(),
    methodsVersion: v.number(),
    addressesVersion: v.number(),
    archiveVersion: v.number(),
    tagsVersion: v.number(),
    identifiersVersion: v.number(),
  })
    .index('by_tenant_sort', ['tenantId', 'sortName'])
    .index('by_tenant_kind_sort', ['tenantId', 'kind', 'sortName']) // list's kind filter
    .index('by_tenant_clientKey', ['tenantId', 'clientKey'])
    // Superseded by contactSearch.search_text (search Q2); dropped once Q2
    // has rolled out everywhere.
    .searchIndex('search_name', {
      searchField: 'sortName',
      filterFields: ['tenantId', 'archived'],
    }),

  // Child rows: written only through the root's contracts, never referenced
  // from outside the aggregate. `key` is the row's identity in payloads and
  // revisions (client-minted, so restore recreates a removed row with the
  // same key); `_id` is internal.
  contactEmails: defineTable({
    tenantId: v.id('tenants'),
    contactId: v.id('contacts'),
    key: v.string(),
    label: channelLabel,
    address: v.string(), // identity field — immutable per key
    // normaliseEmail(address), set on insert (contracts reconcile); the index
    // behind findByEmail and the shared-email warning
    addressNormalized: v.string(),
    isPrimary: v.boolean(),
    // Whether the address is on hold is comms' emailSuppressions, per
    // address (E2a), not row state.
  })
    .index('by_tenant_contact', ['tenantId', 'contactId'])
    .index('by_tenant_key', ['tenantId', 'key'])
    .index('by_tenant_addressNormalized', ['tenantId', 'addressNormalized']),

  contactPhones: defineTable({
    tenantId: v.id('tenants'),
    contactId: v.id('contacts'),
    key: v.string(),
    label: channelLabel,
    number: v.string(), // identity field — immutable per key
    isPrimary: v.boolean(),
  })
    .index('by_tenant_contact', ['tenantId', 'contactId'])
    .index('by_tenant_key', ['tenantId', 'key']),

  // UK-shaped. No identity field: every field is correctable in place.
  contactAddresses: defineTable({
    tenantId: v.id('tenants'),
    contactId: v.id('contacts'),
    key: v.string(),
    label: channelLabel,
    line1: v.string(),
    line2: v.string(),
    line3: v.string(),
    town: v.string(),
    postcode: v.string(),
    country: v.string(), // ISO 3166-1 alpha-2
    isPrimary: v.boolean(),
  })
    .index('by_tenant_contact', ['tenantId', 'contactId'])
    .index('by_tenant_key', ['tenantId', 'key']),

  // Assignment of a tag to a contact (`contacts.tags` slice). `tagId` is the
  // identity field — immutable per key; re-tagging is remove + add.
  contactTags: defineTable({
    tenantId: v.id('tenants'),
    contactId: v.id('contacts'),
    key: v.string(),
    tagId: v.id('tags'),
  })
    .index('by_tenant_contact', ['tenantId', 'contactId'])
    .index('by_tenant_key', ['tenantId', 'key'])
    .index('by_tenant_tag', ['tenantId', 'tagId']),

  // An external identifier (`contacts.identifiers` slice): the contact's id
  // in another system. `typeId` and `value` are identity fields, immutable
  // per key. A (type, valueNormalized) pair belongs to at most one contact
  // per tenant (checked in apply).
  contactIdentifiers: defineTable({
    tenantId: v.id('tenants'),
    contactId: v.id('contacts'),
    key: v.string(),
    typeId: v.id('identifierTypes'),
    value: v.string(), // as typed (trimmed)
    valueNormalized: v.string(), // normaliseIdentifier(value), set on insert
  })
    .index('by_tenant_contact', ['tenantId', 'contactId'])
    .index('by_tenant_key', ['tenantId', 'key'])
    // Prefix `valueNormalized` = "this value, any type" (list search);
    // both fields = "this type + value" (findByIdentifier, uniqueness).
    .index('by_tenant_valueNormalized_type', [
      'tenantId',
      'valueNormalized',
      'typeId',
    ]),

  // Derived search projection: one row per contact, rebuilt from the
  // contact's current state by `projectContactSearch` (contacts/
  // searchProjection.ts), which every contract touching a searchable slice
  // runs as its `project` hook inside the same transaction. NOT a domain
  // aggregate: no contract, no counter, no revisions (history lives on the
  // contact). That hook and the backfill are the only writers; nothing else
  // may insert or patch these rows.
  contactSearch: defineTable({
    tenantId: v.id('tenants'),
    contactId: v.id('contacts'),
    text: v.string(), // searchText(): folded, de-duplicated words
    archived: v.boolean(),
    kind: contactKind,
    phones: v.array(v.string()), // normalisePhone() of each number (exact-phone ranking)
  })
    .index('by_tenant_contact', ['tenantId', 'contactId'])
    .searchIndex('search_text', {
      searchField: 'text',
      filterFields: ['tenantId', 'archived', 'kind'],
    }),

  // Its own aggregate (`contacts.identifierType`, saveVersion), like tags:
  // names unique per tenant case-insensitively; archive = `isActive: false`
  // (out of the picker, rows kept and still found). None seeded.
  identifierTypes: defineTable({
    tenantId: v.id('tenants'),
    name: v.string(),
    nameNormalized: v.string(), // normaliseTagName(name)
    isActive: v.boolean(),
    saveVersion: v.number(),
  }).index('by_tenant_nameNormalized', ['tenantId', 'nameNormalized']),

  // Its own aggregate (`contacts.tag`, saveVersion). Flat; names unique per
  // tenant case-insensitively (checked in apply against `nameNormalized`).
  // Retire = `isActive: false`: hidden from pickers, assignments kept.
  // Seeded per tenant: member, volunteer.
  tags: defineTable({
    tenantId: v.id('tenants'),
    name: v.string(),
    nameNormalized: v.string(), // normaliseTagName(name)
    isActive: v.boolean(),
    saveVersion: v.number(),
  }).index('by_tenant_nameNormalized', ['tenantId', 'nameNormalized']),

  // Seeded per tenant (UK basics); charities add their own.
  relationshipTypes: defineTable({
    tenantId: v.id('tenants'),
    labelAB: v.string(), // "Employee of"
    labelBA: v.string(), // "Employer of"
    kindA: v.optional(contactKind), // absent = any
    kindB: v.optional(contactKind),
    isActive: v.boolean(),
    saveVersion: v.number(),
  }).index('by_tenant', ['tenantId']),

  // Its own aggregate — spans two contacts so it can't live inside either.
  relationships: defineTable({
    tenantId: v.id('tenants'),
    contactA: v.id('contacts'),
    contactB: v.id('contacts'),
    typeId: v.id('relationshipTypes'),
    startDate: v.optional(v.string()),
    endDate: v.optional(v.string()),
    isActive: v.boolean(),
    description: v.string(),
    saveVersion: v.number(),
  })
    .index('by_tenant_a', ['tenantId', 'contactA'])
    .index('by_tenant_b', ['tenantId', 'contactB']),

  // Its own aggregate, one root per note, so two people writing notes on
  // one contact never conflict. Field ownership:
  //   contacts.note      → body (bodyVersion)
  //   contacts.noteFlags → pinned, archived (flagsVersion)
  // `contactId` is stamped at create and owned by no slice (a future
  // `notes.move`, run by merge, re-points it: live class under ADR 0019).
  // System-owned: createdBy, and editedBy / editedAt from body saves only.
  contactNotes: defineTable({
    tenantId: v.id('tenants'),
    contactId: v.id('contacts'),
    body: v.string(), // plain text
    pinned: v.boolean(),
    archived: v.boolean(), // remove = archive: hidden, restorable
    createdBy: v.optional(v.id('users')), // absent = system
    editedBy: v.optional(v.id('users')),
    editedAt: v.number(),
    bodyVersion: v.number(),
    flagsVersion: v.number(),
  })
    // Prefix `contactId` = every note of a contact (merge, anonymisation).
    // Read `desc`, each (archived, pinned) range is one section of the notes
    // panel, newest first.
    .index('by_tenant_contact_archived_pinned', [
      'tenantId',
      'contactId',
      'archived',
      'pinned',
    ])
    // The archived list: newest first regardless of pin.
    .index('by_tenant_contact_archived', ['tenantId', 'contactId', 'archived']),

  // ── comms ─────────────────────────────────────────────────────────────
  // Suppression per address (domain rule 5: centralised in comms). One row
  // per (tenant, address) once the address was ever suppressed; never
  // deleted, a release sets `suppressed: false`. Every send checks it, and
  // the contact page derives its "on hold" flag from it.
  //   comms.suppression → everything below but addressNormalized (saveVersion)
  // `addressNormalized` is the row's identity, immutable.
  emailSuppressions: defineTable({
    tenantId: v.id('tenants'),
    addressNormalized: v.string(), // normaliseEmail(address)
    suppressed: v.boolean(),
    reason: suppressionReason,
    since: v.number(), // when the current state began
    eventRef: v.optional(v.string()), // the provider event that suppressed it
    note: v.optional(v.string()), // the admin's reason for a release
    saveVersion: v.number(),
  }).index('by_tenant_addressNormalized', ['tenantId', 'addressNormalized']),
})
