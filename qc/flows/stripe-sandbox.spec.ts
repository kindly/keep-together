import type { Browser, Page } from '@playwright/test'
import {
  expect,
  qcStripeConnect,
  seedWorld,
  sessionCookie,
  sessionToken,
  skipNoQcStripe,
  skipStripeUnreachable,
  test,
} from '../fixtures'
import type { Instance } from '../fixtures'
import type { ContactRow } from '../../src/lib/data/rust-types/ContactRow'
import type { Declarations } from '../../src/lib/data/rust-types/Declarations'
import type { DonationPage } from '../../src/lib/data/rust-types/DonationPage'
import type { GiftPage } from '../../src/lib/data/rust-types/GiftPage'
import type { GiftRow } from '../../src/lib/data/rust-types/GiftRow'
import type { GiftView } from '../../src/lib/data/rust-types/GiftView'
import type { SearchResult } from '../../src/lib/data/rust-types/SearchResult'
import type { SourcePicker } from '../../src/lib/data/rust-types/SourcePicker'
import type { StripeStatus } from '../../src/lib/data/rust-types/StripeStatus'
import { uniqueName } from './contact.helpers'
import { today } from './gift.helpers'
import { CODE, pressGive } from './stripe.helpers'

// Card donations against Stripe itself (plan stripe.sv, S6): on keep-qc
// its Stripe sandbox, locally the fake. A donor gives on the group's own
// page, pays on Stripe's hosted payment page, and the money is checked
// where the app keeps it, once Stripe's webhook has brought it: so each
// pass proves the platform's key, the connected account, the webhook
// endpoint's signature and its routing by account. Untimed: no flow, no
// budget.
//
// Serial, in one worker, in a world of its own: its group is given the
// QC run's connected account (`qcStripeConnect`; the run can't fill in
// Stripe's onboarding form for a new one), which no other group may hold.
//
// A target with Stripe off, or with no QC account, skips every test with
// the STRIPE SANDBOX NOT RUN banner (keep-qc until the human sets it up:
// docs/ops.md "Stripe"). Stripe not answering skips with STRIPE
// UNREACHABLE.
//
// Stripe's own payment page (`realCheckout`) was written from Stripe's
// documented test cards and its page's field ids, with no sandbox to run
// it against: the first run on keep-qc is its test.

/** Stripe's webhook, after the donor is back: how long it may take. */
const WAIT_MS = 120_000
const BACKOFF = [500, 1_000, 2_000, 5_000]
const HOME = { addressLine1: '12 Mill Lane', postcode: 'AB1 2CD' }

/** Stripe's test cards (docs.stripe.com/testing). */
const CARD_PAYS = '4242 4242 4242 4242'
/** Pays, then the cardholder disputes it as fraudulent. */
const CARD_DISPUTED = '4000 0000 0000 0259'

test.describe.configure({ mode: 'serial', timeout: 300_000 })

let inst: Instance
let slug = ''
let token = ''
let mode: StripeStatus['mode'] = 'off'
/** Why the run can't use Stripe: nothing to run against, or no answer. */
let off: string | null = null
let unreachable: string | null = null
/** The last name typed by the donor who went back without paying. */
let abandoned: string | null = null

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

/** `read` until `ready`, backing off; never a fixed sleep. */
async function until<T>(
  what: string,
  read: () => Promise<T>,
  ready: (t: T) => boolean,
): Promise<T> {
  let last: T | undefined
  await expect
    .poll(
      async () => {
        last = await read()
        return ready(last)
      },
      {
        intervals: BACKOFF,
        timeout: WAIT_MS,
        message: `${what} (from Stripe's webhook; GET stripe's failedEvents says if any were refused)`,
      },
    )
    .toBe(true)
  return last!
}

const named = async (lastName: string) =>
  (
    await app<SearchResult>(
      'GET',
      `contacts/search?${new URLSearchParams({ q: lastName }).toString()}`,
    )
  ).rows

/** The donor's one gift once it has `status`, and whose it is. */
async function giftOnce(
  lastName: string,
  status: GiftRow['status'],
): Promise<{ contact: ContactRow; gift: GiftRow }> {
  const found = await until(
    `the gift from ${lastName} ${status}`,
    async () => {
      const contact = (await named(lastName)).at(0)
      if (!contact) return null
      const { rows } = await app<GiftPage>(
        'GET',
        `contacts/${contact.id}/gifts`,
      )
      return rows.length ? { contact, gift: rows[0] } : null
    },
    (f) => f?.gift.status === status,
  )
  return found!
}

// ── the donor ───────────────────────────────────────────────────────────

/** A donor's browser: not signed in. */
async function donorBrowser(browser: Browser): Promise<Page> {
  const context = await browser.newContext({
    baseURL: inst.baseURL,
    viewport: { width: 1280, height: 900 },
    storageState: { cookies: [], origins: [] },
  })
  return context.newPage()
}

