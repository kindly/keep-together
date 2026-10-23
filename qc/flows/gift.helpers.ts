import { ConvexHttpClient } from 'convex/browser'
import type { Instance, QcUser } from '../fixtures'
import { api } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'

// Gifts and declarations for the gift page and contact panel specs (cash
// gifts step 5). The record-gift page (step 3) isn't built yet, so they are
// made through the API, as the signed-in user, outside any timed window.

export const GIFT_ROUTE = {
  type: 'route',
  description: '/t/$slug/gifts/$giftId',
}

/** Who records: a signed-in client for one tenant. */
export type Recorder = {
  client: ConvexHttpClient
  tenantId: Id<'tenants'>
  /** A source code of the tenant, for every gift. */
  codeId: Id<'sourceCodes'>
}

export async function recorder(
  inst: Instance,
  user: QcUser,
  tenantId: string,
): Promise<Recorder> {
  const client = new ConvexHttpClient(inst.url)
  const { tokens } = await client.action(api.auth.signIn, {
    provider: 'password',
    params: { email: user.email, password: user.password, flow: 'signIn' },
  })
  if (!tokens) throw new Error(`no session for ${user.email}`)
  client.setAuth(tokens.token)
  const tid = tenantId as Id<'tenants'>
  const { codes } = await client.query(api.sources.queries.picker, {
    tenantId: tid,
    today: today(),
    search: 'Event-Gala-001',
  })
  if (!codes.length) throw new Error('no Event-Gala-001 code to give under')
  return { client, tenantId: tid, codeId: codes[0].versionId }
}

/** Today, YYYY-MM-DD, as the SPA's `localToday`. */
export function today(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** A cash gift of `pence` from `contactId`. */
export function recordGift(
  r: Recorder,
  contactId: string,
  pence: bigint,
  receivedOn = today(),
): Promise<Id<'contributions'>> {
  return r.client.mutation(api.giving.mutations.create, {
    tenantId: r.tenantId,
    contactId: contactId as Id<'contacts'>,
    receivedOn,
    amount: pence,
    method: 'cash',
    allocations: [{ sourceCodeId: r.codeId, amount: pence }],
  })
}

/** An enduring declaration by `contactId`, made on `madeOn`. */
export async function declare(
  r: Recorder,
  contactId: string,
  madeOn: string,
  method: 'paperForm' | 'oral' | 'staffTickedNoEvidence' = 'paperForm',
): Promise<Id<'giftAidDeclarations'>> {
  const { id } = await r.client.mutation(api.giftaid.mutations.declare, {
    tenantId: r.tenantId,
    contactId: contactId as Id<'contacts'>,
    scope: 'futureAndPast4y',
    madeOn,
    method,
    wordingVersion: 'hmrc-2016-04',
    firstName: 'Qc',
    lastName: 'Donor',
    addressLine1: '1 High Street',
    postcode: 'AB1 2CD',
  })
  return id
}

/** The contact id at the end of a contact page's URL. */
export function contactIdOf(url: string): string {
  return new URL(url).pathname.split('/').at(-1)!
}
