import { expect, test } from '../fixtures'
import type { Page } from '@playwright/test'
import type { GoCardlessStatus } from '../../src/lib/data/rust-types/GoCardlessStatus'
import type { RegularGiftSaved } from '../../src/lib/data/rust-types/RegularGiftSaved'
import type { RegularGiftView } from '../../src/lib/data/rust-types/RegularGiftView'
import type { UnknownSubscription } from '../../src/lib/data/rust-types/UnknownSubscription'
import {
  CONTACT_ROUTE,
  createContact,
  uniqueName,
  want,
} from './contact.helpers'
import { contactIdOf, recorder } from './gift.helpers'

// Regular-gift terms step 6 on the fake GoCardless (ADR 0026): on a
// regular gift's card, "Change amount or schedule" (the code that won
// it, the payment it starts on, the split the server stores), the
// scheduled change withdrawn, a change's code changed in the terms
// history; the expected vs actual report from the Donations menu; a
// subscription made in GoCardless's dashboard adopted from the unmatched
// page. Signed in as user A, an admin. The regular gift is set up and
// signed through the api and the fake's pages, untimed. Needs
// KEEP_GOCARDLESS=fake; skipped elsewhere. Connecting keeps the account
// the group holds (gocardless-ui.spec.ts says why).

const REPORT = { type: 'route', description: '/t/$slug/reports/expected' }
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

const simulate = (page: Page, what: string) =>
  json<{ delivered?: boolean; payment?: string; subscription?: string }>(
    page,
    'POST',
    `/api/fake-gocardless/simulate/${what}`,
  )

async function connected(page: Page, slug: string): Promise<GoCardlessStatus> {
  if (!page.url().startsWith('http')) await page.goto(`/t/${slug}/contacts`)
  const now = await json<GoCardlessStatus>(
    page,
    'GET',
    `/api/t/${slug}/gocardless`,
  )
  test.skip(now.mode !== 'fake', 'needs KEEP_GOCARDLESS=fake')
  if (now.connected) return now
  const { url } = await json<{ url: string }>(
    page,
    'POST',
    `/api/t/${slug}/gocardless/connect`,
  )
  await page.goto(url)
  await page.getByRole('button', { name: 'Connect' }).click()
  await page.waitForURL(/gocardless=connected/)
  return json<GoCardlessStatus>(page, 'GET', `/api/t/${slug}/gocardless`)
}

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

/** A new contact with an active £10-a-month regular gift under `codeId`. */
async function activeGift(page: Page, slug: string, codeId: string) {
  const contactUrl = await createContact(page, slug, uniqueName('terms'))
  const contactId = contactIdOf(contactUrl)
  const made = await json<RegularGiftSaved>(
    page,
    'POST',
    `/api/t/${slug}/contacts/${contactId}/regular-gifts`,
    { amount: 1000, frequency: 'monthly', dayOfMonth: 1, sourceCodeId: codeId },
  )
  await page.goto(made.view.flowUrl!)
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
  const active = await settled(
    page,
    slug,
    made.id,
    (v) => v.status === 'active',
  )
  return { contactUrl, contactId, gift: active }
}

/** Withdraw every change still scheduled, through the api. */
async function withdrawScheduled(page: Page, slug: string, id: string) {
  const v = await json<RegularGiftView>(
    page,
    'GET',
    `/api/t/${slug}/regular-gifts/${id}`,
  )
  for (const row of v.terms.filter((t) => t.status === 'scheduled'))
    await json(
      page,
      'POST',
      `/api/t/${slug}/regular-gifts/${id}/terms/${row.id}/withdraw`,
      { expected: row.termsVersion },
    )
}

/** Pick the code under the dialog's search box labelled `label`. */
async function pickCode(page: Page, code: string, label = 'Source code') {
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('combobox', { name: label }).fill(code)
  await dialog
    .getByRole('listbox', { name: `${label} matches` })
    .getByRole('option', { name: new RegExp(code) })
    .first()
    .click()
}

// ── in-page predicates (serialised: no closures, no imports) ──────────────

