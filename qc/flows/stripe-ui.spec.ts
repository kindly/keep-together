import { randomBytes } from 'node:crypto'
import { expect, skipUnlessFakeStripe, test } from '../fixtures'
import type { Page } from '@playwright/test'
import type { ContactRow } from '../../src/lib/data/rust-types/ContactRow'
import type { DonationPage } from '../../src/lib/data/rust-types/DonationPage'
import type { GiftAidOnRecord } from '../../src/lib/data/rust-types/GiftAidOnRecord'
import type { GiftPage } from '../../src/lib/data/rust-types/GiftPage'
import type { GiftView } from '../../src/lib/data/rust-types/GiftView'
import type { Preferences } from '../../src/lib/data/rust-types/Preferences'
import type { SearchResult } from '../../src/lib/data/rust-types/SearchResult'
import type { SourcePicker } from '../../src/lib/data/rust-types/SourcePicker'
import type { StripeStatus } from '../../src/lib/data/rust-types/StripeStatus'
import type { UnmatchedCardPayment } from '../../src/lib/data/rust-types/UnmatchedCardPayment'
import { createContact, uniqueName, want } from './contact.helpers'
import { GIFT_ROUTE, today } from './gift.helpers'

// Stripe S5's staff screens on the fake (factory/plans/stripe.sv):
// Settings › Card donations (connecting through Stripe's hosted form and
// back, the donation page's link, amounts and source code), "Card
// payments to match" (an outside payment matched to a contact, another
// set aside with a reason and put back), a card gift from the donation
// page whose donor typed another first name ("Name checked"), and
// Settings › Gift Aid ("We claim Gift Aid": what it says is on record
// before it saves, what stays in view and what stops). Signed in
// as user A, an admin. Stripe's own moves go through the fake's pages and
// simulators, untimed. The Stripe tests need KEEP_STRIPE=fake and skip
// elsewhere; the Gift Aid switch needs no Stripe and runs everywhere.
//
// Gifts are never optimistic: every `until` here waits for what the
// server answered (a gift made, a row gone from the list it re-read).

const SETTINGS = { type: 'route', description: '/t/$slug/settings/stripe' }
const QUEUE = { type: 'route', description: '/t/$slug/stripe/unmatched' }
const GIFT_AID = { type: 'route', description: '/t/$slug/settings/giftaid' }
const CODE = 'Event-Gala-001'