interface Who {
  firstName: string
  lastName: string
  email: string
}

function someone(tag: string): Who {
  const lastName = uniqueName(tag)
  return {
    firstName: 'Dee',
    lastName,
    email: `${lastName}@qc.keep-together.invalid`,
  }
}

/**
 * The group's page filled in and Give pressed: the donor is on Stripe's
 * payment page (the fake's, locally). Stripe not answering the app skips
 * the rest.
 */
async function toStripe(
  donor: Page,
  who: Who,
  pounds: string,
  giftAid: boolean,
) {
  await donor.goto(`/give/${slug}`)
  await donor.locator('input[name="amount"][value="other"]').check()
  await donor.getByLabel('Other amount in pounds').fill(pounds)
  await donor.getByLabel('First name').fill(who.firstName)
  await donor.getByLabel('Last name').fill(who.lastName)
  await donor.getByLabel('Email').fill(who.email)
  if (giftAid) {
    await donor.locator('#give-giftaid').check()
    await donor.getByLabel('House name or number').fill(HOME.addressLine1)
    await donor.getByLabel('Postcode').fill(HOME.postcode)
  }
  const notice = donor.locator('form [role="alert"]')
  try {
    await pressGive(donor, () =>
      donor.waitForURL(
        mode === 'fake'
          ? /\/api\/fake-stripe\/checkout\//
          : /^https:\/\/checkout\.stripe\.com\//,
        { timeout: 60_000 },
      ),
    )
  } catch (err) {
    const said = await notice.textContent().catch(() => null)
    if (said?.includes('card payment service isn’t answering')) {
      unreachable = `Give: ${said}`
      skipStripeUnreachable(unreachable)
    }
    throw err
  }
}

/**
 * Stripe's hosted payment page, paid with `card`. Its fields are
 * Stripe's own (the email is the one the app passed and can't be
 * changed). The runner may be anywhere, so the country is set: a UK card
 * holder is asked a postcode.
 */
async function realCheckout(donor: Page, who: Who, card: string) {
  const number = donor.locator('#cardNumber')
  await number.waitFor({ state: 'visible', timeout: 60_000 })
  await number.fill(card)
  await donor.locator('#cardExpiry').fill('12 / 34')
  await donor.locator('#cardCvc').fill('123')
  await donor.locator('#billingName').fill(`${who.firstName} ${who.lastName}`)
  const country = donor.locator('#billingCountry')
  if (await country.isVisible()) await country.selectOption('GB')
  const postcode = donor.locator('#billingPostalCode')
  if (await postcode.isVisible()) await postcode.fill(HOME.postcode)
  await donor.getByTestId('hosted-payment-submit-button').click()
}

/** Pay on Stripe's page with `card`, and come back to the thank-you. */
async function pay(donor: Page, who: Who, card = CARD_PAYS) {
  if (mode === 'fake') await donor.getByRole('button', { name: 'Pay' }).click()
  else await realCheckout(donor, who, card)
  await donor.waitForURL(new RegExp(`/give/${slug}/thanks$`), {
    timeout: 120_000,
  })
  await expect(donor.locator('#give [data-screen="thanks"]')).toContainText(
    'Thank you',
  )
}

// ── the run ─────────────────────────────────────────────────────────────

