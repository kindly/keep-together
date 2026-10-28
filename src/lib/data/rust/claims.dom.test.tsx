// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { TenantContext } from '../../tenant'
import type { Tenant } from '../../tenant'
import { applyEvent } from '../events'
import type { GiftAidClaimPreview } from '../rust-types/GiftAidClaimPreview'
import type { GiftAidClaimView } from '../rust-types/GiftAidClaimView'
import {
  attachmentName,
  claimFromWire,
  downloadClaim,
  previewFromWire,
  useClaim,
  useClaimPreview,
  useClaimStep,
  useCreateClaims,
} from './claims'
import { RustApiError } from './client'
import { keys } from './keys'

// Gift Aid claims on the data layer (G3): pence become bigint, the
// create sends the preview's totals back, a step shows only the claim
// the server read back (rule 4), and a refused download is an error the
// page can show, not a JSON file.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const SLUG = 'alpha'
const CLAIM = '0190f1d23c4b7a00800000000000c1a1'

const totals = {
  lines: 1,
  donations: 2000,
  reclaim: 500,
  adjustment: 125,
  net: 375,
}
const line = {
  key: 'l1',
  giftId: 'g1',
  declarationId: 'd1',
  contactId: 'c1',
  title: '',
  firstName: 'Jo',
  lastName: 'Bloggs',
  house: '12',
  postcode: 'AB1 2CD',
  overseas: false,
  receivedOn: '2026-01-02',
  amount: 2000,
  reclaim: 500,
}
const adjustment = {
  giftId: 'g0',
  originalClaimId: 'c0',
  amount: 125,
  reason: 'Entered twice',
}

function wireClaim(over: Partial<GiftAidClaimView> = {}): GiftAidClaimView {
  return {
    id: CLAIM,
    number: 3,
    status: 'draft',
    periodEnd: '2026-10-28',
    earliestDate: '2026-01-02',
    totals,
    submittedOn: null,
    hmrcReference: null,
    paidOn: null,
    paidAmount: null,
    rejectedReason: null,
    createdBy: 1,
    createdAt: 1000,
    statusVersion: 0,
    lines: [line],
    adjustments: [adjustment],
    voidedGifts: [],
    ...over,
  }
}

const wirePreview: GiftAidClaimPreview = {
  periodEnd: '2026-10-28',
  today: '2026-10-28',
  claimableFrom: '2022-10-28',
  lines: [line],
  adjustments: [adjustment],
  excluded: [
    {
      giftId: 'g9',
      contactId: 'c9',
      contactName: 'No Postcode',
      receivedOn: '2026-02-01',
      amount: 1500,
      reasons: ['No postcode'],
    },
  ],
  tooOld: 2,
  totals,
  claims: 1,
}

let answers: Array<() => Promise<Response>> = []
const json = (status: number, body: unknown) => () =>
  Promise.resolve(new Response(JSON.stringify(body), { status }))
const sent: Array<{ url: string; body: unknown }> = []

let root: Root
let el: HTMLDivElement
let qc: QueryClient
beforeEach(() => {
  answers = []
  sent.length = 0
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      sent.push({
        url,
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      })
      const next = answers.shift()
      return next ? next() : json(200, {})()
    }),
  )
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
  vi.unstubAllGlobals()
})

function mount<T>(hook: () => T): () => T {
  let value: T | undefined
  function Probe() {
    value = hook()
    return null
  }
  const wrap = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <TenantContext.Provider value={{ slug: SLUG } as unknown as Tenant}>
        {children}
      </TenantContext.Provider>
    </QueryClientProvider>
  )
  act(() => root.render(wrap({ children: <Probe /> })))
  return () => value!
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 0)))
/** Settle until `ready` holds (a fetch's answer takes a few turns). */
async function until(ready: () => boolean) {
  for (let i = 0; i < 50 && !ready(); i++) await settle()
}

test('every money figure becomes bigint pence', () => {
  const c = claimFromWire(wireClaim({ paidAmount: 375, status: 'paid' }))
  expect(c.totals).toEqual({
    lines: 1,
    donations: 2000n,
    reclaim: 500n,
    adjustment: 125n,
    net: 375n,
  })
  expect(c.paidAmount).toBe(375n)
  expect(c.lines[0]).toMatchObject({ amount: 2000n, reclaim: 500n })
  expect(c.adjustments[0].amount).toBe(125n)
  const p = previewFromWire(wirePreview)
  expect(p.excluded[0].amount).toBe(1500n)
  expect(p.totals.net).toBe(375n)
})

test("create sends the preview's totals, so a changed preview is refused", async () => {
  const create = mount(() => useCreateClaims())
  answers.push(json(200, { claims: [wireClaim()] }))
  let made: Awaited<ReturnType<ReturnType<typeof useCreateClaims>>> = []
  await act(async () => {
    made = await create()(previewFromWire(wirePreview))
  })
  expect(sent[0].url).toBe('/api/t/alpha/giftaid/claims')
  expect(sent[0].body).toEqual({
    periodEnd: '2026-10-28',
    expectedLines: 1,
    expectedDonations: 2000,
    expectedAdjustment: 125,
  })
  expect(made.map((c) => c.number)).toEqual([3])
  // The new claim's page opens from the answer, with no round trip.
  expect(qc.getQueryData(keys.claim(SLUG, CLAIM))).toMatchObject({
    number: 3,
  })
})