async function json<T>(
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

const statusOf = (page: Page, slug: string) =>
  json<StripeStatus>(page, 'GET', `/api/t/${slug}/stripe`)

/**
 * The group taking card donations, set up through the API and the fake's
 * onboarding page when it isn't: connected, Stripe's form sent in
 * ("Complete"), and the donation page given a source code. Off the fake:
 * skipped before anything loads.
 */
async function takingDonations(
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
  const held = await json<DonationPage>(
    page,
    'GET',
    `/api/t/${slug}/stripe/page`,
  )
  if (!held.takingDonations) {
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
  return now
}

/** A payment taken some other way on the group's account, once queued. */
async function outsidePayment(
  page: Page,
  slug: string,
  account: string,
): Promise<string> {
  const out = await json<{ delivered: boolean; payment_intent: string }>(
    page,
    'POST',
    `/api/fake-stripe/simulate/accounts/${account}/payment`,
    { amount: 2000 },
  )
  expect(out.delivered).toBe(true)
  await expect
    .poll(
      async () =>
        (
          await json<Array<UnmatchedCardPayment>>(
            page,
            'GET',
            `/api/t/${slug}/stripe/unmatched`,
          )
        ).some((p) => p.paymentId === out.payment_intent),
      { timeout: 10_000 },
    )
    .toBe(true)
  return out.payment_intent
}

/** A donor gives £10 on the group's page and pays on Stripe's (the fake's). */
async function give(
  page: Page,
  slug: string,
  donor: { firstName: string; lastName: string; email: string },
) {
  const { url } = await json<{ url: string }>(
    page,
    'POST',
    `/api/give/${slug}/donations`,
    { id: randomBytes(16).toString('hex'), amount: 1000, ...donor },
  )
  await page.goto(url)
  await page.getByRole('button', { name: 'Pay' }).click()
  await page.waitForURL(new RegExp(`/give/${slug}/`))
}

/** The contact's card gift still marked with another first name, once made. */
async function flaggedGift(
  page: Page,
  slug: string,
  contactId: string,
): Promise<string> {
  let found: string | undefined
  await expect
    .poll(
      async () => {
        const { rows } = await json<GiftPage>(
          page,
          'GET',
          `/api/t/${slug}/contacts/${contactId}/gifts`,
        )
        for (const row of rows) {
          const gift = await json<GiftView>(
            page,
            'GET',
            `/api/t/${slug}/gifts/${row.id}`,
          )
          if (gift.card?.firstNameTyped) found = gift.id
        }
        return found !== undefined
      },
      { timeout: 10_000 },
    )
    .toBe(true)
  return found!
}

/** Pick the code under its search box: type it, take the first match. */
async function pickCode(page: Page, label: string) {
  await page.getByRole('combobox', { name: label }).fill(CODE)
  await page
    .getByRole('listbox', { name: `${label} matches` })
    .getByRole('option', { name: new RegExp(CODE) })
    .first()
    .click()
}

const queueRow = (page: Page, payment: string) =>
  page.locator(`[data-testid="card-queue"] [data-payment="${payment}"]`)

// ── in-page predicates (serialised: no closures, no imports) ──────────────

/** Settings › Card donations has the connection and the page's settings. */
function settingsShown() {
  return Boolean(
    document.querySelector('[data-testid="stripe-connected"]') &&
    document.querySelector('form[aria-label="Donation page"]'),
  )
}

/** The donation page's form says the server saved it. */
function pageSaved() {
  return Boolean(document.querySelector('[data-testid="page-saved"]'))
}

/** "Card payments to match" has loaded (or says it is empty). */
function queueShown() {
  return Boolean(
    document.querySelector('main h1')?.textContent ===
      'Card payments to match' &&
    (document.querySelector('[data-testid="card-queue"]') ??
      document.querySelector('[data-testid="card-queue-empty"]')),
  )
}

/** The match dialog says it matched. */
function matched() {
  return Boolean(
    document
      .querySelector('[role="dialog"] [role="status"]')
      ?.textContent.startsWith('Matched to'),
  )
}

/** The "Not a donation" dialog says the server set it aside. */
function setAside() {
  return Boolean(
    document.querySelector('[role="dialog"] [data-testid="set-aside-done"]'),
  )
}

/** The gift's card section stands and its first-name mark is gone. */
function nameMarkGone() {
  return Boolean(
    document.querySelector('[data-testid="gift-card"]') &&
    !document.querySelector('[data-testid="card-first-name"]'),
  )
}

/**
 * "We claim Gift Aid" reads window.__qcWant, and the header agrees: its
 * Gift Aid menu is there while the group claims, or holds a declaration
 * or a claim (`arg`).
 */
function giftAidIsWant(onRecord: boolean) {
  const on = (window as unknown as { __qcWant?: string }).__qcWant === 'on'
  const s = [...document.querySelectorAll('label')]
    .find((l) => l.textContent === 'We claim Gift Aid')
    ?.querySelector<HTMLInputElement>('input[role="switch"]')
  const menu = [
    ...document.querySelectorAll('nav[aria-label="Main"] button'),
  ].some((b) => b.textContent.startsWith('Gift Aid'))
  // With anything on record the menu stays whatever the switch says.
  return (
    s != null &&
    s.checked === on &&
    menu === (on || onRecord) &&
    !document.querySelector('[role="alertdialog"]')
  )
}

test.describe('Stripe screens (fake)', () => {
  test.describe.configure({ mode: 'serial' })

  test('Settings › Card donations: connecting through Stripe’s form, the page’s link, amounts and code', async ({
    page,
    flow,
    users,
  }) => {
    test.info().annotations.push(SETTINGS)
    const slug = users.a.slug
    const before = await statusOf(page, slug)
    skipUnlessFakeStripe(before.mode)

    // Connect through Stripe's form (the fake's) and back, in the UI.
    await page.goto(`/t/${slug}/settings/stripe`)
    await expect(page.getByTestId('stripe-mode')).toContainText(
      'stand-in for Stripe',
    )
    if (!before.chargesEnabled) {
      await expect(page.getByTestId('stripe-connected')).toHaveText(
        before.connected ? 'Stripe’s form isn’t finished' : 'Not connected',
      )
      await page
        .getByRole('button', {
          name: before.connected ? 'Continue at Stripe' : 'Connect Stripe',
        })
        .click()
      await page.getByRole('button', { name: 'Complete' }).click()
      // Stripe sends the browser to Settings, which passes it to its tab.
      await page.waitForURL(/\/settings\/stripe\?stripe=return$/)
      await expect(page.getByTestId('stripe-outcome')).toContainText(
        'Back from Stripe',
      )
    }
    // What Stripe decided arrives by webhook: the page reads it again.
    await expect(page.getByTestId('stripe-connected')).toHaveText(
      'Taking donations',
      { timeout: 15_000 },
    )
    const now = await statusOf(page, slug)
    expect(now.accountId).toMatch(/^acct_/)
    if (before.accountId) expect(now.accountId).toBe(before.accountId)

    const settingsNav = page.getByRole('navigation', {
      name: 'Settings sections',
    })
    await flow(page, 'stripe.settings', {
      before: async () => {
        await page.goto(`/t/${slug}/settings/members`)
        await expect(
          settingsNav.getByRole('link', { name: 'Card donations' }),
        ).toBeVisible()
      },
      action: () =>
        settingsNav.getByRole('link', { name: 'Card donations' }).click(),
      until: settingsShown,
      // The page's settings are read by this tab alone.
      server: true,
    })

    // No code yet: no link to share, and the page says what is missing.
    const form = page.getByRole('form', { name: 'Donation page' })
    const held = await json<DonationPage>(
      page,
      'GET',
      `/api/t/${slug}/stripe/page`,
    )
    if (held.sourceCodeId === null) {
      await expect(page.getByTestId('give-link-missing')).toContainText(
        'Choose the page’s source code',
      )
      await expect(page.getByTestId('give-link')).toHaveCount(0)
      await pickCode(page, 'Source code for gifts from the page')
    }
    // Under £1 is refused in the form, as the server would.
    await form.getByLabel('At least').fill('0.50')
    await expect(form.locator('[data-problem="minimum"]')).toHaveText(
      'The minimum is at least £1.00',
    )
    await expect(
      form.getByRole('button', { name: 'Save donation page' }),
    ).toBeDisabled()
    await form.getByLabel('At least').fill('2.00')

    // Each repeat saves another first button.
    let n = 0
    await flow(page, 'stripe.savePage', {
      before: async () => {
        await form.getByLabel('First').fill(`${10 + (++n % 5)}.00`)
        await expect(
          form.getByRole('button', { name: 'Save donation page' }),
        ).toBeEnabled()
      },
      action: () =>
        form.getByRole('button', { name: 'Save donation page' }).click(),
      until: pageSaved,
    })
    const saved = await json<DonationPage>(
      page,
      'GET',
      `/api/t/${slug}/stripe/page`,
    )
    expect(saved.amounts[0]).toBe(1000 + (n % 5) * 100)
    expect(saved.takingDonations).toBe(true)
    await expect(page.getByTestId('give-link')).toHaveText(
      new RegExp(`/give/${slug}$`),
    )
  })

  test('card payments to match: an outside payment matched to a contact, another set aside and put back', async ({
    page,
    flow,
    users,
  }) => {
    test.info().annotations.push(QUEUE)
    const slug = users.a.slug
    const status = await takingDonations(page, slug)
    const account = status.accountId!
    const lastName = uniqueName('card')
    await createContact(page, slug, lastName, 'Cara')

    await flow(page, 'stripe.unmatched', {
      before: async () => {
        await page.goto(`/t/${slug}/contacts`)
        await page
          .getByRole('button', { name: 'Donations', exact: true })
          .click()
        await expect(
          page.getByRole('menuitem', { name: 'Card payments to match' }),
        ).toBeVisible()
      },
      action: () =>
        page.getByRole('menuitem', { name: 'Card payments to match' }).click(),
      until: queueShown,
      server: true,
    })

    // Each repeat matches a new payment to the contact: its gift is made.
    await flow(page, 'stripe.match', {
      before: async () => {
        const payment = await outsidePayment(page, slug, account)
        await page.goto(`/t/${slug}/stripe/unmatched`)
        const row = queueRow(page, payment)
        await expect(row.getByTestId('card-reason')).toContainText(
          'without coming through the donation page',
        )
        await row.getByRole('button', { name: 'Match to contact' }).click()
        const dialog = page.getByRole('dialog')
        await dialog.getByRole('combobox', { name: 'Donor' }).fill(lastName)
        await dialog
          .getByRole('option', { name: new RegExp(lastName) })
          .first()
          .click()
        // Not from the page, so it has no code of its own.
        await pickCode(page, 'Source code')
        await expect(
          dialog.getByRole('button', { name: 'Match' }),
        ).toBeEnabled()
      },
      action: () =>
        page.getByRole('dialog').getByRole('button', { name: 'Match' }).click(),
      until: matched,
    })
    await page
      .getByRole('dialog')
      .getByRole('link', { name: 'Open the gift' })
      .click()
    await expect(page).toHaveURL(/\/gifts\//)
    await expect(page.getByTestId('gift-card')).toContainText(
      'matched to this donor by hand',
    )

    // Each repeat sets a new payment aside: it leaves the queue, no gift.
    let last = ''
    await flow(page, 'stripe.setAside', {
      before: async () => {
        last = await outsidePayment(page, slug, account)
        await page.goto(`/t/${slug}/stripe/unmatched`)
        await queueRow(page, last)
          .getByRole('button', { name: 'Not a donation' })
          .click()
        const dialog = page.getByRole('dialog')
        // A reason is needed.
        await expect(
          dialog.getByRole('button', { name: 'Set aside' }),
        ).toBeDisabled()
        await dialog.getByLabel('What it was for').fill('Stall hire')
      },
      action: () =>
        page
          .getByRole('dialog')
          .getByRole('button', { name: 'Set aside' })
          .click(),
      until: setAside,
    })
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Close' })
      .click()
    await expect(queueRow(page, last)).toHaveCount(0)
    const aside = page.locator(
      `[data-testid="cards-set-aside"] [data-payment="${last}"]`,
    )
    await expect(aside.getByTestId('set-aside-reason')).toContainText(
      'Stall hire',
    )
    // Never deleted: put back, it is in the queue again.
    await aside.getByRole('button', { name: 'Put back' }).click()
    await expect(queueRow(page, last)).toBeVisible()
    await expect(aside).toHaveCount(0)
  })

  test('a card gift from the donation page: another first name is marked, and "Name checked" clears it', async ({
    page,
    flow,
    users,
  }) => {
    test.info().annotations.push(GIFT_ROUTE)
    const slug = users.a.slug
    await takingDonations(page, slug)
    // A couple sharing an email address: John gives first (a new contact),
    // then Jane from the same address.
    const lastName = uniqueName('pair')
    const email = `${lastName}@qc.keep-together.invalid`
    await give(page, slug, { firstName: 'John', lastName, email })
    let contact: ContactRow | undefined
    await expect
      .poll(
        async () => {
          const q = new URLSearchParams({ q: lastName })
          const { rows } = await json<SearchResult>(
            page,
            'GET',
            `/api/t/${slug}/contacts/search?${q.toString()}`,
          )
          contact = rows.at(0)
          return rows.length
        },
        { timeout: 10_000 },
      )
      .toBe(1)

    // Each repeat is another gift from Jane.
    await flow(page, 'stripe.nameChecked', {
      before: async () => {
        await give(page, slug, { firstName: 'Jane', lastName, email })
        const giftId = await flaggedGift(page, slug, contact!.id)
        await page.goto(`/t/${slug}/gifts/${giftId}`)
        await expect(page.getByTestId('card-first-name')).toContainText(
          'the donor typed “Jane”',
        )
        await expect(
          page.getByRole('button', { name: /^Name checked/ }),
        ).toBeEnabled()
      },
      action: () => page.getByRole('button', { name: /^Name checked/ }).click(),
      until: nameMarkGone,
    })
    await expect(page.getByTestId('gift-card')).toContainText(
      'Given by card on the donation page',
    )
    await expect(page.getByText('Card (donation page)')).toBeVisible()
    // Still one contact: Jane's gifts went to John's record, marked.
    const q = new URLSearchParams({ q: lastName })
    const { rows } = await json<SearchResult>(
      page,
      'GET',
      `/api/t/${slug}/contacts/search?${q.toString()}`,
    )
    expect(rows).toHaveLength(1)
  })
})

test.describe('Settings › Gift Aid', { annotation: GIFT_AID }, () => {
  test('"We claim Gift Aid": switching off says what is on record, never hides it, and stops only the offering', async ({
    page,
    flow,
    users,
  }) => {
    const slug = users.a.slug
    const label = 'We claim Gift Aid'
    const header = page.getByRole('navigation', { name: 'Main' })
    const menu = header.getByRole('button', { name: 'Gift Aid', exact: true })
    const tabs = page.getByRole('navigation', { name: 'Settings sections' })
    const confirm = page.getByRole('alertdialog')
    try {
      await page.goto(`/t/${slug}/settings/giftaid`)
      const sw = page.getByRole('switch', { name: label })
      // The tenant is shared by the worker's tests: it starts, and is left, on.
      await expect(sw).toBeChecked()
      await expect(menu).toBeVisible()
      // What the group holds is said before anything is switched.
      const held = await json<GiftAidOnRecord>(
        page,
        'GET',
        `/api/t/${slug}/giftaid/on-record`,
      )
      const any = held.declarations + held.claims > 0
      await expect(page.getByTestId('gift-aid-on-record')).toContainText(
        any ? 'On record:' : 'Nothing is on record',
      )
      // The input is visually hidden; its label takes the (trusted) click.
      const toggle = page.getByText(label, { exact: true })
      // Off is asked about first; the timed gesture is the confirm (off)
      // or the click (on): each ends with the server's answer on screen.
      let asked = false
      await flow(page, 'settings.claimsGiftAid.toggle', {
        before: async () => {
          const on = await sw.isChecked()
          asked = on
          await want(page, on ? 'off' : 'on')
          if (on) {
            await toggle.click()
            await expect(confirm).toContainText(
              any
                ? 'They are kept and stay visible'
                : 'no declarations and no claims',
            )
          }
        },
        action: () =>
          asked
            ? confirm.getByRole('button', { name: 'Switch off' }).click()
            : toggle.click(),
        until: giftAidIsWant,
        arg: any,
      })
      if (await sw.isChecked()) {
        await toggle.click()
        await confirm.getByRole('button', { name: 'Switch off' }).click()
      }
      await expect(sw).not.toBeChecked()

      if (any) {
        // On record: the claims and the tabs stay, read-only; only the
        // offering goes (no new claim).
        await expect(menu).toBeVisible()
        await expect(
          tabs.getByRole('link', { name: 'HMRC details' }),
        ).toBeVisible()
        await page.goto(`/t/${slug}/giftaid`)
        await expect(page.getByTestId('gift-aid-off')).toBeVisible()
        await expect(page.getByRole('link', { name: 'New claim' })).toHaveCount(
          0,
        )
        await page.goto(`/t/${slug}/giftaid/new`)
        await expect(page.getByTestId('no-gift-aid')).toContainText(
          'no new claim can be made',
        )
      } else {
        // Nothing on record: Gift Aid leaves the app; a bookmark says why.
        await expect(menu).toHaveCount(0)
        await expect(
          tabs.getByRole('link', { name: 'HMRC details' }),
        ).toHaveCount(0)
        await page.goto(`/t/${slug}/giftaid`)
        await expect(page.getByTestId('no-gift-aid')).toBeVisible()
      }
      // Either way the tick is gone from recording a gift.
      await page.goto(`/t/${slug}/gifts/new`)
      await expect(
        page.getByRole('form', { name: 'Record a gift' }),
      ).toBeVisible()
      await expect(page.getByTestId('gift-aid')).toHaveCount(0)

      // On again: everything is back.
      await page.goto(`/t/${slug}/settings/giftaid`)
      await toggle.click()
      await expect(sw).toBeChecked()
      await expect(menu).toBeVisible()
      await expect(
        tabs.getByRole('link', { name: 'HMRC details' }),
      ).toBeVisible()
    } finally {
      // Whatever happened above, the worker's other tests get Gift Aid.
      const prefs = await json<Preferences>(
        page,
        'GET',
        `/api/t/${slug}/preferences`,
      )
      if (!prefs.claimsGiftAid.on)
        await json(page, 'POST', `/api/t/${slug}/preferences/claimsGiftAid`, {
          expected: prefs.claimsGiftAid.version,
          on: true,
        })
    }
  })
})
