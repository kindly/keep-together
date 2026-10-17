/**
 * IRmark (HMRC "Generic IRmark specification" v1.2; "IRmark generation
 * step by step guide for Gateway protocol services" v2.0):
 *
 *   1. take the <Body> element of the GovTalkMessage, inheriting the
 *      namespace declarations of <GovTalkMessage> onto <Body>;
 *   2. remove the <IRmark> element (keeping the whitespace around it);
 *   3. canonicalise (W3C C14N 1.0, without comments);
 *   4. SHA-1 → 20 bytes;
 *   5. base64 for the <IRmark> element (28 chars); base32 for display.
 *
 * We generate the submission XML ourselves in canonical form (single
 * quotes never, attributes sorted, text escaped per C14N, LF line ends), so
 * steps 1–3 are string operations rather than a full C14N implementation.
 * Both HMRC-published samples hash correctly through this path (tests).
 */

const ENVELOPE_NS = 'http://www.govtalk.gov.uk/CM/envelope'

export class IrmarkError extends Error {}

/** The canonical payload the IRmark is computed over. */
export function canonicalPayload(message: string): string {
  const text = message.replace(/\r\n?/g, '\n')
  const open = /<GovTalkMessage\b([^>]*)>/.exec(text)
  if (!open) throw new IrmarkError('no <GovTalkMessage> element')
  const inherited = [
    ...open[1].matchAll(/\s(xmlns(?::[\w.-]+)?)="([^"]*)"/g),
  ].map((m) => [m[1], m[2]] as const)
  if (!inherited.some(([name]) => name === 'xmlns')) {
    inherited.unshift(['xmlns', ENVELOPE_NS])
  }
  const body = /<Body(\s[^>]*)?>([\s\S]*)<\/Body>/.exec(text)
  if (!body) throw new IrmarkError('no <Body> element')
  // C14N orders namespace declarations: default xmlns first, then by prefix.
  const ns = [...inherited]
    .sort(([a], [b]) =>
      a === 'xmlns' ? -1 : b === 'xmlns' ? 1 : a.localeCompare(b),
    )
    .map(([name, value]) => ` ${name}="${value}"`)
    .join('')
  const inner = body[2].replace(/<IRmark\b[^>]*>[\s\S]*?<\/IRmark>/, '')
  return `<Body${ns}>${inner}</Body>`
}

async function sha1(text: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest(
    'SHA-1',
    new TextEncoder().encode(text),
  )
  return new Uint8Array(digest)
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const remaining = bytes.length - i
    const a = bytes[i]
    const b = remaining > 1 ? bytes[i + 1] : 0
    const c = remaining > 2 ? bytes[i + 2] : 0
    const n = (a << 16) | (b << 8) | c
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63]
    out += remaining > 1 ? B64[(n >> 6) & 63] : '='
    out += remaining > 2 ? B64[n & 63] : '='
  }
  return out
}

export function base32(bytes: Uint8Array): string {
  let out = ''
  let bits = 0
  let value = 0
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  while (out.length % 8 !== 0) out += '='
  return out
}

export type Irmark = {
  /** 28 characters, goes in <IRmark Type="generic">. */
  base64: string
  /** 32 characters, shown to the user and printed on the claim. */
  base32: string
}

export async function computeIrmark(message: string): Promise<Irmark> {
  const digest = await sha1(canonicalPayload(message))
  return { base64: base64(digest), base32: base32(digest) }
}

/** Insert (or replace) the IRmark in a message that already has the element. */
export async function stampIrmark(
  message: string,
): Promise<{ message: string; irmark: Irmark }> {
  const irmark = await computeIrmark(message)
  const stamped = message.replace(
    /(<IRmark\b[^>]*>)[\s\S]*?(<\/IRmark>)/,
    `$1${irmark.base64}$2`,
  )
  if (stamped === message && !message.includes(`>${irmark.base64}<`)) {
    throw new IrmarkError('message has no <IRmark> element to stamp')
  }
  return { message: stamped, irmark }
}

/** C14N text escaping for content we generate ourselves. */
export function escapeText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r/g, '&#xD;')
}

export function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;')
    .replace(/\t/g, '&#x9;')
    .replace(/\n/g, '&#xA;')
    .replace(/\r/g, '&#xD;')
}
