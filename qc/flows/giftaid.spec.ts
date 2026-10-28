import { expect, test } from '../fixtures'
import { secondTab, uniqueName, want } from './contact.helpers'
import {
  GIFT_ROUTE,
  createClaims,
  daysAgo,
  declare,
  donorGift,
  recorder,
  setClaimStatus,
  today,
} from './gift.helpers'
import type { Recorder } from './gift.helpers'
import type { Page } from '@playwright/test'

// Gift Aid claims G3: the Gift Aid page, a new claim's preview (and an
// exclusion fixed, then refreshed), a claim's steps, its downloads, and
// Settings › HMRC details. Signed in as user A, an admin.
//
// Every claims test's gifts are dated about 3 years back (`CLAIM_DAY`
// and before): older than any other spec's gifts (claimedGift's are
// 1,000 days back, the rest newer), so a claim up to that day takes only
// gifts these tests made. A claim takes every eligible gift up to its
// end date, so one may also take a gift an earlier test here left
// unclaimed (a rejected claim's): assertions name their own gifts, never
// counts.

const LIST = { type: 'route', description: '/t/$slug/giftaid/' }
const LAYOUT = { type: 'route', description: '/t/$slug/giftaid' }
const NEW = { type: 'route', description: '/t/$slug/giftaid/new' }
const CLAIM = { type: 'route', description: '/t/$slug/giftaid/$claimId' }
const HMRC = { type: 'route', description: '/t/$slug/settings/hmrc' }

const CLAIM_DAY = 1100

const status = (page: Page) => page.getByTestId('claim-status')
const confirm = (page: Page, name: string) =>
  page.getByRole('alertdialog').getByRole('button', { name })

/** The claim page's status badge reads `arg`. */
function statusIs(label: string) {
  return (
    document.querySelector('main h1 [data-testid="claim-status"]')
      ?.textContent === label
  )
}

/** The preview lists window.__qcWant's gift as a line, not left out. */
function giftIsALine() {
  const id = (window as unknown as { __qcWant?: string }).__qcWant
  return Boolean(
    document.querySelector(
      `[data-testid="claim-lines"] tr[data-gift="${id}"]`,
    ) &&
    !document.querySelector(`[data-testid="excluded"] li[data-gift="${id}"]`),
  )
}

/** A draft claim of a new eligible gift, its page open. */
async function draftClaim(page: Page, r: Recorder, slug: string) {
  const day = daysAgo(CLAIM_DAY)
  const { giftId } = await donorGift(r, uniqueName('claim'), 2000n, day)
  const claims = await createClaims(r, day)
  const claim = claims.find((c) => c.lines.some((l) => l.giftId === giftId))!
  await page.goto(`/t/${slug}/giftaid/${claim.id}`)
  await expect(status(page)).toHaveText('Draft')
  return claim
}