/** The dialog has closed and the scheduled change shows. */
function changeScheduled() {
  return Boolean(
    !document.querySelector('[role="dialog"]') &&
    document.querySelector('[data-testid="scheduled-change"]'),
  )
}

/** The question has closed and no change is scheduled. */
function changeWithdrawn() {
  return (
    !document.querySelector('[role="alertdialog"]') &&
    !document.querySelector('[data-testid="scheduled-change"]')
  )
}

/** The terms history's scheduled row is credited to window.__qcWant. */
function codeIsWant() {
  const w = (window as unknown as { __qcWant?: string }).__qcWant
  const row = document.querySelector(
    '[data-testid="terms-history"] tr[data-status="scheduled"]',
  )
  return (
    !document.querySelector('[role="dialog"]') &&
    Boolean(row?.querySelectorAll('td')[3]?.textContent.startsWith(w ?? '-'))
  )
}

/** The report has loaded its lines (or says there are none). */
function reportShown() {
  return Boolean(
    document.querySelector('main h1')?.textContent === 'Expected vs actual' &&
    (document.querySelector('[data-testid="expected-lines"]') ??
      document.querySelector('[data-testid="expected-empty"]')),
  )
}

/** The adopt dialog says it adopted. */
function adopted() {
  return Boolean(
    document
      .querySelector('[role="dialog"] [role="status"]')
      ?.textContent.startsWith('Adopted'),
  )
}

