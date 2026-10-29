import { expect, test } from '../fixtures'
import type { Page } from '@playwright/test'
import type { GoCardlessStatus } from '../../src/lib/data/rust-types/GoCardlessStatus'
import type { RegularGiftSaved } from '../../src/lib/data/rust-types/RegularGiftSaved'
import type { RegularGiftView } from '../../src/lib/data/rust-types/RegularGiftView'
import type { UnmatchedPayment } from '../../src/lib/data/rust-types/UnmatchedPayment'
import {
  CONTACT_ROUTE,
  createContact,
  section,
  uniqueName,
  want,
} from './contact.helpers'
import { contactIdOf, recorder } from './gift.helpers'

// GoCardless D3's screens on the fake (factory/plans/gocardless.sv):
// Settings › GoCardless and its consent round trip, "Set up Direct
// Debit" on a contact and the donor signing on GoCardless's page, the
// regular-gift card (status, next payments, payment history), a one-off
// on the mandate (the £1,000 cap in the form), an Instant Bank Pay link,
// cancelling, and the unmatched payments matched to a contact. Signed in
// as user A, an admin. GoCardless's own moves go through the fake's
// simulators, untimed. Needs KEEP_GOCARDLESS=fake; skipped elsewhere.
//
// Connecting: another spec connects this group too, so a connect here
// names the account it already has (the fake's consent page takes an
// existing account id) and never switches it under the other.

const SETTINGS = { type: 'route', description: '/t/$slug/settings/gocardless' }
const UNMATCHED = {
  type: 'route',
  description: '/t/$slug/gocardless/unmatched',
}

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
  json<GoCardlessStatus>(page, 'GET', `/api/t/${slug}/gocardless`)

const simulate = (page: Page, what: string) =>
  json<{ delivered: boolean; payment?: string }>(
    page,
    'POST',
    `/api/fake-gocardless/simulate/${what}`,
  ).then((out) => {
    expect(out.delivered, what).toBe(true)
    return out
  })

/** On the fake's consent page: the account already held, or a new one. */
async function consent(page: Page, account: string | null) {
  await page.getByLabel(/An existing account id/).fill(account ?? '')
  await page.getByRole('button', { name: 'Connect' }).click()
}

/** Connected, through the API and the consent page; the account kept. */
async function connected(page: Page, slug: string): Promise<GoCardlessStatus> {
  if (!page.url().startsWith('http')) await page.goto(`/t/${slug}/contacts`)
  const now = await statusOf(page, slug)
  test.skip(now.mode !== 'fake', 'needs KEEP_GOCARDLESS=fake')
  if (now.connected) return now
  const { url } = await json<{ url: string }>(
    page,
    'POST',
    `/api/t/${slug}/gocardless/connect`,
  )
  await page.goto(url)
  await consent(page, null)
  await page.waitForURL(/gocardless=connected/)
  return statusOf(page, slug)
}

/** The regular gift once `ready` holds (webhooks land in the background). */
async function settled(
  page: Page,
  slug: string,
  id: string,
  ready: (v: RegularGiftView) => boolean,
): Promise<RegularGiftView> {
  let last: RegularGiftView | undefined
  await expect
    .poll(
      async () => {
        last = await json<RegularGiftView>(
          page,
          'GET',
          `/api/t/${slug}/regular-gifts/${id}`,
        )
        return ready(last)
      },
      { timeout: 10_000 },
    )
    .toBe(true)
  return last!
}

/** Pick the code under its search box: type it, take the first match. */
async function pickCode(page: Page, code: string) {
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('combobox', { name: 'Source code' }).fill(code)
  await dialog
    .getByRole('listbox', { name: 'Source code matches' })
    .getByRole('option', { name: new RegExp(code) })
    .first()
    .click()
}

const card = (page: Page, id: string) =>
  page.locator(`[data-testid="regular-gift"][data-id="${id}"]`)

// ── in-page predicates (serialised: no closures, no imports) ──────────────

/** Settings › GoCardless has read the connection. */
function settingsShown() {
  return Boolean(document.querySelector('[data-testid="gocardless-connected"]'))
}

/** The open dialog shows a link (`arg`: its label) to copy. */
function dialogLinkShown(label: string) {
  const input = document.querySelector<HTMLInputElement>(
    `[role="dialog"] input[aria-label="${label}"]`,
  )
  return Boolean(input?.value.startsWith('http'))
}

/** The one-off dialog says GoCardless was asked. */
function oneOffAsked() {
  return Boolean(
    document
      .querySelector('[role="dialog"] [role="status"]')
      ?.textContent.startsWith('Asked GoCardless to collect'),
  )
}

/** window.__qcWant's card reads cancelled, the question gone. */
function wantCancelled() {
  const id = (window as unknown as { __qcWant?: string }).__qcWant
  return (
    !document.querySelector('[role="alertdialog"]') &&
    document.querySelector<HTMLElement>(
      `[data-testid="regular-gift"][data-id="${id}"]`,
    )?.dataset.status === 'cancelled'
  )
}

