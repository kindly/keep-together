import { useRef } from 'react'
import { newKey } from './contact-form-state'

// A form's `clientKey` for a request with money in it (a one-off, an
// Instant Bank Pay link, a regular gift, a terms change). The server
// records the request under its key before it calls GoCardless, and a
// retry under that key is the request *as first asked*: its amount,
// date and code, whatever the retry says (GoCardless UI review H1). So
// a key is kept only for an identical retry (a timeout, a 503), and any
// change to what is asked mints a new one.

/** The key for `payload`: `last`'s if it asked the same, else a new one. */
export function keyFor(
  last: { key: string; asked: string } | null,
  payload: unknown,
): { key: string; asked: string } {
  const asked = JSON.stringify(payload, (_, v: unknown) =>
    typeof v === 'bigint' ? `${v}n` : v,
  )
  return last?.asked === asked ? last : { key: newKey(), asked }
}

/** `keyFor` across a form's attempts: call it with each request sent. */
export function useRequestKey(): (payload: unknown) => string {
  const last = useRef<{ key: string; asked: string } | null>(null)
  return (payload) => {
    last.current = keyFor(last.current, payload)
    return last.current.key
  }
}
