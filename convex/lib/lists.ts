/**
 * Who may manage a tenant's lists (tags, identifier types): admins, and
 * staff while the tenant's "staff can manage tags and identifier types"
 * preference is on (off by default; platform/preferences sets it). Viewers
 * never. A role rule that depends on tenant data, so it can't be a static
 * `minRole`: `executeContract` applies it to every contract marked
 * `managesList`, whichever path runs it (a save, a restore).
 */
import { ConvexError } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import type { Role, ScopedDatabaseReader } from './tenancy'

/** Whether `role` may manage the lists, given the tenant's preferences. */
export function mayManageLists(
  role: Role,
  prefs: Pick<Doc<'tenantPreferences'>, 'staffCanManageLists'> | null,
): boolean {
  if (role === 'admin') return true
  return role === 'staff' && (prefs?.staffCanManageLists ?? false)
}

/** The tenant's preferences row; null until an admin first saves one. */
export async function tenantPreferences(db: ScopedDatabaseReader) {
  return db.query('tenantPreferences').withIndex('by_tenant').unique()
}

/** Throws `forbidden` unless the caller may manage the lists. */
export async function requireListManager(ctx: {
  db: ScopedDatabaseReader
  role: Role
}): Promise<void> {
  if (!mayManageLists(ctx.role, await tenantPreferences(ctx.db))) {
    throw new ConvexError({ kind: 'forbidden' as const })
  }
}
