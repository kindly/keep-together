import { useSyncExternalStore } from 'react'
import { newVersionAvailable, subscribeNewVersion } from '../lib/stale-build'

/**
 * Offered when a deploy left this tab's code behind and reloading by
 * itself could lose work (or loop): the user reloads when ready. The
 * page's leave guard still asks first if anything is unsaved.
 */
export function NewVersionBanner() {
  const shown = useSyncExternalStore(
    subscribeNewVersion,
    newVersionAvailable,
    () => false,
  )
  if (!shown) return null
  return (
    <div
      role="alert"
      className="flex items-center justify-center gap-3 bg-sky-100 px-4 py-2 text-sm text-sky-950"
    >
      <span>A new version is available.</span>
      <button
        type="button"
        className="rounded border border-sky-300 bg-white px-2 py-0.5 font-medium hover:bg-sky-50"
        onClick={() => window.location.reload()}
      >
        Reload
      </button>
    </div>
  )
}
