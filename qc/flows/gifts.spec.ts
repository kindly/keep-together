import { expect, test } from '../fixtures'
import { holdQuiet } from '../quiet'
import {
  CONTACT_ROUTE,
  createContact,
  section,
  uniqueName,
  want,
} from './contact.helpers'
import {
  GIFT_ROUTE,
  contactIdOf,
  declare,
  newDonor,
  recordGift,
  recorder,
  today,
} from './gift.helpers'
import { api } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'
import type { Page } from '@playwright/test'

// Cash gifts step 5: the gift page (view, edit, void / unvoid, history)
// and the contact page's Gifts and Gift Aid panels. Gifts and declarations
// are made through the API (gift.helpers.ts) until the record-gift page
// exists; each test makes its own contact.

const gifts = (page: Page) => section(page, 'Gifts')
const giftAid = (page: Page) => section(page, 'Gift Aid')
const heading = (page: Page) => page.getByRole('heading', { level: 1 })
const confirm = (page: Page, name: string) =>
  page.getByRole('alertdialog').getByRole('button', { name })

/** The gift page's heading includes window.__qcWant, and no form is open. */
function headingIsWant() {
  const w = (window as unknown as { __qcWant?: string }).__qcWant ?? ''
  const h1 = document.querySelector('main h1')
  return Boolean(
    h1?.textContent.includes(w) &&
    ![...document.querySelectorAll('button')].some(
      (b) => b.textContent === 'Save',
    ),
  )
}

