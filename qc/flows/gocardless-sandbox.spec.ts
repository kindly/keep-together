import { randomUUID } from 'node:crypto'
import type { Browser, Page } from '@playwright/test'
import {
  GoCardlessUnreachable,
  expect,
  noteLateWebhook,
  qcGoCardless,
  seedWorld,
  sessionCookie,
  sessionState,
  sessionToken,
  skipGoCardlessUnreachable,
  skipNoQcGoCardless,
  skipUnlessFakeGoCardless,
  test,
} from '../fixtures'
import type { Instance } from '../fixtures'
import type { GiftPage } from '../../src/lib/data/rust-types/GiftPage'
import type { GiftRow } from '../../src/lib/data/rust-types/GiftRow'
import type { GoCardlessStatus } from '../../src/lib/data/rust-types/GoCardlessStatus'
import type { QcConnected } from '../../src/lib/data/rust-types/QcConnected'
import type { QcPeek } from '../../src/lib/data/rust-types/QcPeek'
import type { QcSigned } from '../../src/lib/data/rust-types/QcSigned'
import type { QcCaughtUp } from '../../src/lib/data/rust-types/QcCaughtUp'
import type { RegularGiftView } from '../../src/lib/data/rust-types/RegularGiftView'
import { createContact, section, uniqueName } from './contact.helpers'
import { contactIdOf } from './gift.helpers'

// Direct Debit against GoCardless itself (plan gocardless-sandbox-qc.sv,
// G3): on keep-qc the sandbox with its QC account, locally the fake
// (g1q8). Every flow starts from the app's own "Set up Direct Debit";
// the donor's side (sign) and GoCardless's moves (its scenario
// simulators) go through the QC GoCardless surface, and the money is
// checked where the app keeps it. Untimed (g1q5): no flow, no budget.
//
// Serial, in one worker, in a world of its own (its group holds the QC
// account, which no other spec's group may take). Waiting is polling the
// app's own reads with backoff up to 90 s, then the catch-up once and 30 s
// more: a pass that needed it gets the GOCARDLESS LATE WEBHOOK banner
// (g1q3). GoCardless unreachable (no answer, or 503 after the surface's
// retry) skips the rest with the GOCARDLESS SANDBOX UNREACHABLE banner
// (g1q4); a target without the surface skips with its own banner.

const WAIT_MS = 90_000
const AFTER_CATCHUP_MS = 30_000
const BACKOFF = [500, 1_000, 2_000, 5_000]

test.describe.configure({ mode: 'serial', timeout: 300_000 })

interface Made {
  id: string
  contactId: string
  contactUrl: string
  mandate: string
  subscription: string
}

let inst: Instance
let slug = ''
let token = ''
let mode = ''
/** Why the run can't use GoCardless: no surface, or it didn't answer. */
let noQc: string | null = null
let unreachable: string | null = null
/** Every regular gift made here, cancelled after if still live. */
const made: Array<string> = []
/** Set up → active's gift: the payment flows and the cancel use it. */
let main: Made | null = null

// ── the app's api, as the group's admin ─────────────────────────────────

async function app<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${inst.api}/api/t/${slug}/${path}`, {
    method,
    headers: {
      cookie: sessionCookie(inst, token),
      ...(body !== undefined && { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`)
  return JSON.parse(text) as T
}

const regular = (id: string) =>
  app<RegularGiftView>('GET', `regular-gifts/${id}`)

async function giftFor(contactId: string, payment: string) {
  const page = await app<GiftPage>(
    'GET',
    `contacts/${contactId}/gifts?limit=50`,
  )
  return page.rows.find((g: GiftRow) => g.providerPaymentId === payment) ?? null
}

// ── GoCardless, through the QC surface ──────────────────────────────────

/** A QC GoCardless call that must succeed; unreachable skips the rest. */
async function qc<T>(
  method: 'GET' | 'POST',
  what: string,
  body?: unknown,
): Promise<T> {
  try {
    const { status, data } = await qcGoCardless<T>(inst, method, what, body)
    expect(status, `${what}: ${JSON.stringify(data)}`).toBe(200)
    return data
  } catch (err) {
    if (err instanceof GoCardlessUnreachable) {
      unreachable = err.message
      skipGoCardlessUnreachable(err.message)
    }
    throw err
  }
}

