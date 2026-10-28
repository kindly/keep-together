import { expect, test } from '../fixtures'
import type { Page } from '@playwright/test'
import type { GoCardlessStatus } from '../../src/lib/data/rust-types/GoCardlessStatus'
import type { RegularGiftSaved } from '../../src/lib/data/rust-types/RegularGiftSaved'
import type { RegularGiftView } from '../../src/lib/data/rust-types/RegularGiftView'
import { GIFT_ROUTE, recorder } from './gift.helpers'

// GoCardless on the fake (factory/plans/gocardless.sv, D1 and D2), until
// D3 builds its pages: functional, not timed. The browser goes through
// the pages GoCardless would host (the fake's consent page and the
// donor's sign-up page) and lands back on the group's settings; set-up
// and GoCardless's own moves (the scenario simulators) go through the
// api; the money is checked where staff see it, on the gift page. Needs
// KEEP_GOCARDLESS=fake (the local pool); skipped elsewhere.

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
  json<{ delivered: boolean; payment?: string }>(
    page,
    'POST',
    `/api/fake-gocardless/simulate/${what}`,
  ).then((out) => {
    expect(out.delivered, what).toBe(true)
    return out
  })

/** The regular gift once `ready` holds (webhooks are handled in the background). */
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

test.describe('GoCardless (fake)', { annotation: GIFT_ROUTE }, () => {
  test('connect, sign up, mandate, payment to gift, failure and cancellation', async ({
    page,
    users,
    instance,
  }) => {
    const slug = users.a.slug
    await page.goto(`/t/${slug}/settings`)
    const status = await json<GoCardlessStatus>(
      page,
      'GET',
      `/api/t/${slug}/gocardless`,
    )
    test.skip(status.mode !== 'fake', 'needs KEEP_GOCARDLESS=fake')

    // Connect: the consent page, then back to the group's settings.
    const { url } = await json<{ url: string }>(
      page,
      'POST',
      `/api/t/${slug}/gocardless/connect`,
    )
    await page.goto(url)
    await page.getByRole('button', { name: 'Connect' }).click()
    await page.waitForURL(`**/t/${slug}/settings?gocardless=connected`)
    const connected = await json<GoCardlessStatus>(
      page,
      'GET',
      `/api/t/${slug}/gocardless`,
    )
    expect(connected.connected).toBe(true)

    // Staff set up £12.50 a month; the donor signs on the hosted page.
    const r = await recorder(instance, users.a, slug)
    const contact = await json<{ id: string }>(
      page,
      'POST',
      `/api/t/${slug}/contacts`,
      {
        kind: 'individual',
        title: '',
        firstName: 'Dee',
        lastName: `Debit-${Date.now()}`,
        nickname: '',
        name: '',
        isDeceased: false,
      },
    )
    const made = await json<RegularGiftSaved>(
      page,
      'POST',
      `/api/t/${slug}/contacts/${contact.id}/regular-gifts`,
      {
        amount: 1250,
        frequency: 'monthly',
        dayOfMonth: 1,
        sourceCodeId: r.codeId,
      },
    )
    expect(made.view.status).toBe('pending')
    await page.goto(made.view.flowUrl!)
    await expect(page.getByLabel('First name')).toHaveValue('Dee')
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

    // The bank sets the mandate up: active.
    await simulate(page, `mandates/${signed.mandateId}/activate`)
    await settled(page, slug, made.id, (v) => v.status === 'active')

    // A payment: nothing until GoCardless confirms it, then a gift.
    const { payment } = await simulate(
      page,
      `subscriptions/${signed.subscriptionId}/payment`,
    )
    const pending = await settled(page, slug, made.id, (v) =>
      v.payments.some((p) => p.paymentId === payment),
    )
    expect(pending.payments[0].giftId).toBeNull()
    await simulate(page, `payments/${payment}/confirm`)
    const paid = await settled(
      page,
      slug,
      made.id,
      (v) => v.payments[0]?.giftId != null,
    )
    await page.goto(`/t/${slug}/gifts/${paid.payments[0].giftId}`)
    await expect(page.getByText('Direct Debit', { exact: true })).toBeVisible()
    await expect(page.getByText('£12.50').first()).toBeVisible()
    await expect(page.getByText(payment!)).toBeVisible()

    // The next one fails: shown, no gift.
    const next = await simulate(
      page,
      `subscriptions/${signed.subscriptionId}/payment`,
    )
    await simulate(page, `payments/${next.payment}/fail`)
    const failed = await settled(
      page,
      slug,
      made.id,
      (v) => v.lastFailure?.paymentId === next.payment,
    )
    expect(failed.lastFailure!.giftId).toBeNull()

    // The donor's bank cancels the mandate: the regular gift ends.
    await simulate(page, `mandates/${signed.mandateId}/cancel`)
    const ended = await settled(
      page,
      slug,
      made.id,
      (v) => v.status === 'cancelled',
    )
    expect(ended.endedReason).toBeTruthy()
  })
})
