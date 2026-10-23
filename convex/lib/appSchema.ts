import { defineTable } from 'convex/server'
import { v } from 'convex/values'
import { SLOT_FIELD_NAMES, slotFields, withSlotIndexes } from './fieldSlots'

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
/** How a gift was paid: by hand, or on a card reader we don't drive (yet). */
export const contributionMethod = v.union(v.literal('cash'), v.literal('card'))
/**
 * Where a gift stands. `void` = entered by mistake: kept, counts for
 * nothing. Room for `pending` / `failed` / `refunded` (ADR 0008).
 */
export const contributionStatus = v.union(
  v.literal('completed'),
  v.literal('void'),
)

/**
 * The app's tables; `convex/schema.ts` adds the auth library's to them.
 * Kept apart from it so domain code (the tenancy rules, the validators
 * above) never imports `@convex-dev/auth/server`: Convex evaluates a
 * function's whole import graph on every call, and that bundle (~226 KB)
 * cost ~1.7 ms on each query and mutation.
 */
export const appTables = {
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
    // When the user last opened this group (ms), to land them back in it
    // on sign-in. Only kept for people in more than one group.
    lastUsedAt: v.optional(v.number()),
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
  //   tenantPreferences.identifierTypes → staffCanManageIdentifierTypes
  //     (identifierTypesVersion)
  //   tenantPreferences.sourceCodes → staffCanManageSourceCodes
  //     (sourceCodesVersion)
  //   tenantPreferences.fields → staffCanManageFields (fieldsVersion)
  tenantPreferences: defineTable({
    tenantId: v.id('tenants'),
    // Tags, removed (dropdown fields step 7): optional until step 8 unsets
    // them and step 9 drops them.
    staffCanManageTags: v.optional(v.boolean()),
    tagsVersion: v.optional(v.number()),
    staffCanManageIdentifierTypes: v.boolean(),
    identifierTypesVersion: v.number(),
    staffCanManageSourceCodes: v.boolean(),
    sourceCodesVersion: v.number(),
    // Dropdown fields step 1: optional until the tighten (step 9); rows
    // created before are backfilled (platform/migrations).
    staffCanManageFields: v.optional(v.boolean()),
    fieldsVersion: v.optional(v.number()),
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
  //   contacts.identifiers → contactIdentifiers rows (identifiersVersion)
  //   contacts.acquisition → acquisitionCodeId (acquisitionVersion)
  //   contacts.fields    → field1…fieldN (fieldsVersion; lib/fieldSlots)
  // System-managed (no contract): displayName / sortName, counters,
  // number (set on create, never changed: contacts/number).
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
    // The removed `contacts.tags` slice's counter (dropdown fields step 7):
    // optional until step 8 unsets it and step 9 drops it.
    tagsVersion: v.optional(v.number()),
    identifiersVersion: v.number(),
    // How the contact was recruited: a `sourceCodes` row at level
    // 'version' (the source code). Optional for good: absent = uncoded.
    acquisitionCodeId: v.optional(v.id('sourceCodes')),
    acquisitionVersion: v.number(),
    // Dropdown field values: the option chosen for the field in slot N
    // (lib/fieldSlots). Optional for good: absent = not set. Ids only, so
    // renaming an option never rewrites contacts.
    ...slotFields(v.optional(v.id('contactFieldOptions'))),
    // Optional until the tighten (dropdown fields step 9); contacts created
    // before step 1 are backfilled (contacts/migrations).
    fieldsVersion: v.optional(v.number()),
    // The contact number's sequence (contacts/number; shown with its check
    // digit). Optional until the tighten (contact numbers step 6); contacts
    // created before step 1 are backfilled (step 2).
    number: v.optional(v.number()),
  })
    .index('by_tenant_sort', ['tenantId', 'sortName'])
    .index('by_tenant_number', ['tenantId', 'number'])
    .index('by_tenant_acquisition', ['tenantId', 'acquisitionCodeId'])
    .index('by_tenant_kind_sort', ['tenantId', 'kind', 'sortName']) // list's kind filter
    // The list without archived contacts: every filter in the index range,
    // so a page holds only rows it shows.
    .index('by_tenant_archived_sort', ['tenantId', 'archived', 'sortName'])
    .index('by_tenant_kind_archived_sort', [
      'tenantId',
      'kind',
      'archived',
      'sortName',
    ])
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

  // Assignment of a tag to a contact, from the removed `contacts.tags`
  // slice (dropdown fields step 7). Nothing reads or writes it; step 8
  // deletes the rows and step 9 the table.
  contactTags: defineTable({
    tenantId: v.id('tenants'),
    contactId: v.id('contacts'),
    key: v.string(),
    tagId: v.id('tags'),
    name: v.string(),
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
  // The field filter's index pairs come from withSlotIndexes: 2 per slot.
  contactSearch: withSlotIndexes(
    defineTable({
      tenantId: v.id('tenants'),
      contactId: v.id('contacts'),
      text: v.string(), // searchText(): folded, de-duplicated words
      archived: v.boolean(),
      kind: contactKind,
      phones: v.array(v.string()), // normalisePhone() of each number (exact-phone ranking)
      // The contact's sortName, for the acquisition indexes below. Optional
      // for good, like the three ids: backfillContactSearch fills it on rows
      // projected before source codes step 1.
      sortName: v.optional(v.string()),
      // The acquisition code (a version) and its detail and category, for the
      // contacts list's source filter. Ids only, so a rename never touches
      // these rows.
      acquisitionCodeId: v.optional(v.id('sourceCodes')),
      acquisitionDetailId: v.optional(v.id('sourceCodes')),
      acquisitionCategoryId: v.optional(v.id('sourceCodes')),
      // The contact's dropdown field values, slot by slot, for the list's
      // field filters. Optional for good, like on the contact.
      ...slotFields(v.optional(v.id('contactFieldOptions'))),
    })
      .index('by_tenant_contact', ['tenantId', 'contactId'])
      // The source filter without search text: one level's id, by name.
      .index('by_tenant_acquisitionCode_sort', [
        'tenantId',
        'acquisitionCodeId',
        'sortName',
      ])
      .index('by_tenant_acquisitionDetail_sort', [
        'tenantId',
        'acquisitionDetailId',
        'sortName',
      ])
      .index('by_tenant_acquisitionCategory_sort', [
        'tenantId',
        'acquisitionCategoryId',
        'sortName',
      ])
      // The same without archived contacts (the list's default), so a page
      // holds only rows that show. A kind is checked per row instead: four
      // indexes per level would tax every contact save.
      .index('by_tenant_acquisitionCode_archived_sort', [
        'tenantId',
        'acquisitionCodeId',
        'archived',
        'sortName',
      ])
      .index('by_tenant_acquisitionDetail_archived_sort', [
        'tenantId',
        'acquisitionDetailId',
        'archived',
        'sortName',
      ])
      .index('by_tenant_acquisitionCategory_archived_sort', [
        'tenantId',
        'acquisitionCategoryId',
        'archived',
        'sortName',
      ])
      .searchIndex('search_text', {
        searchField: 'text',
        filterFields: [
          'tenantId',
          'archived',
          'kind',
          'acquisitionCodeId',
          'acquisitionDetailId',
          'acquisitionCategoryId',
          ...SLOT_FIELD_NAMES,
        ],
      }),
  ),

  // Dropdown fields (plan: dropdown fields). Its own aggregate
  // (`contacts.field`, saveVersion): one row per field definition. Labels
  // unique per tenant case-insensitively (`labelNormalized`). `appliesTo`:
  // the contact kinds the field is shown for and may be set on. Archive =
  // `isActive: false` (hidden; values and slot kept). System-owned: `slot`,
  // 1…FIELD_SLOTS, the lowest free one assigned on create and preserved by
  // the contract; absent once the field is retired (every value cleared),
  // which frees it. Retired rows stay so history can name them. Also
  // system-owned: `retiring`, set while a retire is clearing values (no
  // new values, no reactivating), cleared with the slot. Optional for good.
  contactFields: defineTable({
    tenantId: v.id('tenants'),
    label: v.string(),
    labelNormalized: v.string(),
    appliesTo: v.array(contactKind),
    isActive: v.boolean(),
    slot: v.optional(v.number()),
    retiring: v.optional(v.boolean()),
    saveVersion: v.number(),
  }).index('by_tenant_slot', ['tenantId', 'slot']),

  // One option of a dropdown field, its own aggregate (`contacts.fieldOption`,
  // saveVersion), like a source-code part. `fieldId` never changes; labels
  // unique within the field; `position` is the admin's order. Archive =
  // `isActive: false` (out of the dropdown; contacts keep it). System-owned:
  // `used`, set the first time the option goes on a contact, never cleared;
  // the contract preserves it, and only an unused option can be deleted.
  contactFieldOptions: defineTable({
    tenantId: v.id('tenants'),
    fieldId: v.id('contactFields'),
    label: v.string(),
    labelNormalized: v.string(),
    position: v.number(),
    isActive: v.boolean(),
    used: v.boolean(),
    saveVersion: v.number(),
  }).index('by_tenant_field_position', ['tenantId', 'fieldId', 'position']),

  // Its own aggregate (`contacts.identifierType`, saveVersion):
  // names unique per tenant case-insensitively; archive = `isActive: false`
  // (out of the picker, rows kept and still found). None seeded.
  identifierTypes: defineTable({
    tenantId: v.id('tenants'),
    name: v.string(),
    nameNormalized: v.string(), // normaliseListName(name)
    isActive: v.boolean(),
    saveVersion: v.number(),
  }).index('by_tenant_nameNormalized', ['tenantId', 'nameNormalized']),

  // Tag definitions, from the removed `contacts.tag` contract (dropdown
  // fields step 7). Nothing reads or writes them; step 8 deletes the rows
  // and step 9 the table.
  tags: defineTable({
    tenantId: v.id('tenants'),
    name: v.string(),
    nameNormalized: v.string(), // normaliseListName(name)
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

  // ── contact numbers (plan: contact numbers) ───────────────────────────
  // The next contact number, one row per tenant, created by the first
  // allocation. Not a contract's root: contacts/number.ts is its only
  // writer (the details contract's create branch and the backfill take
  // numbers through it). Its own table, not a field on `tenants`, so only
  // creates conflict on it.
  contactNumberSequences: defineTable({
    tenantId: v.id('tenants'),
    next: v.number(),
  }).index('by_tenant', ['tenantId']),

  // ── sources (source codes plan) ───────────────────────────────────────
  // One row per part of a source code, at any of three levels: a category
  // (how we reached them), a detail under it (which agency / event) and a
  // version under that (which run). Its own aggregate (`sources.code`,
  // saveVersion). Only a version is assignable, and its id IS the source
  // code: contacts and gifts store that id and derive the rest. The full
  // code is the three names joined by hyphens (`Street-Wesser-001`); a name
  // has no hyphen and is unique among its siblings case-insensitively, so
  // the full code is unique per tenant. A part's parent never changes. The
  // full code is not stored: a rename would have to rewrite every row under
  // the part, so it is joined from the names at read time (sources/code).
  // Archive = `isActive: false` (hides it and everything under it from the
  // picker). System-owned: `used`, set by `sources.markUsed` the first
  // time a code goes on a contact or gift, on the version and both parents,
  // never cleared; the contract preserves it, and only unused parts can be
  // deleted.
  sourceCodes: defineTable({
    tenantId: v.id('tenants'),
    level: v.union(
      v.literal('category'),
      v.literal('detail'),
      v.literal('version'),
    ),
    parentId: v.optional(v.id('sourceCodes')), // absent on a category
    name: v.string(), // as typed (trimmed)
    nameNormalized: v.string(), // sibling uniqueness
    description: v.optional(v.string()),
    startDate: v.optional(v.string()), // ISO date; detail and version only
    endDate: v.optional(v.string()),
    isActive: v.boolean(),
    used: v.boolean(),
    saveVersion: v.number(),
  })
    // Prefix `parentId` = a part's children (categories: parentId absent);
    // both = a sibling by name.
    .index('by_tenant_parent', ['tenantId', 'parentId', 'nameNormalized']),

  // ── giving (cash gifts plan) ──────────────────────────────────────────
  // One gift, its own aggregate (history class, ADR 0019: never deleted,
  // kept through erasure). Field ownership:
  //   giving.gift   → contactId (create-only), receivedOn, amount, method,
  //                   reference, allocations (giftVersion)
  //   giving.status → status (statusVersion)
  // System-owned: `enteredBy`, set on create, preserved by every save and
  // restore. `allocations` split `amount` (pence, rule 7) across source
  // codes (versions), summing to it (ADR 0022 decision 9); the page sends
  // one. Read by code through `contributionAllocations`.
  contributions: defineTable({
    tenantId: v.id('tenants'),
    contactId: v.id('contacts'),
    receivedOn: v.string(), // ISO date
    amount: v.int64(), // pence, > 0
    method: contributionMethod,
    reference: v.optional(v.string()), // card only: the reader's receipt id
    allocations: v.array(
      v.object({
        key: v.string(),
        sourceCodeId: v.id('sourceCodes'),
        amount: v.int64(),
      }),
    ),
    status: contributionStatus,
    enteredBy: v.optional(v.id('users')), // absent = system
    giftVersion: v.number(),
    statusVersion: v.number(),
  })
    // "My recent gifts": newest first by _creationTime.
    .index('by_tenant_enteredBy', ['tenantId', 'enteredBy'])
    // A contact's gifts panel, newest first.
    .index('by_tenant_contact_receivedOn', [
      'tenantId',
      'contactId',
      'receivedOn',
    ]),

  // Derived projection: one row per allocation of a gift, rebuilt from the
  // gift by the `project` hook of both giving contracts (giving/projection)
  // in the same transaction, never written anywhere else. No contract, no
  // counter, no revisions. `detailId` / `categoryId` are copies that stay
  // right because a part's parent never changes. Income by code, detail or
  // category over dates is an index range (ADR 0022 decision 9); the
  // (code, contact) index is also the contact × source code join.
  contributionAllocations: defineTable({
    tenantId: v.id('tenants'),
    contributionId: v.id('contributions'),
    key: v.string(), // the allocation's key in the gift
    contactId: v.id('contacts'),
    sourceCodeId: v.id('sourceCodes'),
    detailId: v.id('sourceCodes'),
    categoryId: v.id('sourceCodes'),
    receivedOn: v.string(),
    amount: v.int64(),
    status: contributionStatus,
  })
    .index('by_tenant_contribution', ['tenantId', 'contributionId'])
    .index('by_tenant_sourceCode_receivedOn', [
      'tenantId',
      'sourceCodeId',
      'receivedOn',
    ])
    .index('by_tenant_detail_receivedOn', [
      'tenantId',
      'detailId',
      'receivedOn',
    ])
    .index('by_tenant_category_receivedOn', [
      'tenantId',
      'categoryId',
      'receivedOn',
    ])
    .index('by_tenant_sourceCode_contact', [
      'tenantId',
      'sourceCodeId',
      'contactId',
    ]),

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
}
