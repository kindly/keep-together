/**
 * Contact contracts that no longer exist (dropdown fields plan, step 7:
 * tags), by name, with how history names their slice. Their revisions stay in
 * history, read-only: `restoreRevision` refuses them, a restore to a
 * moment leaves them out, and the history panel shows them marked
 * retired, without "Restore to here" on a moment made only of them.
 * Plain data, so the SPA's history panel can import it.
 */
export const RETIRED_CONTRACTS: Readonly<Record<string, string>> = {
  'contacts.tags': 'tags (retired)',
  'contacts.tag': 'tag (retired)',
}

export function isRetired(contract: string): boolean {
  return Object.hasOwn(RETIRED_CONTRACTS, contract)
}
