// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Id } from '../lib/domain/ids'
import type { Declaration } from '../lib/giftaid'
import type { ScanPairingView, ScanView } from '../lib/data'
import { DeclarationScanLine, ScanReview, ScanWithPhone } from './scans'

// Declaration scans on the laptop (step 4): the sitting's QR code, link
// and live stack; the side-by-side review's accept and discard; the
// pages' reorder; "✓ scan held" for anyone, the image for staff only.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const writes = {
  reorder: vi.fn(),
  merge: vi.fn(),
  accept: vi.fn(),
  discard: vi.fn(),
  deleteImages: vi.fn(),
}
const start = vi.fn()
const end = vi.fn()
const endNow = vi.fn()
const refetchPairing = vi.fn()
const snapshot = vi.fn()
let pairing: ScanPairingView | undefined
let scan: ScanView | null
let declarations: Array<Declaration> = []
let held: Record<
  string,
  { held: Array<unknown>; scans: Array<ScanView> | null }
> = {}
let canWrite = true
vi.mock('../lib/data', () => ({
  fetchContactSnapshot: (...a: Array<unknown>) => snapshot(...a),
  scanLink: (path: string) => `https://keep.test${path}`,
  endScanPairingNow: (...a: Array<unknown>) => endNow(...a),
  scanPageUrl: (slug: string, id: string, n: number, page: string) =>
    `/api/t/${slug}/scans/${id}/pages/${n}?p=${page}`,
  useAuthState: () => ({ method: 'password' }),
  useContactSearch: () => undefined,
  useDeclarations: () => ({ declarations, currentId: null }),
  useDeclarationScans: (id: string) => held[id],
  useEndScanPairing: () => end,
  useMembers: () => [{ userId: 1, name: 'Jo Staff' }],
  useScan: () => ({ isPending: false, error: null, data: scan }),
  useScanInbox: () => ({ data: [] }),
  useScanPairing: () => ({ data: pairing, refetch: refetchPairing }),
  useScanWrites: () => writes,
  useStartScanPairing: () => start,
}))
vi.mock('../lib/tenant', () => ({
  useTenant: () => ({ _id: 'tenantA', slug: 'alpha' }),
  useCanWrite: () => canWrite,
}))

function scanView(over: Partial<ScanView> = {}): ScanView {
  return {
    id: 's1',
    status: 'draft',
    via: 'phone',
    pairingId: 'p1',
    scannedBy: 1,
    scannedAt: Date.UTC(2026, 9, 29, 10),
    declarationId: null,
    reviewedBy: null,
    reviewedAt: null,
    discardReason: null,
    imageDeletedAt: null,
    deletionReason: null,
    pages: [
      { id: 'pg1', pageNo: 1n, width: 1240n, height: 1754n, size: 200_000 },
      { id: 'pg2', pageNo: 2n, width: 1240n, height: 1754n, size: 190_000 },
    ],
    scanVersion: 1,
    reviewVersion: 0,
    retentionVersion: 0,
    ...over,
  }
}

function pairingView(over: Partial<ScanPairingView> = {}): ScanPairingView {
  const now = Date.now()
  return {
    id: 'p1',
    purpose: 'contact',
    startedBy: 1,
    createdAt: now,
    expiresAt: now + 2 * 3_600_000,
    idleExpiresAt: now + 15 * 60_000,
    claimed: false,
    endedAt: null,
    uploads: 0,
    scans: [],
    ...over,
  }
}

function paper(id: string, over: Partial<Declaration> = {}): Declaration {
  return {
    _id: id as Id<'giftAidDeclarations'>,
    contactId: 'c1' as Id<'contacts'>,
    scope: 'futureAndPast4y',
    madeOn: '2026-03-03',
    method: 'paperForm',
    wordingVersion: 'hmrc-2016-04',
    firstName: 'Jo',
    lastName: 'Bloggs',
    addressLine1: '1 High St',
    postcode: 'AB1 2CD',
    enteredAt: 0,
    declarationVersion: 0,
    cancellationVersion: 0,
    voidVersion: 0,
    detailsVersion: 0,
    warnings: [],
    ...over,
  }
}

