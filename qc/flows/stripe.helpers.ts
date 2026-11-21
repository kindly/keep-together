import { randomBytes } from 'node:crypto'
import { expect, skipUnlessFakeStripe } from '../fixtures'
import type { Page } from '@playwright/test'
import type { ContactRow } from '../../src/lib/data/rust-types/ContactRow'
import type { DonationPage } from '../../src/lib/data/rust-types/DonationPage'
import type { SearchResult } from '../../src/lib/data/rust-types/SearchResult'
import type { SourcePicker } from '../../src/lib/data/rust-types/SourcePicker'
import type { StripeStatus } from '../../src/lib/data/rust-types/StripeStatus'
import { today } from './gift.helpers'

// What the Stripe specs share (stripe-ui, give, stripe-sandbox): the api
// as the signed-in page, the group taking card donations on the fake,
// and the donor's page. All untimed set-up.

/** The seeded source code the donation page gives under. */
export const CODE = 'Event-Gala-001'

export async function json<T>(
  page: Page,
  method: 'GET' | 'POST',
  path: string,
  data?: unknown,
): Promise<T> {
  const res =
    method === 'GET'
      ? await page.request.get(path)
      : await page.request.post(path, { data: data ?? {} })
  expect(res.ok(), `${method} ${path}: ${res.status()}`).toBe(true)
  return (await res.json()) as T
}

export const statusOf = (page: Page, slug: string) =>
  json<StripeStatus>(page, 'GET', `/api/t/${slug}/stripe`)

/** The donation page given the seeded source code, if it has none live. */
export async function publishPage(page: Page, slug: string) {
  const held = await json<DonationPage>(
    page,
    'GET',
    `/api/t/${slug}/stripe/page`,
  )
  if (held.takingDonations) return
  const q = new URLSearchParams({ today: today(), search: CODE })
  const { codes } = await json<SourcePicker>(
    page,
    'GET',
    `/api/t/${slug}/sources/picker?${q.toString()}`,
  )
  await json(page, 'POST', `/api/t/${slug}/stripe/page`, {
    expected: held.version,
    amounts: held.amounts,
    minimum: held.minimum,
    maximum: held.maximum,
    sourceCodeId: codes[0].versionId,
  })
}

/**
 * The group taking card donations, set up through the API and the fake's
 * onboarding page when it isn't: connected, Stripe's form sent in
 * ("Complete"), and the donation page given a source code. Off the fake:
 * skipped before anything loads.
 */
export async function takingDonations(
  page: Page,
  slug: string,
): Promise<StripeStatus> {
  let now = await statusOf(page, slug)
  skipUnlessFakeStripe(now.mode)
  if (!now.chargesEnabled) {
    const { url } = await json<{ url: string | null }>(
      page,
      'POST',
      `/api/t/${slug}/stripe/connect`,
    )
    if (url) {
      await page.goto(url)
      await page.getByRole('button', { name: 'Complete' }).click()
      await page.waitForURL(/\/settings\/stripe\?stripe=return$/)
    }
    await expect
      .poll(async () => (await statusOf(page, slug)).chargesEnabled, {
        timeout: 10_000,
      })
      .toBe(true)
    now = await statusOf(page, slug)
  }
  await publishPage(page, slug)
  return now
}

/**
 * The donor's page allows a connection 20 donations, then one every 15 s
 * (server/crates/api/src/routes/give.rs), and a pool instance's workers
 * are one connection. A refusal isn't the test's subject: wait it out.
 */
const LIMIT_WAIT_MS = 16_000
const LIMIT_TRIES = 6

export interface Donor {
  firstName: string
  lastName: string
  email: string
  /** Present: Gift Aid ticked, from this home address. */
  giftAid?: { addressLine1: string; postcode: string }
}

/**
 * A donation of `amount` pence started as the donor's page would (its
 * `POST /api/give/{slug}/donations`): Stripe's payment page's address.
 */
export async function startDonation(
  page: Page,
  slug: string,
  donor: Donor,
  amount = 1000,
): Promise<string> {
  const { giftAid, ...who } = donor
  const data = {
    amount,
    ...who,
    ...(giftAid && {
      giftAid: { wordingVersion: await wording(page, slug), ...giftAid },
    }),
  }
  for (let i = 0; ; i++) {
    const res = await page.request.post(`/api/give/${slug}/donations`, {
      // A new attempt each try: a refused one made nothing.
      data: { id: randomBytes(16).toString('hex'), ...data },
    })
    if (res.status() === 429 && i < LIMIT_TRIES) {
      await page.waitForTimeout(LIMIT_WAIT_MS)
      continue
    }
    expect(res.ok(), `POST donations: ${res.status()}`).toBe(true)
    return ((await res.json()) as { url: string }).url
  }
}

/** The Gift Aid wording the group's page shows now. */
async function wording(page: Page, slug: string): Promise<string> {
  const res = await page.request.get(`/api/give/${slug}`)
  expect(res.ok(), `GET give page: ${res.status()}`).toBe(true)
  const held = (await res.json()) as {
    giftAid: { wordingVersion: string } | null
  }
  expect(held.giftAid, 'the page offers Gift Aid').not.toBeNull()
  return held.giftAid!.wordingVersion
}

/** A donor gives on the group's page and pays on Stripe's (the fake's). */
export async function give(
  page: Page,
  slug: string,
  donor: Donor,
  amount = 1000,
) {
  await page.goto(await startDonation(page, slug, donor, amount))
  await page.getByRole('button', { name: 'Pay' }).click()
  await page.waitForURL(new RegExp(`/give/${slug}/thanks`))
}

/**
 * Press the donor's form's Give button until it leaves for Stripe's page
 * (`left` resolves): a "too many tries" answer is waited out and pressed
 * again; anything else the form says fails.
 */
export async function pressGive(donorPage: Page, left: () => Promise<unknown>) {
  const notice = donorPage.locator('form [role="alert"]')
  for (let i = 0; ; i++) {
    await donorPage.getByRole('button', { name: /^Give/ }).click()
    const outcome = await Promise.race([
      left().then(() => 'left' as const),
      notice.waitFor({ state: 'visible' }).then(() => 'said' as const),
    ])
    if (outcome === 'left') return
    const said = (await notice.textContent()) ?? ''
    expect(said, 'the donor’s form').toContain('Too many tries')
    expect(i, 'still limited after waiting').toBeLessThan(LIMIT_TRIES)
    await donorPage.waitForTimeout(LIMIT_WAIT_MS)
  }
}

/** The contacts the group's search finds for `lastName`. */
export async function contactsNamed(
  page: Page,
  slug: string,
  lastName: string,
): Promise<Array<ContactRow>> {
  const q = new URLSearchParams({ q: lastName })
  const { rows } = await json<SearchResult>(
    page,
    'GET',
    `/api/t/${slug}/contacts/search?${q.toString()}`,
  )
  return rows
}

/** The one contact named `lastName`, once a payment has made them. */
export async function contactOnce(
  page: Page,
  slug: string,
  lastName: string,
  timeout = 10_000,
): Promise<ContactRow> {
  let found: Array<ContactRow> = []
  await expect
    .poll(
      async () => {
        found = await contactsNamed(page, slug, lastName)
        return found.length
      },
      { timeout, message: `one contact named ${lastName}` },
    )
    .toBe(1)
  return found[0]
}