test.describe('Stripe sandbox', () => {
  test.beforeAll(async ({ instance }, workerInfo) => {
    inst = instance
    const world = await seedWorld(instance, 600 + workerInfo.parallelIndex)
    slug = world.tenants[0].slug
    token = await sessionToken(instance, world.users[0].email)
    mode = (await app<StripeStatus>('GET', 'stripe')).mode
    if (mode === 'off') {
      off = `KEEP_STRIPE=off on ${instance.name}`
      return
    }
    let connected: Awaited<ReturnType<typeof qcStripeConnect>>
    try {
      connected = await qcStripeConnect(instance, slug)
    } catch (err) {
      unreachable = `connect: no answer (${err instanceof Error ? err.name : String(err)})`
      return
    }
    if (connected.status === 404) {
      off = `KEEP_STRIPE=${mode} on ${instance.name} with no QC account (KEEP_QC_STRIPE_ACCOUNT)`
      return
    }
    if (connected.status === 503) {
      unreachable = `connect: 503 ${connected.text}`
      return
    }
    // Anything else is a fault to mend, not a skip: an account Stripe
    // doesn't know as ours (422), or one a real group holds (409).
    if (!connected.data)
      throw new Error(`connect: ${connected.status} ${connected.text}`)
    if (!connected.data.chargesEnabled)
      throw new Error(
        `the QC Stripe account ${connected.data.accountId} doesn't take card payments: finish its onboarding in the sandbox (docs/ops.md "Stripe")`,
      )
    // The page opens once it has a source code.
    const held = await app<DonationPage>('GET', 'stripe/page')
    if (!held.takingDonations) {
      const q = new URLSearchParams({ today: today(), search: CODE })
      const { codes } = await app<SourcePicker>(
        'GET',
        `sources/picker?${q.toString()}`,
      )
      await app('POST', 'stripe/page', {
        expected: held.version,
        amounts: held.amounts,
        minimum: held.minimum,
        maximum: held.maximum,
        sourceCodeId: codes[0].versionId,
      })
    }
  })

  test.beforeEach(() => {
    if (off) skipNoQcStripe(off)
    if (unreachable) skipStripeUnreachable(unreachable)
  })

  test('the group takes card donations on the QC account', async () => {
    const status = await app<StripeStatus>('GET', 'stripe')
    expect(status.connected).toBe(true)
    expect(status.chargesEnabled).toBe(true)
    expect(status.accountId).toMatch(/^acct_/)
    expect(
      (await app<DonationPage>('GET', 'stripe/page')).takingDonations,
    ).toBe(true)
  })

  test('a gift with Gift Aid, paid on Stripe’s page: the signed webhook makes the gift, the contact and the donor’s declaration', async ({
    browser,
  }) => {
    const who = someone('sbx')
    const donor = await donorBrowser(browser)
    await toStripe(donor, who, '7.50', true)
    // Giving wrote nothing: only a paid session makes a gift.
    expect(await named(who.lastName)).toHaveLength(0)
    await pay(donor, who)
    await donor.context().close()

    const { contact, gift } = await giftOnce(who.lastName, 'completed')
    expect(gift.amount).toBe(750)
    expect(gift.provider).toBe('stripe')
    expect(gift.method).toBe('card')
    expect(gift.providerPaymentId).toMatch(/^pi_/)
    expect(gift.receivedOn).toBe(new Date().toISOString().slice(0, 10))
    const view = await app<GiftView>('GET', `gifts/${gift.id}`)
    expect(view.card?.declarationRefused ?? null).toBeNull()
    // The declaration the donor ticked: theirs, made today, on screen.
    const { declarations } = await until(
      'the donor’s declaration',
      () =>
        app<Declarations>(
          'GET',
          `contacts/${contact.id}/giftaid?today=${today()}`,
        ),
      (d) => d.declarations.length === 1,
    )
    expect(declarations[0].method).toBe('onScreenByDonor')
    // Nothing of this group's was refused or parked on the way.
    expect((await app<StripeStatus>('GET', 'stripe')).failedEvents).toBe(0)
  })

  test('back from Stripe’s page without paying: nothing is recorded', async ({
    browser,
  }) => {
    const who = someone('sbxback')
    const donor = await donorBrowser(browser)
    await toStripe(donor, who, '3', false)
    if (mode === 'fake')
      await donor.getByRole('button', { name: 'Back' }).click()
    else await donor.goBack()
    await donor.waitForURL(new RegExp(`/give/${slug}$`))
    await donor.context().close()
    // And still nothing after the next test's payment has come through.
    expect(await named(who.lastName)).toHaveLength(0)
    abandoned = who.lastName
  })

  test('a payment the cardholder disputes: its gift is received, then charged back', async ({
    browser,
    request,
  }) => {
    const who = someone('sbxdispute')
    const donor = await donorBrowser(browser)
    await toStripe(donor, who, '4', false)
    await pay(donor, who, CARD_DISPUTED)
    await donor.context().close()
    if (mode === 'fake') {
      // The fake's card never disputes by itself: its simulator does.
      const { gift } = await giftOnce(who.lastName, 'completed')
      const res = await request.post(
        `${inst.api}/api/fake-stripe/simulate/payments/${gift.providerPaymentId}/dispute`,
        { data: {} },
      )
      expect(res.ok(), `the fake's dispute: ${res.status()}`).toBe(true)
    }
    const { gift } = await giftOnce(who.lastName, 'charged_back')
    expect(gift.amount).toBe(400)
    expect(gift.provider).toBe('stripe')

    // The donor who went back never became a contact.
    if (abandoned) expect(await named(abandoned)).toHaveLength(0)
  })

  test('a webhook with a bad or no signature is refused', async () => {
    const body = JSON.stringify({
      id: 'evt_qc_unsigned',
      object: 'event',
      type: 'account.updated',
      account: 'acct_qc_unsigned',
      created: Math.floor(Date.now() / 1000),
      data: { object: {} },
    })
    const now = Math.floor(Date.now() / 1000)
    for (const signature of [`t=${now},v1=${'0'.repeat(64)}`, null]) {
      const res = await fetch(`${inst.api}/api/stripe/webhook`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(signature !== null && { 'stripe-signature': signature }),
        },
        body,
      })
      expect(res.status, `signature ${signature ?? 'missing'}`).toBe(400)
    }
  })
})