const sign = (id: string) =>
  qc<QcSigned>('POST', 'sign', { slug, regularGiftId: id }).then(
    (s) => s.mandateId,
  )

const simulate = (scenario: string, resource: string) =>
  qc('POST', 'simulate', { slug, scenario, resource })

const peek = (kind: 'mandate' | 'subscription' | 'payment', id: string) =>
  qc<QcPeek>('GET', `peek/${slug}/${kind}/${id}`)

/** Payments GoCardless may still collect. */
const COLLECTABLE = [
  'pending_customer_approval',
  'pending_submission',
  'submitted',
]

// ── waiting ─────────────────────────────────────────────────────────────

/**
 * `read` until `ready`: backing off up to 90 s, then the catch-up once and
 * 30 s more (noted for the LATE WEBHOOK banner). Never a fixed sleep.
 */
async function until<T>(
  what: string,
  read: () => Promise<T>,
  ready: (t: T) => boolean,
): Promise<T> {
  let last: T | undefined
  const poll = (timeout: number) =>
    expect
      .poll(
        async () => {
          last = await read()
          return ready(last)
        },
        { intervals: BACKOFF, timeout, message: what },
      )
      .toBe(true)
  const started = Date.now()
  try {
    await poll(WAIT_MS)
    return last!
  } catch {
    // Not in 90 s: the catch-up, once, then a last wait.
  }
  const caught = await qc<QcCaughtUp>('POST', 'catchup', { slug })
  try {
    await poll(AFTER_CATCHUP_MS)
  } catch {
    throw new Error(
      `${what}: not after ${Math.round((Date.now() - started) / 1000)} s and a catch-up (it read ${caught.read} events, ${caught.missed} missed)`,
    )
  }
  noteLateWebhook(
    `${what}: after ${Math.round((Date.now() - started) / 1000)} s; the catch-up read ${caught.read} events, ${caught.missed} missed`,
  )
  return last!
}

// ── the app's screens ───────────────────────────────────────────────────

async function signedIn(browser: Browser): Promise<Page> {
  const context = await browser.newContext({
    baseURL: inst.baseURL,
    viewport: { width: 1280, height: 800 },
    storageState: sessionState(inst, token),
  })
  return context.newPage()
}

const card = (page: Page, id: string) =>
  page.locator(`[data-testid="regular-gift"][data-id="${id}"]`)

/**
 * A new donor, then "Set up Direct Debit" on their page: `pounds` a month
 * on `day`, under Event-Gala-001. The regular gift made, waiting for the
 * donor; GoCardless not answering skips the rest.
 */
async function setUp(
  page: Page,
  pounds: string,
  day: number,
): Promise<{ view: RegularGiftView; contactId: string; contactUrl: string }> {
  const contactUrl = await createContact(page, slug, uniqueName('gcsb'), 'Dee')
  const contactId = contactIdOf(contactUrl)
  await section(page, 'Direct Debit')
    .getByRole('button', { name: 'Set up Direct Debit' })
    .click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Amount (£)').fill(pounds)
  await dialog.getByLabel('Day of the month').selectOption(String(day))
  await dialog
    .getByRole('combobox', { name: 'Source code' })
    .fill('Event-Gala-001')
  await dialog
    .getByRole('listbox', { name: 'Source code matches' })
    .getByRole('option', { name: /Event-Gala-001/ })
    .first()
    .click()
  await dialog.getByRole('button', { name: 'Set up' }).click()
  const said = dialog.getByRole('status').or(dialog.getByRole('alert'))
  await expect(said).toBeVisible({ timeout: 60_000 })
  const text = (await said.textContent()) ?? ''
  if (/GoCardless isn.t answering/.test(text)) {
    unreachable = `set up: ${text}`
    skipGoCardlessUnreachable(unreachable)
  }
  expect(text).toContain('Ready:')
  const [view] = await app<Array<RegularGiftView>>(
    'GET',
    `contacts/${contactId}/regular-gifts`,
  )
  made.push(view.id)
  return { view, contactId, contactUrl }
}