let root: Root
let el: HTMLDivElement
beforeEach(() => {
  for (const m of Object.values(writes)) m.mockReset().mockResolvedValue({})
  start.mockReset().mockResolvedValue({
    pairing: pairingView(),
    path: '/scan.html#tok',
  })
  end.mockReset().mockResolvedValue({})
  endNow.mockReset()
  refetchPairing.mockReset().mockResolvedValue({})
  snapshot.mockReset().mockResolvedValue({
    firstName: 'Jo',
    lastName: 'Bloggs',
    addressLine1: '1 High St',
    postcode: 'AB1 2CD',
  })
  pairing = undefined
  scan = scanView()
  declarations = []
  held = {}
  canWrite = true
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
  document.body.innerHTML = ''
})

const render = (node: React.ReactNode) => act(async () => root.render(node))
const button = (name: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent === name)!
const click = (b: HTMLElement) => act(async () => b.click())
async function type(input: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )!.set!
  await act(async () => {
    set.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const text = () => document.body.textContent

test('a viewer has no "Scan with phone"', async () => {
  canWrite = false
  await render(<ScanWithPhone purpose="contact" />)
  expect(el.textContent).toBe('')
})

test('a sitting starts a pairing, shows its QR code and link, then the phone and the stack', async () => {
  await render(
    <ScanWithPhone purpose="contact" contactId={'c1' as Id<'contacts'>} />,
  )
  await click(button('Scan with phone'))
  expect(start).toHaveBeenCalledWith('contact')
  pairing = pairingView()
  await render(
    <ScanWithPhone purpose="contact" contactId={'c1' as Id<'contacts'>} />,
  )
  expect(
    document
      .querySelector('svg[aria-label^="QR code"] path')
      ?.getAttribute('d'),
  ).toBeTruthy()
  const link = document.querySelector<HTMLInputElement>('input[readonly]')!
  // The token is in the fragment, never the path or a query.
  expect(link.value).toBe('https://keep.test/scan.html#tok')
  expect(text()).toMatch(/Waiting for the phone\. The link ends in 1[45] min\./)
  expect(text()).toContain('None yet')

  pairing = pairingView({ claimed: true, scans: [scanView()] })
  await render(
    <ScanWithPhone purpose="contact" contactId={'c1' as Id<'contacts'>} />,
  )
  expect(text()).toContain('✓ A phone is connected.')
  expect(
    document.querySelectorAll('[data-testid="sitting-scan"]'),
  ).toHaveLength(1)
  expect(text()).toContain('Scans from this sitting (1)')

  await click(button('Review'))
  expect(text()).toContain('Review scan')
  expect(document.querySelectorAll('img[alt^="Scan, page"]')).toHaveLength(2)

  // Done ends the link; the scans stay to match.
  await click(button('Done'))
  expect(end).toHaveBeenCalledWith('p1')
})

test('an ended link says so and offers no code', async () => {
  pairing = pairingView({ endedAt: Date.now() })
  await render(<ScanWithPhone purpose="stack" />)
  await click(button('Scan with phone'))
  expect(text()).toContain('This link has ended.')
  expect(document.querySelector('svg[aria-label^="QR code"]')).toBeNull()
  // Nothing left to end.
  await click(button('Done'))
  expect(end).not.toHaveBeenCalled()
})

test('on the record-gift page, scans wait to be matched once the gift is saved', async () => {
  pairing = pairingView({ purpose: 'gift', scans: [scanView()] })
  await render(<ScanWithPhone purpose="gift" />)
  await click(button('Scan with phone'))
  expect(start).toHaveBeenCalledWith('gift')
  expect(
    document.querySelectorAll('[data-testid="sitting-scan"]'),
  ).toHaveLength(1)
  expect(button('Review')).toBeUndefined()
})

test('accept records a new paper declaration as written on the form, with the scan', async () => {
  await render(
    <ScanReview
      scanId="s1"
      contactId={'c1' as Id<'contacts'>}
      onDone={() => {}}
    />,
  )
  const madeOn = document.querySelector<HTMLInputElement>('input[type="date"]')!
  // Never assumed to be today: the form's own date decides coverage.
  expect(madeOn.value).toBe('')
  const form = document.querySelector<HTMLFormElement>(
    'form[aria-label="Match the scan"]',
  )!
  // Required: the browser holds the submit until it is filled in.
  expect(madeOn.required).toBe(true)
  await act(async () => form.requestSubmit())
  expect(writes.accept).not.toHaveBeenCalled()
  await type(madeOn, '2026-03-03')
  await act(async () => form.requestSubmit())
  expect(writes.accept).toHaveBeenCalledWith(scan, 'c1', {
    kind: 'new',
    declaration: {
      contactId: 'c1',
      scope: 'futureAndPast4y',
      madeOn: '2026-03-03',
      method: 'paperForm',
      wordingVersion: 'hmrc-2016-04',
      firstName: 'Jo',
      lastName: 'Bloggs',
      addressLine1: '1 High St',
      postcode: 'AB1 2CD',
    },
  })
})

test('only a paper declaration holding no scan can be matched', async () => {
  declarations = [
    paper('d1'),
    paper('d2'),
    paper('d3', { method: 'oral' }),
    paper('d4', { voidedAt: 1 }),
  ]
  held = {
    d1: { held: [], scans: [] },
    d2: { held: [{}], scans: [] },
  }
  await render(
    <ScanReview
      scanId="s1"
      contactId={'c1' as Id<'contacts'>}
      onDone={() => {}}
    />,
  )
  const radios = [
    ...document.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
  ]
  // New, d1, d2: the oral and the voided ones aren't offered.
  expect(radios).toHaveLength(3)
  expect(radios[1].disabled).toBe(false)
  expect(radios[2].disabled).toBe(true)
  expect(text()).toContain('(already has a scan)')
  await act(async () => radios[1].click())
  await act(async () =>
    document
      .querySelector<HTMLFormElement>('form[aria-label="Match the scan"]')!
      .requestSubmit(),
  )
  expect(writes.accept).toHaveBeenCalledWith(scan, 'c1', {
    kind: 'existing',
    declarationId: 'd1',
  })
})

test('discard asks first, with an optional reason', async () => {
  await render(<ScanReview scanId="s1" onDone={() => {}} />)
  await click(button('Discard'))
  const reason = document.querySelector<HTMLInputElement>(
    '[role="alertdialog"] input',
  )!
  const set = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )!.set!
  await act(async () => {
    set.call(reason, 'blurred')
    reason.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const confirm = [
    ...document.querySelectorAll('[role="alertdialog"] button'),
  ].find((b) => b.textContent === 'Discard') as HTMLElement
  await click(confirm)
  expect(writes.discard).toHaveBeenCalledWith(scan, 'blurred')
})

test('a draft’s pages move and go; a reviewed scan’s are fixed', async () => {
  await render(<ScanReview scanId="s1" onDone={() => {}} />)
  await click(
    document.querySelector<HTMLElement>('[aria-label="Move page 2 of 2 up"]')!,
  )
  expect(writes.reorder).toHaveBeenCalledWith(scan, ['pg2', 'pg1'])
  await click(
    document.querySelector<HTMLElement>('[aria-label="Remove page 1 of 2"]')!,
  )
  expect(writes.reorder).toHaveBeenLastCalledWith(scan, ['pg2'])

  scan = scanView({ status: 'accepted', declarationId: 'd1' })
  await render(<ScanReview scanId="s1" onDone={() => {}} />)
  expect(document.querySelector('[aria-label^="Move page"]')).toBeNull()
  expect(text()).toContain('✓ Matched')
})

test('anyone sees "✓ scan held"; only staff and admins can open it', async () => {
  held = {
    d1: {
      held: [
        {
          id: 's1',
          scannedAt: Date.UTC(2026, 2, 3),
          reviewedAt: 1,
          imagesHeld: true,
        },
      ],
      scans: null,
    },
  }
  await render(<DeclarationScanLine declarationId="d1" />)
  expect(el.textContent).toBe('✓ Scan held, scanned 3 Mar 2026')
  expect(el.querySelector('button')).toBeNull()

  held.d1.scans = [scanView({ status: 'accepted' })]
  await render(<DeclarationScanLine declarationId="d1" />)
  await click(button('View scan'))
  expect(document.querySelectorAll('img[alt^="Scan, page"]')).toHaveLength(2)
})

test('a page’s image URL names the page, so a reorder never shows a cached one', async () => {
  await render(<ScanReview scanId="s1" onDone={() => {}} />)
  expect(
    [...document.querySelectorAll('img[alt^="Scan, page"]')].map((i) =>
      i.getAttribute('src'),
    ),
  ).toEqual([
    '/api/t/alpha/scans/s1/pages/1?p=pg1',
    '/api/t/alpha/scans/s1/pages/2?p=pg2',
  ])
})

test('Done that fails to end the link stays open and says so', async () => {
  pairing = pairingView()
  let closed = false
  await render(
    <ScanWithPhone purpose="stack" onClose={() => (closed = true)} />,
  )
  await click(button('Scan with phone'))
  end.mockRejectedValueOnce(new Error('offline'))
  await click(button('Done'))
  expect(closed).toBe(false)
  expect(text()).toContain('Could not end the link')
  await click(button('Done'))
  expect(end).toHaveBeenCalledTimes(2)
  expect(closed).toBe(true)
})

test('leaving the page, or the tab going, ends the link without Done', async () => {
  pairing = pairingView()
  await render(<ScanWithPhone purpose="stack" />)
  await click(button('Scan with phone'))
  await act(async () => window.dispatchEvent(new Event('pagehide')))
  expect(endNow).toHaveBeenCalledExactlyOnceWith('alpha', 'p1')
  // Unmounted (navigated away) after a pagehide: nothing ended twice.
  await render(null)
  expect(endNow).toHaveBeenCalledTimes(1)

  endNow.mockReset()
  refetchPairing.mockReset().mockResolvedValue({})
  await render(<ScanWithPhone purpose="stack" />)
  await click(button('Scan with phone'))
  await render(null)
  expect(endNow).toHaveBeenCalledExactlyOnceWith('alpha', 'p1')
})

test('a start that answers after the dialog closed is ended at once', async () => {
  let answer!: (v: unknown) => void
  start.mockReturnValueOnce(new Promise((r) => (answer = r)))
  await render(<ScanWithPhone purpose="stack" />)
  await click(button('Scan with phone'))
  await click(button('Done'))
  expect(end).not.toHaveBeenCalled()
  await act(async () =>
    answer({ pairing: pairingView({ id: 'p9' }), path: '/scan.html#t9' }),
  )
  expect(endNow).toHaveBeenCalledExactlyOnceWith('alpha', 'p9')
})

test('a resumed sitting starts nothing, shows its stack, and offers a new link', async () => {
  pairing = pairingView({ scans: [scanView()] })
  const started = vi.fn()
  await render(
    <ScanWithPhone
      purpose="stack"
      initialOpen
      resume="p1"
      onStarted={started}
    />,
  )
  expect(start).not.toHaveBeenCalled()
  expect(document.querySelector('svg[aria-label^="QR code"]')).toBeNull()
  expect(text()).toContain('can’t be shown again')
  expect(
    document.querySelectorAll('[data-testid="sitting-scan"]'),
  ).toHaveLength(1)
  // A resumed link may be another tab's live sitting: never ended from
  // here, by a new link or by leaving.
  await click(button('Start a new link'))
  expect(start).toHaveBeenCalledWith('stack')
  expect(started).toHaveBeenCalledWith('p1')
  expect(end).not.toHaveBeenCalled()

  // (Leaving ends the new link this dialog started, not a resumed one.)
  await render(null)
  endNow.mockReset()
  await render(<ScanWithPhone purpose="stack" initialOpen resume="p7" />)
  await render(null)
  expect(endNow).not.toHaveBeenCalled()
})

test('a click outside doesn’t end the sitting; Esc while reviewing goes back', async () => {
  pairing = pairingView({ scans: [scanView()] })
  await render(<ScanWithPhone purpose="contact" />)
  await click(button('Scan with phone'))
  await click(button('Review'))
  await act(async () => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }),
    )
  })
  expect(text()).toContain('Scans from this sitting')
  expect(end).not.toHaveBeenCalled()
})