/** The unmatched list has loaded (or says it is empty). */
function unmatchedShown() {
  return Boolean(
    document.querySelector('main h1')?.textContent === 'Unmatched payments' &&
    (document.querySelector('[data-testid="unmatched-payments"]') ??
      document.querySelector('[data-testid="unmatched-empty"]')),
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

test.describe('GoCardless screens (fake)', () => {
  test.describe.configure({ mode: 'serial' })

  test('Settings › GoCardless: the connection, and connecting through GoCardless’s page', async ({
    page,
    flow,
    users,
  }) => {
    test.info().annotations.push(SETTINGS)
    const slug = users.a.slug
    const before = await connected(page, slug)
    const settingsNav = page.getByRole('navigation', {
      name: 'Settings sections',
    })
    await flow(page, 'gocardless.settings', {
      before: async () => {
        await page.goto(`/t/${slug}/settings/members`)
        await expect(
          settingsNav.getByRole('link', { name: 'GoCardless' }),
        ).toBeVisible()
      },
      action: () =>
        settingsNav.getByRole('link', { name: 'GoCardless' }).click(),
      // The header's menus hold the status already: a render, no read.
      until: settingsShown,
    })
    await expect(page.getByTestId('gocardless-mode')).toContainText(
      'stand-in for GoCardless',
    )
    await expect(page.getByTestId('gocardless-connected')).toHaveText(
      'Connected',
    )

    // Through the consent page and back: the same account, connected.
    await page
      .getByRole('button', { name: 'Connect a different account' })
      .click()
    await consent(page, before.organisationId)
    await page.waitForURL(/\/settings\/gocardless\?gocardless=connected$/)
    await expect(page.getByTestId('gocardless-outcome')).toHaveText(
      'Connected to GoCardless.',
    )
    expect((await statusOf(page, slug)).organisationId).toBe(
      before.organisationId,
    )
  })

  test('set up, the donor signs, the card; a one-off (at most £1,000); payment history', async ({
    page,
    flow,
    users,
  }) => {
    test.info().annotations.push(CONTACT_ROUTE)
    const slug = users.a.slug
    await connected(page, slug)
    const lastName = uniqueName('dd')
    const contactUrl = await createContact(page, slug, lastName, 'Dee')
    const contactId = contactIdOf(contactUrl)
    const dd = section(page, 'Direct Debit')

    await flow(page, 'gocardless.setUp', {
      before: async () => {
        await page.goto(contactUrl)
        await dd.getByRole('button', { name: 'Set up Direct Debit' }).click()
        const dialog = page.getByRole('dialog')
        await dialog.getByLabel('Amount (£)').fill('12.50')
        await pickCode(page, 'Event-Gala-001')
        await expect(
          dialog.getByRole('button', { name: 'Set up' }),
        ).toBeEnabled()
      },
      action: () =>
        page
          .getByRole('dialog')
          .getByRole('button', { name: 'Set up' })
          .click(),
      until: dialogLinkShown,
      arg: 'Sign-up link',
    })
    await expect(page.getByRole('dialog')).toContainText(
      'Ready: £12.50 every month on the 1st',
    )

    // The donor signs the newest on GoCardless's page; the bank activates it.
    const [made] = await json<Array<RegularGiftView>>(
      page,
      'GET',
      `/api/t/${slug}/contacts/${contactId}/regular-gifts`,
    )
    await page.goto(made.flowUrl!)
    await page.getByRole('button', { name: 'Set up Direct Debit' }).click()
    await expect(
      page.getByRole('heading', { name: 'Direct Debit set up' }),
    ).toBeVisible()
    const signed = await settled(
      page,
      slug,
      made.id,
      (v) => v.mandateId !== null && v.subscriptionId !== null,
    )
    await simulate(page, `mandates/${signed.mandateId}/activate`)
    await settled(page, slug, made.id, (v) => v.status === 'active')

    await page.goto(contactUrl)
    const active = card(page, made.id)
    await expect(active.getByTestId('regular-gift-status')).toHaveText('Active')
    await expect(active.getByTestId('regular-gift-mandate')).toHaveText(
      signed.mandateId!,
    )
    await expect(active.getByTestId('regular-gift-upcoming')).toContainText(
      '£12.50',
    )

    // Over £1,000: the form says bank transfer and holds the button.
    await active.getByRole('button', { name: 'Take a one-off payment' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Amount (£)').fill('1000.01')
    await expect(dialog).toContainText('bank transfer')
    await expect(
      dialog.getByRole('button', { name: 'Take payment' }),
    ).toBeDisabled()

    await flow(page, 'gocardless.oneOff', {
      before: async () => {
        await page.goto(contactUrl)
        await card(page, made.id)
          .getByRole('button', { name: 'Take a one-off payment' })
          .click()
        await page.getByRole('dialog').getByLabel('Amount (£)').fill('10')
        await expect(
          page
            .getByRole('dialog')
            .getByRole('button', { name: 'Take payment' }),
        ).toBeEnabled()
      },
      action: () =>
        page
          .getByRole('dialog')
          .getByRole('button', { name: 'Take payment' })
          .click(),
      until: oneOffAsked,
    })

    // A subscription payment, collected: listed, and money; a failed one
    // struck through.
    const paid = await simulate(
      page,
      `subscriptions/${signed.subscriptionId}/payment`,
    )
    await simulate(page, `payments/${paid.payment}/confirm`)
    const failed = await simulate(
      page,
      `subscriptions/${signed.subscriptionId}/payment`,
    )
    await simulate(page, `payments/${failed.payment}/fail`)
    await settled(page, slug, made.id, (v) =>
      v.payments.some(
        (p) => p.paymentId === failed.payment && p.status === 'failed',
      ),
    )
    await page.goto(contactUrl)
    await card(page, made.id)
      .getByText(/^Payment history/)
      .click()
    const history = card(page, made.id).getByTestId('payment-history')
    await expect(
      history.locator(`tr[data-payment="${paid.payment}"]`),
    ).toContainText('collected')
    await expect(
      history.locator(`tr[data-payment="${failed.payment}"]`),
    ).toContainText('failed')
  })

  test('an Instant Bank Pay link, and cancelling a Direct Debit', async ({
    page,
    flow,
    users,
    instance,
  }) => {
    test.info().annotations.push(CONTACT_ROUTE)
    const slug = users.a.slug
    await connected(page, slug)
    const r = await recorder(instance, users.a, slug)
    const contactUrl = await createContact(page, slug, uniqueName('ibp'))
    const contactId = contactIdOf(contactUrl)
    const dd = section(page, 'Direct Debit')

    await flow(page, 'gocardless.instantPayment', {
      before: async () => {
        await page.goto(contactUrl)
        await dd.getByRole('button', { name: 'Instant Bank Pay link' }).click()
        const dialog = page.getByRole('dialog')
        await dialog.getByLabel('Amount (£)').fill('25')
        await pickCode(page, 'Event-Gala-001')
        await expect(
          dialog.getByRole('button', { name: 'Make link' }),
        ).toBeEnabled()
      },
      action: () =>
        page
          .getByRole('dialog')
          .getByRole('button', { name: 'Make link' })
          .click(),
      until: dialogLinkShown,
      arg: 'Payment link',
    })

    // Each repeat cancels a new pending regular gift (its sign-up undone).
    await flow(page, 'gocardless.cancel', {
      before: async () => {
        const made = await json<RegularGiftSaved>(
          page,
          'POST',
          `/api/t/${slug}/contacts/${contactId}/regular-gifts`,
          {
            amount: 500,
            frequency: 'monthly',
            dayOfMonth: 15,
            sourceCodeId: r.codeId,
          },
        )
        await page.goto(contactUrl)
        await want(page, made.id)
        await card(page, made.id)
          .getByRole('button', { name: 'Cancel Direct Debit' })
          .click()
        await expect(page.getByRole('alertdialog')).toBeVisible()
      },
      action: () =>
        page
          .getByRole('alertdialog')
          .getByRole('button', { name: 'Cancel Direct Debit' })
          .click(),
      until: wantCancelled,
    })
  })

  test('unmatched payments from the Donations menu, matched to a contact', async ({
    page,
    flow,
    users,
  }) => {
    test.info().annotations.push(UNMATCHED)
    const slug = users.a.slug
    const status = await connected(page, slug)
    const lastName = uniqueName('unm')
    await createContact(page, slug, lastName)
    const nav = page.getByRole('navigation', { name: 'Main' })

    await flow(page, 'gocardless.unmatched', {
      before: async () => {
        await page.goto(`/t/${slug}/contacts`)
        await nav.getByRole('button', { name: 'Donations' }).click()
        await expect(
          page.getByRole('menuitem', { name: 'Unmatched payments' }),
        ).toBeVisible()
      },
      action: () =>
        page.getByRole('menuitem', { name: 'Unmatched payments' }).click(),
      until: unmatchedShown,
      server: true,
    })

    // Each repeat matches a new stranger's payment.
    await flow(page, 'gocardless.match', {
      before: async () => {
        const { payment } = await simulate(
          page,
          `organisations/${status.organisationId}/payment?amount=2000`,
        )
        await expect
          .poll(
            async () =>
              (
                await json<Array<UnmatchedPayment>>(
                  page,
                  'GET',
                  `/api/t/${slug}/gocardless/unmatched`,
                )
              ).some((p) => p.paymentId === payment),
            { timeout: 10_000 },
          )
          .toBe(true)
        await page.goto(`/t/${slug}/gocardless/unmatched`)
        await page
          .locator(`tr[data-payment="${payment}"]`)
          .getByRole('button', { name: 'Match to contact' })
          .click()
        const dialog = page.getByRole('dialog')
        await dialog.getByRole('combobox', { name: 'Donor' }).fill(lastName)
        await dialog
          .getByRole('option', { name: new RegExp(lastName) })
          .first()
          .click()
        await pickCode(page, 'Event-Gala-001')
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
  })
})