/** Signed and activated, as GoCardless reports it to the app. */
async function active(
  id: string,
): Promise<{ mandate: string; subscription: string }> {
  const mandate = await sign(id)
  await until(
    'the mandate, from GoCardless’s webhook',
    () => regular(id),
    (v) => v.mandateId === mandate,
  )
  await simulate('mandate_activated', mandate)
  const now = await until(
    'the gift active, with its subscription',
    () => regular(id),
    (v) => v.status === 'active' && v.subscriptionId !== null,
  )
  return { mandate, subscription: now.subscriptionId! }
}

/**
 * "Take a one-off payment" of `pounds` on `m`'s card: the payment
 * GoCardless made (the one new on the mandate).
 */
async function oneOff(page: Page, m: Made, pounds: string): Promise<string> {
  const before = new Set(
    (await peek('mandate', m.mandate)).payments.map((p) => p.id),
  )
  await page.goto(m.contactUrl)
  await card(page, m.id)
    .getByRole('button', { name: 'Take a one-off payment' })
    .click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Amount (£)').fill(pounds)
  await dialog.getByRole('button', { name: 'Take payment' }).click()
  await expect(dialog.getByRole('status')).toContainText(
    'Asked GoCardless to collect',
    {
      timeout: 60_000,
    },
  )
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  const seen = await until(
    'the one-off at GoCardless',
    () => peek('mandate', m.mandate),
    (s) => s.payments.some((p) => !before.has(p.id)),
  )
  return seen.payments.find((p) => !before.has(p.id))!.id
}

/** The payment's gift once it has `status`. */
const giftOnce = (m: Made, payment: string, status: GiftRow['status']) =>
  until(
    `the gift for ${payment} ${status}`,
    () => giftFor(m.contactId, payment),
    (g) => g?.status === status,
  ).then((g) => g!)

function needMain(): Made {
  if (!main) throw new Error('set up → active did not run: nothing to pay into')
  return main
}

// ── the run ─────────────────────────────────────────────────────────────

