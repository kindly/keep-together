import { expect, test } from '../fixtures'
import { tapContext } from '../timing'
import type { Browser, Page, Request } from '@playwright/test'
import type { Instance } from '../fixtures'
import type { GiftPage } from '../../src/lib/data/rust-types/GiftPage'
import type { GiftView } from '../../src/lib/data/rust-types/GiftView'
import type { Preferences } from '../../src/lib/data/rust-types/Preferences'
import type { UnmatchedCardPayment } from '../../src/lib/data/rust-types/UnmatchedCardPayment'
import { CONTACT_ROUTE, uniqueName } from './contact.helpers'
import { GIFT_ROUTE } from './gift.helpers'
import {
  contactOnce,
  contactsNamed,
  give,
  json,
  pressGive,
  takingDonations,
} from './stripe.helpers'

// The donor's page on the fake Stripe (factory/plans/stripe.sv, S4 and
// S6): `/give/<group>` in a browser that isn't signed in, from its first
// load through Stripe's payment page (the fake's Pay and Back) to the
// thank-you, and then what staff see: the gift, the donor's Gift Aid
// declaration and the contact, or the payment in "Card payments to match"
// when the donor can't be told from the email and last name.
//
// Timed: `give.open`, the page's first load. Pressing Give isn't: what
// follows is Stripe's (making its payment session, then its page).
//
// Never optimistic: the thank-you page proves nothing, so every check on
// the staff side polls the server for what the webhook made.
//
// The page allows a connection 20 donations and then one every 15 s, and
// a pool instance's workers are one connection: this spec makes four a
// worker, and a "too many tries" answer is waited out (stripe.helpers).

const QUEUE = { type: 'route', description: '/t/$slug/stripe/unmatched' }
const NO_SESSION = { cookies: [], origins: [] }
const HOME = { addressLine1: '12 Mill Lane', postcode: 'AB1 2CD' }

/** A donor's browser: not signed in, with the timing tap. */
async function donorBrowser(browser: Browser, inst: Instance): Promise<Page> {
  const context = await browser.newContext({
    baseURL: inst.baseURL,
    viewport: { width: 390, height: 844 },
    storageState: NO_SESSION,
  })
  await tapContext(context)
  return context.newPage()
}

const screen = (page: Page, name: string) =>
  page.locator(`#give [data-screen="${name}"]`)

/** The form filled in: "Other" amount, who, and Gift Aid if `home`. */
async function fill(
  donor: Page,
  who: { firstName: string; lastName: string; email: string },
  pounds: string,
  home?: typeof HOME,
) {
  await donor.locator('input[name="amount"][value="other"]').check()
  await donor.getByLabel('Other amount in pounds').fill(pounds)
  await donor.getByLabel('First name').fill(who.firstName)
  await donor.getByLabel('Last name').fill(who.lastName)
  await donor.getByLabel('Email').fill(who.email)
  if (home) {
    // The address is asked only once the box is ticked.
    await expect(donor.getByLabel('Postcode')).toBeHidden()
    await donor.locator('#give-giftaid').check()
    await donor.getByLabel('House name or number').fill(home.addressLine1)
    await donor.getByLabel('Postcode').fill(home.postcode)
  }
}

/** The group's name as its page gives it. */
const groupName = async (page: Page, slug: string) =>
  (await json<{ name: string }>(page, 'GET', `/api/give/${slug}`)).name

