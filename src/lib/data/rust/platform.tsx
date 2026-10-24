/**
 * The control plane's writes on the Rust API: "last used" group and the
 * Settings switches. Neither is optimistic: what shows is what the server
 * answered, through a refetch of the caller's groups. They use the app's
 * one query client directly, not the provider's: the switch also renders
 * inside list tabs whose pages (and tests) aren't on TanStack Query yet.
 */
import { useCallback } from 'react'
import type { Executed } from '../rust-types/Executed'
import type { ListKind } from '../rust-types/ListKind'
import type { OpenedResult } from '../rust-types/OpenedResult'
import type { SetPreference } from '../rust-types/SetPreference'
import type { Tenant } from '../../tenant'
import { RustApiError, post, tenantPath } from './client'
import { queryClient as qc } from './hooks'
import { keys } from './keys'

/**
 * `POST /api/groups/{slug}/opened`: this group was opened. When the
 * server recorded it, the groups are refetched so "last used" is current.
 */
export function useOpened() {
  return useCallback(async (slug: string) => {
    const out = await post<OpenedResult>(
      ['groups', encodeURIComponent(slug), 'opened'].join('/'),
    )
    if (out.lastUsedAt !== null)
      await qc.invalidateQueries({ queryKey: keys.groups })
  }, [])
}

/** Each list's switch and its counter on a group. */
export const SWITCH = {
  identifierTypes: ['staffCanManageIdentifierTypes', 'identifierTypesVersion'],
  sourceCodes: ['staffCanManageSourceCodes', 'sourceCodesVersion'],
  fields: ['staffCanManageFields', 'fieldsVersion'],
} as const satisfies Record<ListKind, readonly [keyof Tenant, keyof Tenant]>

export type SwitchOutcome = 'saved' | 'stale' | 'failed'

/**
 * Turn "staff can manage `kind`" on or off, against the counter the
 * caller's groups carry. Admin only (the server refuses anyone else).
 * The groups refetch either way: after a save to show it, after a stale
 * refusal to show what the other admin chose.
 */
export function useSetStaffCanManage(tenant: Tenant) {
  return useCallback(
    async (kind: ListKind, on: boolean): Promise<SwitchOutcome> => {
      const body: SetPreference = {
        expected: tenant[SWITCH[kind][1]],
        staffCanManage: on,
      }
      try {
        await post<Executed>(tenantPath(tenant.slug, 'preferences', kind), body)
        return 'saved'
      } catch (e) {
        return e instanceof RustApiError && e.error.kind === 'stale'
          ? 'stale'
          : 'failed'
      } finally {
        await qc.invalidateQueries({ queryKey: keys.groups })
      }
    },
    [tenant],
  )
}