test.describe(
  'Gift Aid claims',
  { annotation: [LAYOUT, LIST, NEW, CLAIM] },
  () => {
    test('the Gift Aid page opens from the header', async ({
      page,
      flow,
      users,
    }) => {
      await flow(page, 'giftaid.open', {
        before: async () => {
          await page.goto(`/t/${users.a.slug}/contacts`)
          await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
        },
        action: () =>
          page
            .getByRole('navigation', { name: 'Main' })
            .getByRole('link', { name: 'Gift Aid' })
            .click(),
        server: true,
        until: () =>
          document.querySelector('main h1')?.textContent ===
            'Gift Aid claims' &&
          Boolean(
            document.querySelector('[data-testid="claim-row"]') ??
            [...document.querySelectorAll('main p')].some((p) =>
              p.textContent.startsWith('No claims yet'),
            ),
          ),
      })
    })

    test('staff see no Gift Aid page', async ({
      browser,
      baseURL,
      session,
      users,
    }) => {
      const staff = await secondTab(
        browser,
        baseURL!,
        await session(users.staff),
      )
      try {
        const nav = staff.getByRole('navigation', { name: 'Main' })
        await staff.goto(`/t/${users.staff.slug}/contacts`)
        await expect(nav.getByRole('link', { name: 'Contacts' })).toBeVisible()
        await expect(nav.getByRole('link', { name: 'Gift Aid' })).toHaveCount(0)
        await staff.goto(`/t/${users.staff.slug}/giftaid`)
        await expect(
          staff.getByText('Gift Aid claims are for the group’s admins.'),
        ).toBeVisible()
      } finally {
        await staff.context().close()
      }
    })

    test('preview → create → download → submitted → paid', async ({
      page,
      flow,
      users,
      world,
      instance,
    }) => {
      test.info().annotations.push(HMRC)
      const r = await recorder(instance, users.a, world.tenants[0].tenantId)
      const slug = users.a.slug
      await page.goto(`/t/${slug}/giftaid/new`)
      const endDate = page.getByLabel('End date')
      await expect(endDate).toHaveValue(today())

      // A preview per end date: a new date each sample, so none is cached.
      let back = CLAIM_DAY + 200
      await flow(page, 'giftaid.preview', {
        before: async () => {
          back += 1
          await endDate.fill(daysAgo(back))
        },
        action: () => page.getByRole('button', { name: 'Preview' }).click(),
        server: true,
        until: () => {
          const end = document.querySelector<HTMLInputElement>(
            'main input[type="date"]',
          )?.value
          return Boolean(
            end && document.querySelector(`section[data-period-end="${end}"]`),
          )
        },
      })

      // Create: a fresh eligible gift, previewed, each sample.
      const day = daysAgo(CLAIM_DAY)
      let giftId = ''
      await flow(page, 'giftaid.create', {
        before: async () => {
          ;({ giftId } = await donorGift(r, uniqueName('preview'), 4000n, day))
          await page.goto(`/t/${slug}/giftaid/new`)
          await endDate.fill(day)
          await page.getByRole('button', { name: 'Preview' }).click()
          await expect(
            page.locator(`section[data-period-end="${day}"]`),
          ).toBeVisible()
          await expect(
            page.locator(
              `[data-testid="claim-lines"] tr[data-gift="${giftId}"]`,
            ),
          ).toHaveCount(1)
        },
        action: () =>
          page
            .getByRole('button', { name: /^Create (claim|\d+ claims)$/ })
            .click(),
        server: true,
        until: () =>
          Boolean(
            document
              .querySelector('main h1')
              ?.textContent.startsWith('Gift Aid claim '),
          ),
      })
      // The last sample's claim: a draft holding its gift, £10 Gift Aid on £40.
      await expect(status(page)).toHaveText('Draft')
      await expect(
        page.locator(`[data-testid="claim-lines"] tr[data-gift="${giftId}"]`),
      ).toContainText('£10.00')
      const claimUrl = page.url()
      await expect(
        page.getByText(
          'Mark the claim ready to download its schedule for HMRC.',
        ),
      ).toBeVisible()

      await page.getByRole('button', { name: 'Mark ready' }).click()
      await confirm(page, 'Mark ready').click()
      await expect(status(page)).toHaveText('Ready')

      // Downloads: the schedule in both formats.
      for (const name of ['Schedule (Excel)', 'Schedule (LibreOffice)']) {
        const file = page.waitForEvent('download')
        await page.getByRole('button', { name }).click()
        expect((await file).suggestedFilename()).toMatch(
          /^gift-aid-claim-\d+\.ods$/,
        )
      }
      // The XML waits for the group's HMRC details, and says so.
      await page.getByRole('button', { name: 'Claim XML' }).click()
      await expect(page.getByRole('alert')).toContainText(
        'Complete the HMRC details in Settings first',
      )

      // Settings › HMRC details: saved, warnings gone.
      await page.goto(`/t/${slug}/settings/hmrc`)
      const form = page.getByRole('form', { name: 'HMRC details' })
      await expect(page.getByTestId('hmrc-warnings')).toBeVisible()
      await form.getByLabel('HMRC charity reference').fill('AB12345')
      await form.getByLabel('Regulator').selectOption('ccew')
      await form.getByLabel('Registered charity number').fill('1234567')
      await form.getByLabel('First name').fill('Jo')
      await form.getByLabel('Last name').fill('Treasurer')
      await form.getByLabel('Postcode').fill('AB1 2CD')
      let phone = 100
      await flow(page, 'giftaid.hmrcSave', {
        before: async () => {
          phone += 1
          await form.getByLabel('Phone').fill(`01234 567${phone}`)
          await expect(page.getByText('Saved.')).toHaveCount(0)
        },
        action: () => form.getByRole('button', { name: 'Save' }).click(),
        server: true,
        until: () =>
          [...document.querySelectorAll('[role="status"]')].some(
            (s) => s.textContent === 'Saved.',
          ),
      })
      await expect(page.getByTestId('hmrc-warnings')).toHaveCount(0)

      await page.goto(claimUrl)
      const xml = page.waitForEvent('download')
      await page.getByRole('button', { name: 'Claim XML' }).click()
      expect((await xml).suggestedFilename()).toMatch(
        /^gift-aid-claim-\d+\.xml$/,
      )

      // Submitted, then paid: the server's figures on the page and the list.
      await page.getByRole('button', { name: 'Mark submitted' }).click()
      await page.getByLabel('HMRC reference').fill('QC-REF-1')
      await page
        .getByRole('form', { name: 'Mark submitted' })
        .getByRole('button', { name: 'Mark submitted' })
        .click()
      await expect(status(page)).toHaveText('Submitted')
      await expect(page.getByTestId('claim-progress')).toContainText(
        'HMRC reference QC-REF-1',
      )
      await page.getByRole('button', { name: 'Mark paid' }).click()
      const paid = page.getByRole('form', { name: 'Mark paid' })
      await paid.getByLabel('Amount HMRC paid (£)').fill('10.00')
      await paid.getByRole('button', { name: 'Mark paid' }).click()
      await expect(status(page)).toHaveText('Paid')
      await expect(page.getByTestId('claim-progress')).toContainText(
        '£10.00 on',
      )
      await page.getByRole('link', { name: '← Gift Aid claims' }).click()
      await expect(page.getByTestId('claim-row').first()).toBeVisible()
    })

    test('an excluded gift, fixed, comes in on Refresh', async ({
      page,
      flow,
      users,
      world,
      instance,
    }) => {
      test.info().annotations.push(GIFT_ROUTE)
      const r = await recorder(instance, users.a, world.tenants[0].tenantId)
      const slug = users.a.slug
      const day = daysAgo(CLAIM_DAY + 10)
      await page.goto(`/t/${slug}/giftaid/new`)
      await page.getByLabel('End date').fill(day)
      await page.getByRole('button', { name: 'Preview' }).click()
      await expect(
        page.locator(`section[data-period-end="${day}"]`),
      ).toBeVisible()

      let giftId = ''
      await flow(page, 'giftaid.refresh', {
        before: async () => {
          // No declaration: left out, with the reason and a way to the donor.
          const made = await donorGift(
            r,
            uniqueName('nodecl'),
            1600n,
            day,
            false,
          )
          giftId = made.giftId
          await page.getByRole('button', { name: 'Refresh' }).click()
          const left = page.locator(
            `[data-testid="excluded"] li[data-gift="${giftId}"]`,
          )
          await expect(left).toContainText('declaration')
          await expect(left.getByRole('link').first()).toHaveAttribute(
            'href',
            `/t/${slug}/contacts/${made.contactId}`,
          )
          // The fix: a declaration covering the past four years.
          await declare(r, made.contactId, today())
          await want(page, giftId)
        },
        action: () => page.getByRole('button', { name: 'Refresh' }).click(),
        server: true,
        until: giftIsALine,
      })
      await expect(
        page.locator(`[data-testid="claim-lines"] tr[data-gift="${giftId}"]`),
      ).toHaveCount(1)
      await expect(
        page.locator(`[data-testid="excluded"] li[data-gift="${giftId}"]`),
      ).toHaveCount(0)
    })

    test('each step of a claim: ready, submitted, paid, rejected', async ({
      page,
      flow,
      users,
      world,
      instance,
    }) => {
      const r = await recorder(instance, users.a, world.tenants[0].tenantId)
      const slug = users.a.slug

      await flow(page, 'giftaid.markReady', {
        before: async () => {
          await draftClaim(page, r, slug)
          await page.getByRole('button', { name: 'Mark ready' }).click()
          await expect(confirm(page, 'Mark ready')).toBeVisible()
        },
        action: () => confirm(page, 'Mark ready').click(),
        server: true,
        arg: 'Ready',
        until: statusIs,
      })

      await flow(page, 'giftaid.markSubmitted', {
        before: async () => {
          const c = await draftClaim(page, r, slug)
          await setClaimStatus(r, c.id, {
            expected: c.statusVersion,
            status: 'ready',
          })
          await expect(status(page)).toHaveText('Ready')
          await page.getByRole('button', { name: 'Mark submitted' }).click()
          await page.getByLabel('HMRC reference').fill('QC-REF')
        },
        action: () =>
          page
            .getByRole('form', { name: 'Mark submitted' })
            .getByRole('button', { name: 'Mark submitted' })
            .click(),
        server: true,
        arg: 'Submitted',
        until: statusIs,
      })

      await flow(page, 'giftaid.markPaid', {
        before: async () => {
          const c = await draftClaim(page, r, slug)
          const ready = await setClaimStatus(r, c.id, {
            expected: c.statusVersion,
            status: 'ready',
          })
          await setClaimStatus(r, c.id, {
            expected: ready,
            status: 'submitted',
            submittedOn: today(),
            hmrcReference: 'QC-REF',
          })
          await expect(status(page)).toHaveText('Submitted')
          await page.getByRole('button', { name: 'Mark paid' }).click()
          await expect(page.getByLabel('Amount HMRC paid (£)')).not.toHaveValue(
            '',
          )
        },
        action: () =>
          page
            .getByRole('form', { name: 'Mark paid' })
            .getByRole('button', { name: 'Mark paid' })
            .click(),
        server: true,
        arg: 'Paid',
        until: statusIs,
      })

      await flow(page, 'giftaid.reject', {
        before: async () => {
          const c = await draftClaim(page, r, slug)
          await setClaimStatus(r, c.id, {
            expected: c.statusVersion,
            status: 'ready',
          })
          await expect(status(page)).toHaveText('Ready')
          await page.getByRole('button', { name: 'Reject' }).click()
          await page.getByLabel('Why HMRC rejected it').fill('Wrong reference')
        },
        action: () =>
          page
            .getByRole('form', { name: 'Reject claim' })
            .getByRole('button', { name: 'Reject claim' })
            .click(),
        server: true,
        arg: 'Rejected',
        until: statusIs,
      })
      await expect(page.getByTestId('claim-progress')).toContainText(
        'Wrong reference',
      )
      await expect(page.getByText('these files are superseded')).toBeVisible()
    })
  },
)