const onStripe = (donor: Page) => () =>
  donor.waitForURL(/\/api\/fake-stripe\/checkout\//)

/** The contact's gifts, once there are `count`. */
async function giftsOnce(
  page: Page,
  slug: string,
  contactId: string,
  count: number,
) {
  let rows: GiftPage['rows'] = []
  await expect
    .poll(
      async () => {
        rows = (
          await json<GiftPage>(
            page,
            'GET',
            `/api/t/${slug}/contacts/${contactId}/gifts`,
          )
        ).rows
        return rows.length
      },
      { timeout: 10_000 },
    )
    .toBe(count)
  return rows
}

test.describe('The donor’s page (fake)', () => {
  test.describe.configure({ mode: 'serial' })

  test('first load: the form, none of the app’s bundle; a group with no page says so', async ({
    page,
    browser,
    instance,
    flow,
    users,
  }) => {
    const slug = users.a.slug
    await takingDonations(page, slug)
    const name = await groupName(page, slug)
    const donor = await donorBrowser(browser, instance)
    const requests: Array<Request> = []
    donor.on('request', (r) => requests.push(r))

    await flow(donor, 'give.open', {
      // Each sample is the link opened afresh.
      before: async () => {
        await donor.goto('about:blank')
      },
      action: async () => {
        await donor.goto(`/give/${slug}`, { waitUntil: 'commit' })
      },
      start: 'navigation',
      until: () =>
        document.querySelector('#give [data-screen="form"] button.primary') !==
        null,
      server: true,
    })
    await expect(donor.getByRole('heading', { level: 1 })).toHaveText(
      `Give to ${name}`,
    )
    // The middle amount is chosen, and the button says it.
    await expect(donor.getByRole('button', { name: /^Give £/ })).toBeVisible()
    await expect(donor.getByText('Gift Aid', { exact: true })).toBeVisible()

    // Its own entry: the document, one script, one stylesheet (and
    // Vite's preload helper), never the app's.
    const loaded = requests
      .filter((r) =>
        ['script', 'stylesheet', 'document'].includes(r.resourceType()),
      )
      .map((r) => new URL(r.url()).pathname)
    expect(loaded.some((p) => /\/assets\/give-[^/]+\.js$/.test(p))).toBe(true)
    for (const p of new Set(loaded))
      expect(p, 'the donor’s page loads only its own files').toMatch(
        new RegExp(
          `^(/give/${slug}|/assets/(give|modulepreload-polyfill)-[^/]+\\.(js|css))$`,
        ),
      )
    // And nothing as a member: it asks the api only for the page.
    const api = requests
      .map((r) => new URL(r.url()).pathname)
      .filter((p) => p.startsWith('/api/'))
    expect(new Set(api)).toEqual(new Set([`/api/give/${slug}`]))

    // A group that hasn't opened its page, and a link nobody has: the
    // same words, so a link can't be used to find groups.
    for (const absent of [users.b.slug, 'qc-no-such-group']) {
      await donor.goto(`/give/${absent}`)
      await expect(screen(donor, 'absent')).toContainText(
        'This page isn’t taking donations',
      )
    }
    await donor.context().close()
  })

  test('a gift with Gift Aid: Back from Stripe’s page records nothing; paid, staff see the gift, the declaration and the contact', async ({
    page,
    browser,
    instance,
    users,
  }) => {
    test.info().annotations.push(GIFT_ROUTE, CONTACT_ROUTE)
    const slug = users.a.slug
    await takingDonations(page, slug)
    const name = await groupName(page, slug)
    const lastName = uniqueName('give')
    const who = {
      firstName: 'Dora',
      lastName,
      email: `${lastName}@qc.keep-together.invalid`,
    }
    const donor = await donorBrowser(browser, instance)
    await donor.goto(`/give/${slug}`)
    await fill(donor, who, '12.34', HOME)
    // The declaration names the amount and the group, as HMRC's model does.
    await expect(donor.locator('.giftaid .agreed')).toContainText('£12.34')
    await expect(donor.locator('.giftaid .agreed')).toContainText(name)
    await expect(
      donor.getByRole('button', { name: 'Give £12.34' }),
    ).toBeEnabled()

    // To Stripe's page and Back: the form again, and nothing recorded.
    await pressGive(donor, onStripe(donor))
    await expect(donor.locator('[data-fake-stripe="amount"]')).toHaveText(
      '£12.34',
    )
    await donor.getByRole('button', { name: 'Back' }).click()
    await donor.waitForURL(new RegExp(`/give/${slug}$`))
    await expect(screen(donor, 'form')).toBeVisible()
    expect(await contactsNamed(page, slug, lastName)).toHaveLength(0)

    // A second press works: a new attempt, paid this time.
    await fill(donor, who, '12.34', HOME)
    await pressGive(donor, onStripe(donor))
    await donor.getByRole('button', { name: 'Pay' }).click()
    await donor.waitForURL(new RegExp(`/give/${slug}/thanks$`))
    await expect(screen(donor, 'thanks')).toContainText(
      `Thank you for giving to ${name}`,
    )
    await donor.context().close()

    // What the webhook made: one new contact, their one gift, received.
    const contact = await contactOnce(page, slug, lastName)
    const [row] = await giftsOnce(page, slug, contact.id, 1)
    expect(row.amount).toBe(1234)
    expect(row.status).toBe('completed')
    expect(row.provider).toBe('stripe')
    expect(row.method).toBe('card')
    const gift = await json<GiftView>(
      page,
      'GET',
      `/api/t/${slug}/gifts/${row.id}`,
    )
    // Matched by the page itself: no flag for staff, nothing queued.
    expect(gift.card).not.toBeNull()
    expect(gift.card?.firstNameTyped ?? null).toBeNull()
    expect(gift.card?.declarationRefused ?? null).toBeNull()
    const queued = await json<Array<UnmatchedCardPayment>>(
      page,
      'GET',
      `/api/t/${slug}/stripe/unmatched`,
    )
    expect(queued.filter((p) => p.donor?.lastName === lastName)).toEqual([])

    // On the staff screens: the gift, and the donor's own declaration.
    await page.goto(`/t/${slug}/gifts/${row.id}`)
    await expect(page.getByTestId('gift-card')).toContainText(
      'Given by card on the donation page',
    )
    await expect(page.getByText('Card (donation page)')).toBeVisible()
    await page.goto(`/t/${slug}/contacts/${contact.id}`)
    const declaration = page.getByTestId('declaration')
    await expect(declaration).toHaveCount(1)
    await expect(declaration).toContainText('On screen by the donor')
    await expect(declaration).toContainText(HOME.postcode)
  })

  test('a known email under another last name: queued with why, matched to the contact suggested, the declaration recorded', async ({
    page,
    users,
  }) => {
    test.info().annotations.push(QUEUE, GIFT_ROUTE, CONTACT_ROUTE)
    const slug = users.a.slug
    await takingDonations(page, slug)
    const known = uniqueName('wed')
    const typed = uniqueName('nee')
    const email = `${known}@qc.keep-together.invalid`
    // Their first gift makes the contact.
    await give(page, slug, { firstName: 'Mina', lastName: known, email })
    const contact = await contactOnce(page, slug, known)
    await giftsOnce(page, slug, contact.id, 1)

    // The same address under another last name, Gift Aid ticked: paid,
    // and nobody's until staff say whose.
    await give(
      page,
      slug,
      { firstName: 'Mina', lastName: typed, email, giftAid: HOME },
      1500,
    )
    let payment: UnmatchedCardPayment | undefined
    await expect
      .poll(
        async () => {
          const queue = await json<Array<UnmatchedCardPayment>>(
            page,
            'GET',
            `/api/t/${slug}/stripe/unmatched`,
          )
          payment = queue.find((p) => p.donor?.lastName === typed)
          return payment?.reason
        },
        { timeout: 10_000 },
      )
      .toBe('name_differs')
    expect(await contactsNamed(page, slug, typed)).toHaveLength(0)
    expect(await giftsOnce(page, slug, contact.id, 1)).toHaveLength(1)

    await page.goto(`/t/${slug}/stripe/unmatched`)
    const row = page.locator(
      `[data-testid="card-queue"] [data-payment="${payment!.paymentId}"]`,
    )
    await expect(row).toHaveAttribute('data-reason', 'name_differs')
    await expect(row.getByTestId('card-reason')).toContainText(
      'under a different last name',
    )
    await expect(row.getByTestId('card-donor')).toContainText(
      `Mina ${typed} · ${email}`,
    )
    await expect(row.getByTestId('card-donor')).toContainText(
      `Ticked, from ${HOME.addressLine1}, ${HOME.postcode}`,
    )
    // From the page, so it is somebody's gift: it can't be set aside.
    await expect(
      row.getByRole('button', { name: 'Not a donation' }),
    ).toHaveCount(0)

    // The contact with that email is offered; the page's code is kept.
    await row.getByRole('button', { name: 'Match to contact' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.locator(`[data-candidate="${contact.id}"]`).click()
    await expect(dialog.getByTestId('match-donor')).toContainText(known)
    await expect(
      dialog.getByRole('combobox', { name: 'Source code' }),
    ).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Match' }).click()
    await expect(dialog.getByRole('status')).toContainText('Matched to')
    await expect(dialog.getByTestId('declaration-refused')).toHaveCount(0)
    await dialog.getByRole('link', { name: 'Open the gift' }).click()
    await expect(page).toHaveURL(/\/gifts\//)
    // It came through the page, and says so, whoever matched it.
    await expect(page.getByTestId('gift-card')).toContainText(
      'Given by card on the donation page',
    )

    // Their second gift, at Stripe's amount, and the declaration the
    // donor ticked, in the name they typed.
    const gifts = await giftsOnce(page, slug, contact.id, 2)
    expect(gifts.map((g) => g.amount).sort()).toEqual([1000, 1500])
    await page.goto(`/t/${slug}/contacts/${contact.id}`)
    const declaration = page.getByTestId('declaration')
    await expect(declaration).toHaveCount(1)
    await expect(declaration).toContainText('On screen by the donor')
    await page.goto(`/t/${slug}/stripe/unmatched`)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Card payments to match',
    )
    await expect(
      page.locator(`[data-payment="${payment!.paymentId}"]`),
    ).toHaveCount(0)
  })

  test('a group that doesn’t claim Gift Aid: the page offers none', async ({
    page,
    browser,
    instance,
    users,
  }) => {
    const slug = users.a.slug
    await takingDonations(page, slug)
    const set = async (on: boolean) => {
      const prefs = await json<Preferences>(
        page,
        'GET',
        `/api/t/${slug}/preferences`,
      )
      if (prefs.claimsGiftAid.on !== on)
        await json(page, 'POST', `/api/t/${slug}/preferences/claimsGiftAid`, {
          expected: prefs.claimsGiftAid.version,
          on,
        })
    }
    const donor = await donorBrowser(browser, instance)
    try {
      await set(false)
      await donor.goto(`/give/${slug}`)
      await expect(screen(donor, 'form')).toBeVisible()
      await expect(donor.locator('#give-giftaid')).toHaveCount(0)
      await expect(donor.getByText('Gift Aid')).toHaveCount(0)
      // The rest of the form is as it was.
      await expect(donor.getByLabel('Email')).toBeVisible()
    } finally {
      // The worker's other tests get Gift Aid, whatever happened above.
      await set(true)
      await donor.context().close()
    }
    const again = await donorBrowser(browser, instance)
    await again.goto(`/give/${slug}`)
    await expect(again.locator('#give-giftaid')).toBeVisible()
    await again.context().close()
  })
})
