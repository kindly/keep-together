import { authTables } from '@convex-dev/auth/server'
import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'

/**
 * Every domain table carries `tenantId` and every index on it starts with
 * `tenantId` — `convex/lib/tables.test.ts` fails otherwise. Platform tables
 * (listed in `convex/lib/tables.ts`) are the only exceptions.
 *
 * Schema changes are two-phase (loosen → deploy → backfill → tighten →
 * deploy); Convex validates every existing document on deploy.
 */
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
    role: v.union(v.literal('owner'), v.literal('staff')),
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

  // ── command log (ADR 0013 / 0017) ─────────────────────────────────────
  // One row per executed contract. `payload` is the cleaned full-state
  // slice and is deliberately untyped: history is immutable and never under
  // schema pressure; only live documents are strictly typed.
  revisions: defineTable({
    tenantId: v.id('tenants'),
    entity: v.string(), // aggregate root table name
    entityId: v.string(), // root _id (table varies, so stored as string)
    contract: v.string(), // e.g. "contacts.details"
    version: v.number(), // declared contract version that validated payload
    counter: v.number(), // the counter value this command produced
    payload: v.any(),
    actor: v.optional(v.id('users')),
    source: v.union(
      v.literal('ui'),
      v.literal('import'),
      v.literal('restore'),
      v.literal('system'),
    ),
    group: v.optional(v.string()), // command-group id for multi-contract actions
    restoredFrom: v.optional(v.id('revisions')),
  })
    .index('by_tenant_entity', ['tenantId', 'entity', 'entityId'])
    .index('by_tenant_group', ['tenantId', 'group']),
})