test.describe('gift page', { annotation: [CONTACT_ROUTE, GIFT_ROUTE] }, () => {
  test('open, edit, void and unvoid', async ({
    page,
    flow,
    users,
    world,
    instance,
  }) => {
    const r = await recorder(instance, users.a, world.tenants[0].tenantId)
    const contactUrl = await createContact(
      page,
      users.a.slug,
      uniqueName('gift'),
    )
    const id = await recordGift(r, contactIdOf(contactUrl), 1234n)
    const row = gifts(page).getByRole('link', { name: /£12\.34/ })

    // From the contact's Gifts panel to the gift. A fresh load each time,
    // so the gift is never a result the client already holds.
    await flow(page, 'gift.open', {
      before: async () => {
        await page.goto(contactUrl)
        await expect(row).toBeVisible()
      },
      action: () => row.click(),
      until: () =>
        Boolean(
          document.querySelector('main h1')?.textContent.includes('from'),
        ),
      server: true,
    })
    await expect(heading(page)).toContainText('£12.34')
    await expect(page.getByTestId('gift-code')).toHaveText('Event-Gala-001')
    await expect(page.getByTestId('gift-coverage')).toHaveText(
      'Not covered by a declaration',
    )
    await expect(page.getByRole('heading', { name: 'History' })).toBeVisible()
    await expect(
      page.getByText('gift £12.34 cash, Event-Gala-001'),
    ).toBeVisible()

    // Edit the amount, a new one per sample.
    let pence = 1234
    await flow(page, 'gift.save', {
      before: async () => {
        pence += 101
        const pounds = `${Math.floor(pence / 100)}.${String(pence % 100).padStart(2, '0')}`
        await page.getByRole('button', { name: 'Edit' }).click()
        await page.getByLabel('Amount (£)').fill(pounds)
        await want(page, `£${pounds}`)
      },
      action: () => page.getByRole('button', { name: 'Save' }).click(),
      until: headingIsWant,
    })
    // A refused amount says why and keeps the form open.
    await page.getByRole('button', { name: 'Edit' }).click()
    await page.getByLabel('Amount (£)').fill('0')
    await page.getByRole('button', { name: 'Save' }).click()
    // One message, not the amount's and its share's joined.
    await expect(page.getByRole('alert')).toHaveText(
      'The amount must be over £0',
    )
    // A space inside is asked about, never read as £1,250.
    await page.getByLabel('Amount (£)').fill('12 50')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByRole('alert')).toHaveText(
      'Is that pounds and pence? Write it like 12.50, with no spaces',
    )
    await page.getByLabel('Amount (£)').fill('12.345')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByRole('alert')).toContainText('in pounds')
    await page.getByRole('button', { name: 'Cancel' }).click()

    const badge = heading(page).getByText('void', { exact: true })
    const voidButton = page.getByRole('button', { name: 'Void', exact: true })
    const unvoid = page.getByRole('button', { name: 'Unvoid' })
    // Void and unvoid are optimistic (lib/gifts setStatusLocally): the
    // page shows the new status before the server answers, and the timed
    // window ends on what the user sees. Outside it, each sample's write
    // must then be confirmed: the status counter, which only the server
    // moves, goes up by one and the status stays (no roll-back). Checked
    // at the start of the next sample and after the last.
    let pending: { version: number; isVoid: boolean } | null = null
    // By CSS: an open confirm hides the page from the role tree.
    const counter = page.locator('main h1')
    const statusVersion = async () =>
      Number(await counter.getAttribute('data-status-version'))
    // Untimed detail, not judged (budgets.ts): click to server-confirmed,
    // measured in the page so nothing is added to the timed window. A
    // capture listener notes the click, an observer the counter's move.
    const confirmMs: Record<'void' | 'unvoid', Array<number>> = {
      void: [],
      unvoid: [],
    }
    const expectConfirmed = async () => {
      if (!pending) return
      await expect(counter).toHaveAttribute(
        'data-status-version',
        String(pending.version),
      )
      await expect(badge).toHaveCount(pending.isVoid ? 1 : 0)
      const ms = await page.evaluate(() => {
        const w = window as unknown as {
          __qcConfirm?: { clickAt?: number; confirmedAt?: number }
        }
        const c = w.__qcConfirm
        return c?.clickAt !== undefined && c.confirmedAt !== undefined
          ? c.confirmedAt - c.clickAt
          : null
      })
      if (ms !== null) confirmMs[pending.isVoid ? 'void' : 'unvoid'].push(ms)
      pending = null
    }
    const expecting = async (isVoid: boolean) => {
      pending = { version: (await statusVersion()) + 1, isVoid }
      await page.evaluate((version) => {
        const w = window as unknown as {
          __qcConfirm?: { clickAt?: number; confirmedAt?: number }
        }
        const c: { clickAt?: number; confirmedAt?: number } = {}
        w.__qcConfirm = c
        document.addEventListener(
          'click',
          () => {
            c.clickAt ??= performance.now()
          },
          { capture: true, once: true },
        )
        const h1 = document.querySelector('main h1')!
        const seen = new MutationObserver(() => {
          if (h1.getAttribute('data-status-version') === String(version)) {
            c.confirmedAt = performance.now()
            seen.disconnect()
          }
        })
        seen.observe(h1, { attributes: true })
      }, pending.version)
    }
    const noteConfirms = () => {
      for (const kind of ['void', 'unvoid'] as const) {
        const ms = confirmMs[kind]
        if (!ms.length) continue
        test.info().annotations.push({
          type: `gift.${kind} server confirm (untimed)`,
          description: `${ms.map((m) => m.toFixed(1)).join(', ')} ms`,
        })
        console.log(
          `gift.${kind} server confirm (untimed): ${ms.map((m) => m.toFixed(1)).join(', ')} ms`,
        )
      }
    }
    // Void asks first; the confirm is the timed click.
    await flow(page, 'gift.void', {
      before: async () => {
        await expectConfirmed()
        if (await unvoid.isVisible()) {
          await unvoid.click()
          await confirm(page, 'Unvoid').click()
          await expect(voidButton).toBeVisible()
        }
        await voidButton.click()
        await expect(page.getByRole('alertdialog')).toBeVisible()
        await expecting(true)
      },
      action: () => confirm(page, 'Void').click(),
      until: () =>
        [...document.querySelectorAll('main h1 span')].some(
          (s) => s.textContent === 'void',
        ),
    })
    await expectConfirmed()
    await expect(badge).toBeVisible()
    await expect(page.getByTestId('gift-coverage')).toHaveText(
      'None: a void gift is never claimed',
    )
    // Cancel on the confirm leaves the gift as it is.
    await unvoid.click()
    await confirm(page, 'Unvoid').click()
    await expect(badge).toHaveCount(0)
    await voidButton.click()
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Cancel' })
      .click()
    await expect(badge).toHaveCount(0)

    // Unvoid asks first too; the confirm is the timed click.
    await flow(page, 'gift.unvoid', {
      before: async () => {
        await expectConfirmed()
        if (await voidButton.isVisible()) {
          await voidButton.click()
          await confirm(page, 'Void').click()
          await expect(unvoid).toBeVisible()
        }
        await unvoid.click()
        await expect(page.getByRole('alertdialog')).toBeVisible()
        await expecting(false)
      },
      action: () => confirm(page, 'Unvoid').click(),
      until: () =>
        ![...document.querySelectorAll('main h1 span')].some(
          (s) => s.textContent === 'void',
        ),
    })
    await expectConfirmed()
    noteConfirms()

    // A refused void rolls back: the confirm keeps the counter it opened
    // with, someone voids and unvoids meanwhile, so the void is stale. The
    // page may show it for a moment, then must not.
    await voidButton.click()
    await expect(page.getByRole('alertdialog')).toBeVisible()
    const before = await statusVersion()
    for (const status of ['void', 'completed'] as const)
      await r.client.mutation(api.giving.mutations.setStatus, {
        tenantId: r.tenantId,
        id,
        expected: before + (status === 'void' ? 0 : 1),
        status,
      })
    await expect(counter).toHaveAttribute(
      'data-status-version',
      String(before + 2),
    )
    await confirm(page, 'Void').click()
    await expect(page.getByRole('alert')).toContainText(
      'Someone else changed this gift’s status just now',
    )
    await expect(badge).toHaveCount(0)
    await expect(counter).toHaveAttribute(
      'data-status-version',
      String(before + 2),
    )
    // The contact's panel shows the gift as it is now.
    await page.reload()
    await heading(page).getByRole('link').click()
    await expect(
      gifts(page).getByRole('link', {
        name: new RegExp(`£${Math.floor(pence / 100)}\\.`),
      }),
    ).toBeVisible()
  })

  test('a viewer sees the gift but can’t change it', async ({
    browser,
    baseURL,
    session,
    users,
    world,
    instance,
  }) => {
    const r = await recorder(instance, users.a, world.tenants[0].tenantId)
    const contactId = world.tenants[0].contactIds[1]
    const id = await recordGift(r, contactId, 777n)
    await declare(r, contactId, '2025-01-01')
    const context = await browser.newContext({
      baseURL,
      storageState: await session(users.viewer),
    })
    const page = await context.newPage()
    await page.goto(`/t/${users.viewer.slug}/gifts/${id}`)
    await expect(heading(page)).toContainText('£7.77')
    await expect(page.getByRole('button', { name: 'Edit' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Void' })).toHaveCount(0)
    await page.goto(`/t/${users.viewer.slug}/contacts/${contactId}`)
    // The declaration shows, so its controls would have rendered by now.
    await expect(giftAid(page).getByTestId('declaration').first()).toBeVisible()
    await expect(
      giftAid(page).getByRole('button', { name: 'Record cancellation' }),
    ).toHaveCount(0)
    await expect(
      giftAid(page).getByRole('button', { name: /Mark made in error/ }),
    ).toHaveCount(0)
    await context.close()
  })
})

test.describe('contact panels', { annotation: CONTACT_ROUTE }, () => {
  test('the Gifts panel loads more', async ({
    page,
    flow,
    users,
    world,
    instance,
  }) => {
    const r = await recorder(instance, users.a, world.tenants[0].tenantId)
    const contactUrl = await createContact(
      page,
      users.a.slug,
      uniqueName('gifts'),
    )
    const contactId = contactIdOf(contactUrl)
    // More than a page (20): a bulk write, so other workers' samples
    // don't wait behind it.
    await holdQuiet(
      instance.name,
      'contact.gifts.loadMore gifts 25',
      async () => {
        for (let i = 0; i < 25; i++) {
          const day = String(1 + i).padStart(2, '0')
          await recordGift(r, contactId, BigInt(100 + i), `2026-01-${day}`)
        }
      },
    )
    const rowsOf = gifts(page).locator('li')
    await flow(page, 'contact.gifts.loadMore', {
      before: async () => {
        // A fresh load: page 1 is never a result the client already holds.
        await page.goto(contactUrl)
        await expect(rowsOf).toHaveCount(20)
      },
      action: () =>
        gifts(page).getByRole('button', { name: 'Load more' }).click(),
      until: () => {
        const panel = [...document.querySelectorAll('section')].find(
          (s) => s.querySelector('h2')?.textContent === 'Gifts',
        )
        return panel?.querySelectorAll('li').length === 25
      },
      server: true,
    })
    // Newest date first, and nothing more to load.
    await expect(rowsOf.first()).toContainText('25 Jan 2026')
    await expect(rowsOf.last()).toContainText('1 Jan 2026')
    await expect(
      gifts(page).getByRole('button', { name: 'Load more' }),
    ).toHaveCount(0)
  })

  test('Gift Aid: declarations, cancellation, made in error', async ({
    page,
    flow,
    users,
    world,
    instance,
  }) => {
    // The test's own wall-clock limit, not a budget: each sample of both
    // flows sets up a fresh donor and loads their page, so a re-measure
    // (K more samples) can pass Playwright's default 30 s.
    test.setTimeout(120_000)
    const r = await recorder(instance, users.a, world.tenants[0].tenantId)
    const contactUrl = await createContact(
      page,
      users.a.slug,
      uniqueName('giftaid'),
    )
    const contactId = contactIdOf(contactUrl)
    const gift = await recordGift(r, contactId, 2000n, '2025-06-01')
    await expect(giftAid(page).getByText('No declarations.')).toBeVisible()
    await expect(giftAid(page).getByTestId('giftaid-coverage')).toHaveText(
      'No declaration covers a gift made today.',
    )

    // Method, wording and snapshot show; oral and staff-ticked warn.
    await declare(r, contactId, '2025-01-01', 'oral')
    await declare(r, contactId, '2025-02-01', 'staffTickedNoEvidence')
    const cards = giftAid(page).getByTestId('declaration')
    await expect(cards).toHaveCount(2)
    await expect(cards.nth(0)).toContainText('Ticked by staff, no evidence yet')
    await expect(cards.nth(0)).toContainText('No evidence yet:')
    await expect(cards.nth(1)).toContainText('Made orally:')
    await expect(cards.nth(1)).toContainText('hmrc-2016-04')
    await expect(cards.nth(1)).toContainText('Qc Donor, 1 High Street, AB1 2CD')
    await expect(giftAid(page).getByTestId('giftaid-coverage')).toContainText(
      '✓ A gift made today is covered by the declaration of 1 Feb 2025',
    )
    // Coverage is derived for the gift too.
    await expect(
      gifts(page).getByRole('link', { name: /£20\.00/ }),
    ).toContainText('Gift Aid')

    // Record cancellation, from today. Each sample starts untimed from a
    // fresh donor with two declarations (as a real donor might have), so
    // the panel's read doesn't grow through the run; the cancellation ends
    // both.
    await flow(page, 'contact.giftaid.cancel', {
      before: async () => {
        const donor = await newDonor(r, uniqueName('giftaid-cancel'))
        await declare(r, donor, '2025-01-01')
        await declare(r, donor, '2025-03-01')
        await page.goto(`/t/${users.a.slug}/contacts/${donor}`)
        await expect(cards).toHaveCount(2)
        await giftAid(page)
          .getByRole('button', { name: 'Record cancellation' })
          .click()
        await giftAid(page)
          .getByRole('button', { name: 'Save cancellation' })
          .click()
        await expect(page.getByRole('alertdialog')).toBeVisible()
        await want(page, '2')
      },
      // The confirm is the timed click, as for a void.
      action: () => confirm(page, 'Record cancellation').click(),
      until: () => {
        const w = (window as unknown as { __qcWant?: string }).__qcWant
        const badges = [
          ...document.querySelectorAll('[data-testid="declaration"] span'),
        ].filter((s) => s.textContent.startsWith('cancelled from '))
        return String(badges.length) === w
      },
    })
    await expect(giftAid(page).getByTestId('giftaid-coverage')).toHaveText(
      'No declaration covers a gift made today.',
    )
    // A cancellation leaves a gift before it covered: the first donor's,
    // cancelled untimed.
    await r.client.mutation(api.giftaid.mutations.recordCancellation, {
      tenantId: r.tenantId,
      contactId: contactId as Id<'contacts'>,
      cancelledFrom: today(),
    })
    await page.goto(contactUrl)
    await expect(giftAid(page).getByTestId('giftaid-coverage')).toHaveText(
      'No declaration covers a gift made today.',
    )
    await page.goto(`/t/${users.a.slug}/gifts/${gift}`)
    await expect(page.getByTestId('gift-coverage')).toContainText('✓ Covered')
    await page.goto(contactUrl)

    // Mark made in error: a reason, then a confirm. Each sample starts
    // untimed from a fresh donor with two declarations, as for the
    // cancellation; the newer is marked.
    await flow(page, 'contact.giftaid.void', {
      before: async () => {
        const donor = await newDonor(r, uniqueName('giftaid-void'))
        await declare(r, donor, '2025-01-01')
        await declare(r, donor, '2025-04-01')
        await page.goto(`/t/${users.a.slug}/contacts/${donor}`)
        await expect(cards).toHaveCount(2)
        const fresh = cards.first()
        await expect(fresh).toContainText('made 1 Apr 2025')
        await expect(
          fresh.getByText('made in error', { exact: true }),
        ).toHaveCount(0)
        await fresh.getByRole('button', { name: 'Mark made in error' }).click()
        await fresh.getByLabel('Why was it made in error?').fill('wrong donor')
        await fresh.getByRole('button', { name: 'Mark made in error' }).click()
        await expect(page.getByRole('alertdialog')).toBeVisible()
        await want(page, '1')
      },
      action: () => confirm(page, 'Mark made in error').click(),
      until: () => {
        const w = (window as unknown as { __qcWant?: string }).__qcWant
        const badges = [
          ...document.querySelectorAll('[data-testid="declaration"] span'),
        ].filter((s) => s.textContent === 'made in error')
        return String(badges.length) === w
      },
    })
    await expect(cards.first()).toContainText('wrong donor')
    // No reason: refused before the confirm.
    await declare(r, contactId, '2025-05-01')
    await page.goto(contactUrl)
    const last = cards.first()
    await expect(last).toContainText('made 1 May 2025')
    await last.getByRole('button', { name: 'Mark made in error' }).click()
    await last.getByRole('button', { name: 'Mark made in error' }).click()
    await expect(last.getByRole('alert')).toHaveText(
      'Say why the declaration was made in error',
    )
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
  })
})