test.describe('GoCardless sandbox', () => {
  test.beforeAll(async ({ instance }, workerInfo) => {
    inst = instance
    const world = await seedWorld(instance, 500 + workerInfo.parallelIndex)
    slug = world.tenants[0].slug
    token = await sessionToken(instance, world.users[0].email)
    try {
      const { status, data } = await qcGoCardless<QcConnected>(
        instance,
        'POST',
        'connect',
        { slug },
      )
      if (status === 404) noQc = `connect: 404 on ${instance.name}`
      else if (status !== 200)
        throw new Error(`connect: ${status} ${JSON.stringify(data)}`)
    } catch (err) {
      if (!(err instanceof GoCardlessUnreachable)) throw err
      unreachable = err.message
    }
    if (!noQc && !unreachable)
      mode = (await app<GoCardlessStatus>('GET', 'gocardless')).mode
  })

  test.beforeEach(() => {
    if (noQc) skipNoQcGoCardless(noQc)
    if (unreachable) skipGoCardlessUnreachable(unreachable)
  })

  test.afterAll(async () => {
    if (noQc || !slug) return
    for (const id of made) {
      try {
        const v = await regular(id)
        if (v.status === 'pending' || v.status === 'active')
          await app('POST', `regular-gifts/${id}/cancel`, {
            expected: v.mandateVersion,
          })
      } catch (err) {
        console.warn(`gocardless-sandbox: cancelling ${id}: ${String(err)}`)
      }
    }
    try {
      await qcGoCardless(inst, 'POST', 'cleanup', { slug })
    } catch (err) {
      console.warn(`gocardless-sandbox: cleanup: ${String(err)}`)
    }
  })

  test('set up → active; the signed webhook gets through', async ({
    browser,
  }) => {
    const page = await signedIn(browser)
    const { view, contactId, contactUrl } = await setUp(page, '12.50', 5)
    expect(view.status).toBe('pending')
    // The mandate reaches the app only in GoCardless's signed webhook
    // (through the CSRF guard with GoCardless's Origin) or the catch-up;
    // in time and with nothing parked, it was the webhook.
    const { mandate, subscription } = await active(view.id)
    const status = await app<GoCardlessStatus>('GET', 'gocardless')
    expect(status.failedEvents).toBe(0)
    await page.goto(contactUrl)
    const shown = card(page, view.id)
    await expect(shown.getByTestId('regular-gift-status')).toHaveText('Active')
    await expect(shown.getByTestId('regular-gift-mandate')).toHaveText(mandate)
    expect((await peek('mandate', mandate)).status).toBe('active')
    main = { id: view.id, contactId, contactUrl, mandate, subscription }
  })

  test('a payment: a pending gift, then confirmed, received', async ({
    browser,
  }) => {
    const m = needMain()
    const page = await signedIn(browser)
    const pm = await oneOff(page, m, '7.50')
    const pending = await giftOnce(m, pm, 'pending')
    expect(pending.amount).toBe(750)
    await simulate('payment_confirmed', pm)
    const received = await giftOnce(m, pm, 'completed')
    expect(received.id).toBe(pending.id)
    expect(received.amount).toBe(750)
    const at = await peek('payment', pm)
    expect(at.amount).toBe(750)
    expect(received.receivedOn).toBe(at.chargeDate)
    await page.goto(`/t/${slug}/gifts/${received.id}`)
    await expect(page.getByText('£7.50').first()).toBeVisible()
    await expect(page.getByTestId('gift-status')).toHaveCount(0)
  })

  test('a payment fails: its gift failed', async ({ browser }) => {
    const m = needMain()
    const pm = await oneOff(await signedIn(browser), m, '3')
    await giftOnce(m, pm, 'pending')
    await simulate('payment_failed', pm)
    const g = await giftOnce(m, pm, 'failed')
    expect(g.amount).toBe(300)
  })

  test('a payment charged back: its gift charged back', async ({ browser }) => {
    const m = needMain()
    const pm = await oneOff(await signedIn(browser), m, '4')
    await giftOnce(m, pm, 'pending')
    // The sandbox's simulator runs from pending_submission (its
    // precondition), through confirmed and paid out, to charged back.
    await simulate('payment_charged_back', pm)
    const g = await giftOnce(m, pm, 'charged_back')
    expect(g.amount).toBe(400)
  })

  test('cancel: mandate, subscription and every payment left to collect cancelled', async ({
    browser,
  }) => {
    const m = needMain()
    const page = await signedIn(browser)
    const pm = await oneOff(page, m, '2')
    await giftOnce(m, pm, 'pending')
    await page.goto(m.contactUrl)
    await card(page, m.id)
      .getByRole('button', { name: 'Cancel Direct Debit' })
      .click()
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Cancel Direct Debit' })
      .click()
    await until(
      'the gift ended',
      () => regular(m.id),
      (v) => v.status === 'cancelled',
    )
    const mandate = await until(
      'the mandate cancelled, nothing left to collect',
      () => peek('mandate', m.mandate),
      (s) =>
        s.status === 'cancelled' &&
        s.payments.every((p) => !COLLECTABLE.includes(p.status)),
    )
    expect(mandate.payments.find((p) => p.id === pm)?.status).toBe('cancelled')
    expect((await peek('subscription', m.subscription)).status).toBe(
      'cancelled',
    )
    await giftOnce(m, pm, 'cancelled')
  })

  test('cancel on a shared mandate: only its subscription, and its payments', async ({
    browser,
  }) => {
    // A second subscription on one mandate is made in GoCardless's
    // dashboard; only the fake can do that here.
    skipUnlessFakeGoCardless(mode)
    const page = await signedIn(browser)
    const { view, contactId, contactUrl } = await setUp(page, '6', 12)
    const { mandate, subscription } = await active(view.id)
    const fake = async <T>(what: string): Promise<T> => {
      const res = await fetch(
        `${inst.api}/api/fake-gocardless/simulate/${what}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        },
      )
      expect(res.ok, what).toBe(true)
      return (await res.json()) as T
    }
    const other = (
      await fake<{ subscription: string }>(
        `mandates/${mandate}/subscription?amount=300`,
      )
    ).subscription
    await fake(`subscriptions/${other}/payment`)
    await until(
      'the dashboard’s subscription, unknown to the app',
      () =>
        app<Array<{ subscriptionId: string }>>(
          'GET',
          'gocardless/unknown-subscriptions',
        ),
      (list) => list.some((u) => u.subscriptionId === other),
    )
    const adopted = await app<{ view: RegularGiftView }>(
      'POST',
      `gocardless/unknown-subscriptions/${other}/adopt`,
      {
        sourceCodeId: view.sourceCodeId,
        clientKey: randomUUID().replaceAll('-', ''),
      },
    )
    made.push(adopted.view.id)
    const pm = (
      await fake<{ payment: string }>(`subscriptions/${subscription}/payment`)
    ).payment
    const m: Made = {
      id: view.id,
      contactId,
      contactUrl,
      mandate,
      subscription,
    }
    await giftOnce(m, pm, 'pending')
    await page.goto(contactUrl)
    await card(page, view.id)
      .getByRole('button', { name: 'Cancel Direct Debit' })
      .click()
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Cancel Direct Debit' })
      .click()
    await until(
      'the gift ended',
      () => regular(view.id),
      (v) => v.status === 'cancelled',
    )
    const sub = await until(
      'its subscription cancelled, nothing left to collect',
      () => peek('subscription', subscription),
      (s) =>
        s.status === 'cancelled' &&
        s.payments.every((p) => !COLLECTABLE.includes(p.status)),
    )
    expect(sub.payments.find((p) => p.id === pm)?.status).toBe('cancelled')
    expect((await peek('mandate', mandate)).status).toBe('active')
    expect((await regular(adopted.view.id)).status).toBe('active')
  })

  test('a webhook with a bad or no signature: 498', async () => {
    const body = JSON.stringify({ events: [] })
    for (const signature of ['0'.repeat(64), null]) {
      const res = await fetch(`${inst.api}/api/gocardless/webhook`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(signature !== null && { 'webhook-signature': signature }),
        },
        body,
      })
      expect(res.status, `signature ${signature ?? 'missing'}`).toBe(498)
    }
  })

  test('the catch-up finds nothing missed', async () => {
    const caught = await qc<QcCaughtUp>('POST', 'catchup', { slug })
    expect(caught.read).toBeGreaterThan(0)
    if (caught.missed > 0)
      noteLateWebhook(
        `the catch-up found ${caught.missed} event(s) no webhook brought`,
      )
  })

  // Last: in serial mode a failure skips what follows, and this one
  // asks an open question (q1) rather than checking a known path.
  test('the first charge date: GoCardless’s is the app’s', async ({
    browser,
  }) => {
    const page = await signedIn(browser)
    const soon = new Date()
    soon.setDate(soon.getDate() + 2)
    // Days run 1–28; past that, the 28th (already in the list).
    const days = [...new Set([1, 28, Math.min(soon.getDate(), 28)])]
    const differ: Array<string> = []
    for (const day of days) {
      const { view } = await setUp(page, '5', day)
      // What the app says before GoCardless has a subscription: its own.
      // (`upcoming` is on the one gift's read, not the contact's list.)
      const said = (await regular(view.id)).upcoming.at(0)?.chargeDate
      expect(said, `day ${day}: the app shows a first payment`).toBeTruthy()
      await sign(view.id)
      const signed = await until(
        `day ${day}: the subscription`,
        () => regular(view.id),
        (v) => v.subscriptionId !== null,
      )
      const sub = await peek('subscription', signed.subscriptionId!)
      const first = sub.upcomingPayments.at(0)?.chargeDate
      if (first !== said)
        differ.push(
          `day ${day}: GoCardless ${first ?? 'none'}, the app ${said}`,
        )
    }
    expect(differ, differ.join('; ')).toEqual([])
  })
})
