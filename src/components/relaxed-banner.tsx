import { useAuthState } from '../lib/data'

/**
 * On every page when the deployment's sign-in isn't strict
 * (`KEEP_AUTH_POLICY=relaxed`: the preview, local runs): a password alone
 * signs in, so nothing real belongs here.
 */
export function RelaxedBanner() {
  const state = useAuthState()
  if (state?.policy !== 'relaxed') return null
  return (
    <div
      role="note"
      className="bg-amber-100 px-4 py-1 text-center text-sm font-medium text-amber-900"
    >
      Relaxed sign-in: not for real data
    </div>
  )
}
