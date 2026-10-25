import { randomUUID } from 'node:crypto'
import { sessionCookie, sessionToken } from '../fixtures'
import type { Instance, QcUser } from '../fixtures'
import type { Created } from '../../src/lib/data/rust-types/Created'
import type { Executed } from '../../src/lib/data/rust-types/Executed'
import type { RecordedGift } from '../../src/lib/data/rust-types/RecordedGift'
import type { SourcePicker } from '../../src/lib/data/rust-types/SourcePicker'

// Gifts and declarations for the gift page and contact panel specs (cash
// gifts step 5), made through the Rust API as the signed-in user (a fresh
// session: fixtures' sessionToken), outside any timed window.

export const GIFT_ROUTE = {
  type: 'route',
  description: '/t/$slug/gifts/$giftId',
}

/** Who records: a session on one tenant. */
export type Recorder = {
  inst: Instance
  /** The session cookie's value. */
  token: string
  slug: string
  /** A source code of the tenant, for every gift. */
  codeId: string
}

async function call<T>(
  r: Pick<Recorder, 'inst' | 'token' | 'slug'>,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${r.inst.api}/api/t/${r.slug}/${path}`, {
    method,
    headers: {
      cookie: sessionCookie(r.inst, r.token),
      ...(body !== undefined && { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok)
    throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}

export async function recorder(
  inst: Instance,
  user: QcUser,
  slug: string,
): Promise<Recorder> {
  const token = await sessionToken(inst, user.email)
  const q = new URLSearchParams({ today: today(), search: 'Event-Gala-001' })
  const { codes } = await call<SourcePicker>(
    { inst, token, slug },
    'GET',
    `sources/picker?${q.toString()}`,
  )
  if (!codes.length) throw new Error('no Event-Gala-001 code to give under')
  return { inst, token, slug, codeId: codes[0].versionId }
}

/** Today, YYYY-MM-DD, as the SPA's `localToday`. */
export function today(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * A cash gift of `pence` from `contactId`: the record-gift save, so a
 * contact with no acquisition code gets the gift's.
 */
export async function recordGift(
  r: Recorder,
  contactId: string,
  pence: bigint,
  receivedOn = today(),
): Promise<string> {
  const amount = Number(pence)
  const { giftId } = await call<RecordedGift>(r, 'POST', 'gifts/record', {
    clientKey: randomUUID(),
    contact: contactId,
    receivedOn,
    amount,
    method: 'cash',
    allocations: [{ sourceCodeId: r.codeId, amount }],
  })
  return giftId
}

/** An enduring declaration by `contactId`, made on `madeOn`. */
export async function declare(
  r: Recorder,
  contactId: string,
  madeOn: string,
  method: 'paperForm' | 'oral' | 'staffTickedNoEvidence' = 'paperForm',
  snapshot: { addressLine1?: string; postcode?: string } = {},
): Promise<string> {
  const { id } = await call<Executed>(
    r,
    'POST',
    `contacts/${contactId}/giftaid`,
    {
      contactId,
      scope: 'futureAndPast4y',
      madeOn,
      method,
      wordingVersion: 'hmrc-2016-04',
      firstName: 'Qc',
      lastName: 'Donor',
      addressLine1: '1 High Street',
      postcode: 'AB1 2CD',
      ...snapshot,
    },
  )
  return id
}

/** Void or un-void a gift, as another user's page would. */
export async function setGiftStatus(
  r: Recorder,
  id: string,
  expected: number,
  status: 'void' | 'completed',
): Promise<void> {
  await call(r, 'POST', `gifts/${id}/status`, { expected, status })
}

/** Cancel every declaration of `contactId` open on `from`. */
export async function cancelDeclarations(
  r: Recorder,
  contactId: string,
  from: string,
): Promise<void> {
  await call(r, 'POST', `contacts/${contactId}/giftaid/cancel`, {
    cancelledFrom: from,
  })
}

/**
 * A new individual with no gifts or declarations: one per sample where a
 * flow would otherwise pile rows onto one contact (a real donor has one or
 * two declarations, not dozens).
 */
export async function newDonor(r: Recorder, lastName: string): Promise<string> {
  const { id } = await call<Created>(r, 'POST', 'contacts', {
    kind: 'individual',
    title: '',
    firstName: 'Qc',
    lastName,
    nickname: '',
    name: '',
    isDeceased: false,
  })
  return id
}

/** The contact id at the end of a contact page's URL. */
export function contactIdOf(url: string): string {
  return new URL(url).pathname.split('/').at(-1)!
}
