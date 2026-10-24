import { useEffect, useState } from 'react'

/**
 * The token of an emailed link (`/reset#<token>`, `/invite#<token>`).
 * It rides in the fragment, which browsers never send to a server, and is
 * taken out of the address bar (and history) once read.
 */
export function useLinkToken(): string | null {
  const [token] = useState(() => {
    const t = window.location.hash.slice(1)
    return /^[0-9a-f]{64}$/.test(t) ? t : null
  })
  useEffect(() => {
    if (window.location.hash)
      window.history.replaceState(
        window.history.state,
        '',
        window.location.pathname + window.location.search,
      )
  }, [])
  return token
}