test.describe('regular-gift terms (fake)', () => {
  test.describe.configure({ mode: 'serial' })

  test('change amount or schedule, withdraw it, code it', async ({
    page,
    flow,
    users,
    instance,
  }) => {
    test.info().annotations.push(CONTACT_ROUTE)
    const slug = users.a.slug
    await connected(page, slug)
    const r = await recorder(instance, users.a, slug)
    const { contactUrl, gift } = await activeGift(page, slug, r.codeId)
    const card = page.locator(
      `[data-testid="regular-gift"][data-id="${gift.id}"]`,
    )
    await page.goto(contactUrl)
    await expect(card.getByTestId('regular-gift-status')).toHaveText('Active')

    // £10 → £12 from the first payment GoCardless can still change: an
    // upgrade, £2 a month to the code that won it.
    await flow(page, 'terms.change', {
      before: async () => {
        await withdrawScheduled(page, slug, gift.id)
        await page.goto(contactUrl)
        await card
          .getByRole('button', { name: 'Change amount or schedule' })
          .click()
        const dialog = page.getByRole('dialog')
        await dialog.getByLabel('New amount (£)').fill('12')
        const starts = dialog.getByLabel('Starts with the payment on')
        await starts.selectOption({ index: 1 })
        await pickCode(page, 'Event-Gala-002', 'Code that won it')
        await expect(dialog.getByTestId('change-kind')).toHaveText('Upgrade')
        await expect(dialog.getByTestId('change-annual')).toContainText(
          '+£24.00 a year',
        )
        await expect(dialog.getByTestId('change-split')).toContainText(
          'Event-Gala-002 £2.00',
        )
      },
      action: () =>
        page
          .getByRole('dialog')
          .getByRole('button', { name: 'Schedule change' })
          .click(),
      until: changeScheduled,
      server: true,
    })
    await expect(card.getByTestId('scheduled-change')).toContainText(
      'Upgrade from',
    )

    // Its code changed in the history, each repeat to the other Gala code.
    await flow(page, 'terms.code', {
      before: async () => {
        const v = await json<RegularGiftView>(
          page,
          'GET',
          `/api/t/${slug}/regular-gifts/${gift.id}`,
        )
        const next = v.scheduled?.changeCode?.endsWith('-002')
          ? 'Event-Gala-001'
          : 'Event-Gala-002'
        await page.goto(contactUrl)
        await want(page, next)
        await card.getByText(/^Terms history/).click()
        await card
          .getByTestId('terms-history')
          .getByRole('button', { name: /code$/ })
          .click()
        await pickCode(page, next, 'Code that won it')
      },
      action: () =>
        page
          .getByRole('dialog')
          .getByRole('button', { name: 'Save code' })
          .click(),
      until: codeIsWant,
      server: true,
    })

    // Withdrawn after asking; each repeat schedules one first.
    await flow(page, 'terms.withdraw', {
      before: async () => {
        const v = await json<RegularGiftView>(
          page,
          'GET',
          `/api/t/${slug}/regular-gifts/${gift.id}`,
        )
        if (!v.scheduled) {
          const at = v.upcoming.find((u) => u.changeable)!.chargeDate
          await json(
            page,
            'POST',
            `/api/t/${slug}/regular-gifts/${gift.id}/terms`,
            {
              effectiveFrom: at,
              amount: 800,
            },
          )
        }
        await page.goto(contactUrl)
        await card.getByRole('button', { name: 'Withdraw change' }).click()
        await expect(page.getByRole('alertdialog')).toBeVisible()
      },
      action: () =>
        page
          .getByRole('alertdialog')
          .getByRole('button', { name: 'Withdraw change' })
          .click(),
      until: changeWithdrawn,
      server: true,
    })
    await card.getByText(/^Terms history/).click()
    await expect(
      card
        .getByTestId('terms-history')
        .locator('tr[data-status="withdrawn"]')
        .first(),
    ).toBeVisible()

    // The last 12 periods, read when opened.
    await card.getByText(/^Expected vs actual/).click()
    await expect(
      card
        .getByTestId('expected-periods')
        .or(card.getByText('Nothing expected yet.')),
    ).toBeVisible()
  })

  test('the expected vs actual report from the Donations menu', async ({
    page,
    flow,
    users,
  }) => {
    test.info().annotations.push(REPORT)
    const slug = users.a.slug
    await connected(page, slug)
    const nav = page.getByRole('navigation', { name: 'Main' })
    await flow(page, 'expected.report', {
      before: async () => {
        await page.goto(`/t/${slug}/contacts`)
        await nav.getByRole('button', { name: 'Donations' }).click()
        await expect(
          page.getByRole('menuitem', { name: 'Expected vs actual' }),
        ).toBeVisible()
      },
      action: () =>
        page.getByRole('menuitem', { name: 'Expected vs actual' }).click(),
      until: reportShown,
      server: true,
    })
    await page.getByLabel('By').selectOption('category')
    await expect(page).toHaveURL(/by=category/)
    await expect(
      page.getByRole('heading', { name: 'Upgrades and downgrades' }),
    ).toBeVisible()
  })

  test('a subscription made in GoCardless’s dashboard, adopted', async ({
    page,
    flow,
    users,
    instance,
  }) => {
    test.info().annotations.push(UNMATCHED)
    const slug = users.a.slug
    await connected(page, slug)
    const r = await recorder(instance, users.a, slug)
    const { gift } = await activeGift(page, slug, r.codeId)

    // Each repeat adopts a new one on the same mandate.
    await flow(page, 'gocardless.adopt', {
      before: async () => {
        const { subscription } = await simulate(
          page,
          `mandates/${gift.mandateId}/subscription?amount=500`,
        )
        await simulate(page, `subscriptions/${subscription}/payment`)
        await expect
          .poll(
            async () =>
              (
                await json<Array<UnknownSubscription>>(
                  page,
                  'GET',
                  `/api/t/${slug}/gocardless/unknown-subscriptions`,
                )
              ).some((s) => s.subscriptionId === subscription),
            { timeout: 10_000 },
          )
          .toBe(true)
        await page.goto(`/t/${slug}/gocardless/unmatched`)
        await page
          .locator(`tr[data-subscription="${subscription}"]`)
          .getByRole('button', { name: 'Adopt' })
          .click()
        await pickCode(page, 'Event-Gala-001')
        await expect(
          page.getByRole('dialog').getByRole('button', { name: 'Adopt' }),
        ).toBeEnabled()
      },
      action: () =>
        page.getByRole('dialog').getByRole('button', { name: 'Adopt' }).click(),
      until: adopted,
    })
    await expect(page.getByRole('dialog')).toContainText(
      '£5.00 every month on the 5th',
    )
  })
})
