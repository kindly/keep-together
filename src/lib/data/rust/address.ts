/**
 * The contact form's "Find address" (`POST /api/t/{slug}/address-lookup`,
 * server `api::address`). Not a cached query: every lookup is a paid credit
 * counted against the group's month, and PAF results may not be kept.
 */
import { useTenant } from '../../tenant'
import type { AddressLookupResult } from '../rust-types/AddressLookupResult'
import type { LookupAddress } from '../rust-types/LookupAddress'
import { RustApiError, post, tenantPath } from './client'

export type { LookupAddress }

/** What a lookup came back with, as the picker shows it. */
export type LookupOutcome =
  | { kind: 'found'; addresses: Array<LookupAddress> }
  | { kind: 'none' }
  | { kind: 'unavailable' }
  | { kind: 'cap' }
  | { kind: 'invalid'; message: string }

export async function lookupAddresses(
  slug: string,
  postcode: string,
): Promise<LookupOutcome> {
  try {
    const result = await post<AddressLookupResult>(
      tenantPath(slug, 'address-lookup'),
      { postcode },
    )
    return { kind: 'found', addresses: result.addresses }
  } catch (e) {
    if (!(e instanceof RustApiError)) return { kind: 'unavailable' }
    switch (e.error.kind) {
      case 'not_found':
        return { kind: 'none' }
      case 'lookup_cap':
        return { kind: 'cap' }
      case 'invalid':
        return {
          kind: 'invalid',
          message: e.error.problems[0]?.message ?? 'Enter a UK postcode',
        }
      default:
        return { kind: 'unavailable' }
    }
  }
}

/** A lookup bound to this tenant. */
export function useAddressLookup(): (
  postcode: string,
) => Promise<LookupOutcome> {
  const { slug } = useTenant()
  return (postcode) => lookupAddresses(slug, postcode)
}
