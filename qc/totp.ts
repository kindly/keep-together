import { createHmac } from 'node:crypto'

// TOTP codes for the QC users' seeded secrets (RFC 6238: SHA-1, 6
// digits, 30 s), so QC signs in the way people do. The server accepts each
// code once (a step at or before the last one used is refused) and only
// within one step of now, so `nextTotp` hands out the next unused step from
// the current one (never the previous: the server's clock may cross a step
// boundary before the code arrives) and waits when those are spent.

const STEP_MS = 30_000

function base32(secret: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = ''
  for (const c of secret.replace(/=+$/, '').toUpperCase()) {
    const v = alphabet.indexOf(c)
    if (v < 0) throw new Error(`not base32: ${c}`)
    bits += v.toString(2).padStart(5, '0')
  }
  const bytes = []
  for (let i = 0; i + 8 <= bits.length; i += 8)
    bytes.push(parseInt(bits.slice(i, i + 8), 2))
  return Buffer.from(bytes)
}

/** The code for time step `step`. */
export function totpAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const mac = createHmac('sha1', base32(secret)).update(counter).digest()
  const at = mac[mac.length - 1] & 0x0f
  const n = (mac.readUInt32BE(at) & 0x7fffffff) % 1_000_000
  return n.toString().padStart(6, '0')
}

/** The last step handed out per secret, in this worker. */
const used = new Map<string, number>()

/** A code the server hasn't seen for `secret` (see the header). */
export async function nextTotp(secret: string): Promise<string> {
  for (;;) {
    const now = Math.floor(Date.now() / STEP_MS)
    const step = Math.max((used.get(secret) ?? 0) + 1, now)
    if (step <= now + 1) {
      used.set(secret, step)
      return totpAt(secret, step)
    }
    await new Promise((r) =>
      setTimeout(r, (now + 1) * STEP_MS - Date.now() + 50),
    )
  }
}