test('a step shows the claim the server read back, never what was sent', async () => {
  answers.push(json(200, wireClaim()))
  const read = mount(() => ({
    claim: useClaim(CLAIM),
    step: useClaimStep(CLAIM),
  }))
  await until(() => read().claim.data !== undefined)
  expect(read().claim.data?.status).toBe('draft')
  answers.push(
    json(200, {
      id: CLAIM,
      counter: 2,
      view: wireClaim({
        status: 'paid',
        statusVersion: 2,
        paidOn: '2026-10-27',
        paidAmount: 370,
      }),
    }),
  )
  await act(async () => {
    await read().step(1, {
      status: 'paid',
      paidOn: '2026-10-28',
      paidAmount: 37500n,
    })
  })
  await settle()
  expect(sent.at(-1)?.body).toEqual({
    expected: 1,
    status: 'paid',
    paidOn: '2026-10-28',
    paidAmount: 37500,
  })
  expect(read().claim.data).toMatchObject({
    status: 'paid',
    paidOn: '2026-10-27',
    paidAmount: 370n,
  })
})

test('a deleted draft is null; a stale step reads the claim again', async () => {
  answers.push(json(200, wireClaim()))
  const read = mount(() => ({
    claim: useClaim(CLAIM),
    step: useClaimStep(CLAIM),
  }))
  await until(() => read().claim.data !== undefined)
  answers.push(
    json(409, {
      kind: 'stale',
      contract: 'giftaid.claimStatus',
      counter: 1,
      current: {},
    }),
  )
  answers.push(json(200, wireClaim({ status: 'ready', statusVersion: 1 })))
  await act(async () => {
    await expect(read().step(0, { status: 'ready' })).rejects.toBeInstanceOf(
      RustApiError,
    )
  })
  await until(() => read().claim.data?.status === 'ready')
  expect(read().claim.data?.status).toBe('ready')
  answers.push(json(200, { id: CLAIM, counter: 2, view: null }))
  let after: unknown = 'unset'
  await act(async () => {
    after = await read().step(1, { status: 'deleted' })
  })
  await until(() => read().claim.data === null)
  expect(after).toBeNull()
  expect(read().claim.data).toBeNull()
})

test("a claim's event refetches the claims reads", () => {
  qc.setQueryData(keys.claims(SLUG), [])
  qc.setQueryData(keys.claimPreview(SLUG, '2026-10-28'), {})
  applyEvent(qc, SLUG, {
    seq: 1,
    entity: 'gift_aid_claims',
    id: CLAIM,
    contract: 'giftaid.claimStatus',
    counter: 1,
  })
  expect(qc.getQueryState(keys.claims(SLUG))?.isInvalidated).toBe(true)
  expect(
    qc.getQueryState(keys.claimPreview(SLUG, '2026-10-28'))?.isInvalidated,
  ).toBe(true)
})

test('a download hands over the file under its own name', async () => {
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(() => {})
  const names: Array<string> = []
  click.mockImplementation(function (this: HTMLAnchorElement) {
    names.push(this.download)
  })
  vi.stubGlobal(
    'URL',
    Object.assign(URL, {
      createObjectURL: () => 'blob:x',
      revokeObjectURL: () => {},
    }),
  )
  answers.push(() =>
    Promise.resolve(
      new Response('PK', {
        status: 200,
        headers: {
          'content-disposition': 'attachment; filename="gift-aid-claim-3.ods"',
        },
      }),
    ),
  )
  await downloadClaim(SLUG, CLAIM, 'excel')
  expect(sent[0].url).toBe(
    `/api/t/alpha/giftaid/claims/${CLAIM}/schedule?format=excel`,
  )
  expect(names).toEqual(['gift-aid-claim-3.ods'])
  click.mockRestore()
})

test('a refused download is the server’s refusal, not a file', async () => {
  answers.push(
    json(422, {
      kind: 'rejected',
      reason: 'missing_hmrc_details',
      message: 'Set the HMRC details first: HMRC reference',
    }),
  )
  const err = await downloadClaim(SLUG, CLAIM, 'xml').catch((e: unknown) => e)
  expect(sent[0].url).toBe(`/api/t/alpha/giftaid/claims/${CLAIM}/xml`)
  expect(err).toBeInstanceOf(RustApiError)
  expect((err as RustApiError).message).toBe(
    'Set the HMRC details first: HMRC reference',
  )
})

test('the file name comes from Content-Disposition, else a fallback', () => {
  expect(attachmentName('attachment; filename="a.xml"', 'b')).toBe('a.xml')
  expect(attachmentName(null, 'b')).toBe('b')
})

test('a preview nothing shows is dropped: coming back reads it afresh', async () => {
  answers.push(json(200, wirePreview))
  const read = mount(() => useClaimPreview('2026-10-28'))
  await until(() => read().data !== undefined)
  expect(read().data?.totals.reclaim).toBe(500n)
  act(() => root.render(null))
  await settle()
  expect(qc.getQueryData(keys.claimPreview(SLUG, '2026-10-28'))).toBeUndefined()
})
