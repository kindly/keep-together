/**
 * The one `Migrations` instance (@convex-dev/migrations) every module
 * defines its backfills with.
 *
 * A migration is a platform operation, not a domain function: it walks a
 * whole table across tenants in batches, so it runs on the raw
 * `internalMutation` and its `migrateOne` sees the unscoped db. Use it only
 * for the backfill step of a two-phase schema change (CLAUDE.md), and only
 * to fill system-owned fields that no contract payload carries — a field a
 * contract owns changes through that contract and its upcaster instead.
 */
import { Migrations } from '@convex-dev/migrations'
import { components } from '../_generated/api'
import type { DataModel } from '../_generated/dataModel'
import { internalMutation } from '../_generated/server'

export const migrations = new Migrations<DataModel>(components.migrations, {
  internalMutation,
})
