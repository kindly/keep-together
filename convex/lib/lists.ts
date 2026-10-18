/**
 * Who may manage a tenant's lists (tags, identifier types): admins, and
 * staff while that list's own "staff can manage …" preference is on (each
 * off by default, independent of the other; platform/preferences sets
 * them). Viewers never. A role rule that depends on tenant data, so it
 * can't be a static `minRole`: `executeContract` applies it to every
 * contract marked `managesList`, whichever path runs it (a save, a
 * restore).
 */
import { ConvexError } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import type { Role, ScopedDatabaseReader } from './tenancy'

/** The lists a tenant's staff may be allowed to manage, one switch each. */
export type ListKind = 'tags' | 'identifierTypes'

/** Each list's switch on the tenant's preferences row. */
export const STAFF_SWITCH = {
  tags: 'staffCanManageTags',
  identifierTypes: 'staffCanManageIdentifierTypes',
} as const satisfies Record<ListKind, keyof Doc<'tenantPreferences'>>

type Prefs = Pick<Doc<'tenantPreferences'>, (typeof STAFF_SWITCH)[ListKind]>

/** Whether the tenant lets staff manage `kind` (no row: the default, no). */
export function staffMayManage(prefs: Prefs | null, kind: ListKind): boolean {
  return prefs?.[STAFF_SWITCH[kind]] ?? false
}

/** Whether `role` may manage `kind`, given the tenant's preferences. */
export function mayManageList(
  role: Role,
  prefs: Prefs | null,
  kind: ListKind,
): boolean {
  if (role === 'admin') return true
  return role === 'staff' && staffMayManage(prefs, kind)
}

/** The tenant's preferences row; null until an admin first saves one. */
export async function tenantPreferences(db: ScopedDatabaseReader) {
  return db.query('tenantPreferences').withIndex('by_tenant').unique()
}

/** Throws `forbidden` unless the caller may manage `kind`. */
export async function requireListManager(
  ctx: { db: ScopedDatabaseReader; role: Role },
  kind: ListKind,
): Promise<void> {
  if (!mayManageList(ctx.role, await tenantPreferences(ctx.db), kind)) {
    throw new ConvexError({ kind: 'forbidden' as const })
  }
}