test('signed out or the pairing gone counts as ended; offline offers Close anyway', async () => {
  const { RustApiError } = await import('../lib/data/rust/client')
  pairing = pairingView()
  let closed = 0
  await render(<ScanWithPhone purpose="stack" onClose={() => (closed += 1)} />)
  await click(button('Scan with phone'))
  end.mockRejectedValueOnce(new RustApiError(401, { kind: 'unauthenticated' }))
  await click(button('Done'))
  expect(closed).toBe(1)

  await click(button('Scan with phone'))
  end.mockRejectedValue(new RustApiError(0, { kind: 'internal' }))
  await click(button('Done'))
  expect(closed).toBe(1)
  expect(text()).toContain('Could not end the link')
  await click(button('Close anyway'))
  expect(closed).toBe(2)
})

test('back from the back-forward cache, the link is read again', async () => {
  pairing = pairingView()
  await render(<ScanWithPhone purpose="stack" />)
  await click(button('Scan with phone'))
  const shown = (persisted: boolean) => {
    const e = new Event('pageshow') as PageTransitionEvent
    Object.defineProperty(e, 'persisted', { value: persisted })
    return act(async () => window.dispatchEvent(e))
  }
  await shown(false)
  expect(refetchPairing).not.toHaveBeenCalled()
  await shown(true)
  expect(refetchPairing).toHaveBeenCalledOnce()
})
