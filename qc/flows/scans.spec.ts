import { expect, test } from '../fixtures'
import {
  createContact,
  secondTab,
  section,
  uniqueName,
} from './contact.helpers'
import { today } from './gift.helpers'
import type { Page } from '@playwright/test'

// Declaration scans step 4, the laptop side: "Scans to match" from the
// Gift Aid menu, a scan matched to a new paper declaration beside the
// form (then "✓ scan held" on the contact), "Scan with phone" (the QR
// code and the link; Done ends it), Settings › Scans storage and the
// admin's "can be deleted" report. Scans are uploaded as a signed-in
// phone would (`POST scans`, a canvas-drawn JPEG), untimed. The phone
// page and the two-device pairing flow are steps 5 and 6.

const INBOX = { type: 'route', description: '/t/$slug/scans/' }
const REVIEW = { type: 'route', description: '/t/$slug/scans/$scanId' }
const DELETABLE = { type: 'route', description: '/t/$slug/scans/deletable' }
const STORAGE = { type: 'route', description: '/t/$slug/settings/storage' }

/** A new one-page draft scan in `slug`, as a signed-in phone sends one. */
async function uploadScan(page: Page, slug: string): Promise<string> {
  // The fetch is relative to the SPA's origin: a fresh page has none yet.
  if (!page.url().startsWith('http')) await page.goto(`/t/${slug}/scans`)
  return page.evaluate(async (s) => {
    const canvas = document.createElement('canvas')
    canvas.width = 620
    canvas.height = 877
    const g = canvas.getContext('2d')!
    g.fillStyle = '#fff'
    g.fillRect(0, 0, canvas.width, canvas.height)
    g.fillStyle = '#000'
    g.font = '28px sans-serif'
    g.fillText('Gift Aid declaration', 40, 80)
    g.fillText(new Date().toISOString(), 40, 140)
    const blob = await new Promise<Blob>((done) =>
      canvas.toBlob((b) => done(b!), 'image/jpeg', 0.7),
    )
    const id = [...crypto.getRandomValues(new Uint8Array(16))]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
    const res = await fetch(`/api/t/${s}/scans?id=${id}`, {
      method: 'POST',
      body: blob,
      credentials: 'include',
    })
    if (!res.ok) throw new Error(`upload: ${res.status} ${await res.text()}`)
    return ((await res.json()) as { scanId: string }).scanId
  }, slug)
}

/** The review page of a new scan, its donor picked, the form filled in. */
async function reviewing(page: Page, slug: string, lastName: string) {
  const scanId = await uploadScan(page, slug)
  await page.goto(`/t/${slug}/scans/${scanId}`)
  await expect(
    page.getByRole('img', { name: 'Scan, page 1 of 1' }),
  ).toBeVisible()
  await page.getByLabel('Find the donor by name or number').fill(lastName)
  await page.getByRole('button', { name: new RegExp(lastName) }).click()
  // The form's own date: never assumed to be today.
  await expect(page.getByLabel('Date on the form')).toHaveValue('')
  await page.getByLabel('Date on the form').fill(today())
  await expect(page.getByLabel('Last name')).toHaveValue(lastName)
  return scanId
}

// ── in-page predicates (serialised: no closures, no imports) ──────────────

/** "Scans to match" has loaded its list (or says it is empty). */
function inboxShown() {
  return (
    document.querySelector('main h1')?.textContent === 'Scans to match' &&
    Boolean(
      document.querySelector('[data-testid="inbox-scan"]') ??
      [...document.querySelectorAll('main p')].some((p) =>
        p.textContent.startsWith('Nothing to match'),
      ),
    )
  )
}

/** The sitting shows its QR code and the phone's link. */
function sittingShown() {
  const link = document.querySelector<HTMLInputElement>(
    '[role="dialog"] input[readonly]',
  )
  return Boolean(
    link?.value.includes('/scan.html#') &&
    document.querySelector('[role="dialog"] svg[aria-label^="QR code"]'),
  )
}

test.describe(
  'declaration scans (laptop)',
  { annotation: [INBOX, REVIEW] },
  () => {
    test('Scans to match opens from the Gift Aid menu; an accepted scan is held on its declaration', async ({
      page,
      flow,
      users,
    }) => {
      const slug = users.a.slug
      const lastName = uniqueName('scan')
      const contactUrl = await createContact(page, slug, lastName)
      await uploadScan(page, slug)
      const nav = page.getByRole('navigation', { name: 'Main' })
      await flow(page, 'scans.open', {
        before: async () => {
          await page.goto(`/t/${slug}/contacts`)
          await nav.getByRole('button', { name: 'Gift Aid' }).click()
          await expect(
            page.getByRole('menuitem', { name: 'Scans to match' }),
          ).toBeVisible()
        },
        action: () =>
          page.getByRole('menuitem', { name: 'Scans to match' }).click(),
        until: inboxShown,
        server: true,
      })
      await expect(page.getByTestId('inbox-scan').first()).toBeVisible()

      await flow(page, 'scans.accept', {
        before: () => reviewing(page, slug, lastName).then(() => undefined),
        action: () => page.getByRole('button', { name: 'Accept' }).click(),
        until: inboxShown,
      })
      await page.goto(contactUrl)
      await expect(
        section(page, 'Gift Aid').getByTestId('scan-held').first(),
      ).toContainText('✓ Scan held, scanned')
      await section(page, 'Gift Aid')
        .getByRole('button', { name: 'View scan' })
        .first()
        .click()
      await expect(
        page.getByRole('dialog').getByRole('img', { name: /^Scan, page 1/ }),
      ).toBeVisible()
    })

    test('a scan is discarded with a reason and leaves the list', async ({
      page,
      users,
    }) => {
      const slug = users.a.slug
      const scanId = await uploadScan(page, slug)
      await page.goto(`/t/${slug}/scans/${scanId}`)
      await page.getByRole('button', { name: 'Discard' }).click()
      await page
        .getByRole('alertdialog')
        .getByLabel('Why (optional)')
        .fill('blurred')
      await page
        .getByRole('alertdialog')
        .getByRole('button', { name: 'Discard' })
        .click()
      await expect(page).toHaveURL(`/t/${slug}/scans`)
      await expect(
        page.getByRole('heading', { name: 'Scans to match' }),
      ).toBeVisible()
      await expect(
        page.locator(`[data-testid="inbox-scan"] img[src*="${scanId}"]`),
      ).toHaveCount(0)
    })

    test('Scan with phone shows a QR code and the link; Done ends it', async ({
      page,
      flow,
      users,
    }) => {
      const slug = users.a.slug
      const contactUrl = await createContact(page, slug, uniqueName('pair'))
      const giftAid = section(page, 'Gift Aid')
      await flow(page, 'scans.pair', {
        before: async () => {
          await page.goto(contactUrl)
          await expect(
            giftAid.getByRole('button', { name: 'Scan with phone' }),
          ).toBeVisible()
        },
        action: () =>
          giftAid.getByRole('button', { name: 'Scan with phone' }).click(),
        until: sittingShown,
        server: true,
      })
      const dialog = page.getByRole('dialog')
      await expect(dialog.getByTestId('scan-link-state')).toContainText(
        'Waiting for the phone',
      )
      await expect(dialog).toContainText('None yet')
      await dialog.getByRole('button', { name: 'Done' }).click()
      await expect(dialog).toHaveCount(0)
    })

    test('staff scan too; a viewer is told the scans aren’t theirs', async ({
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
        await nav.getByRole('button', { name: 'Gift Aid' }).click()
        await expect(
          staff.getByRole('menuitem', { name: 'Claims' }),
        ).toHaveCount(0)
        await staff.getByRole('menuitem', { name: 'Scans to match' }).click()
        await expect(
          staff.getByRole('heading', { name: 'Scans to match' }),
        ).toBeVisible()
        await staff.goto(`/t/${users.staff.slug}/scans/deletable`)
        await expect(
          staff.getByText('This report is for the group’s admins.'),
        ).toBeVisible()
      } finally {
        await staff.context().close()
      }
      const viewer = await secondTab(
        browser,
        baseURL!,
        await session(users.viewer),
      )
      try {
        await viewer.goto(`/t/${users.viewer.slug}/scans`)
        await expect(
          viewer.getByText(
            'Declaration scans are for the group’s staff and admins.',
          ),
        ).toBeVisible()
      } finally {
        await viewer.context().close()
      }
    })
  },
)

test('Settings › Scans storage shows the group’s usage of its 2 GB', async ({
  page,
  users,
}) => {
  test.info().annotations.push(STORAGE)
  await page.goto(`/t/${users.a.slug}/settings/storage`)
  await expect(page.getByTestId('files-usage')).toHaveText(
    / of 2 GB \(\d+%\) used$/,
  )
  await expect(
    page.getByRole('meter', { name: 'Scans storage used' }),
  ).toBeVisible()
})

test('the "can be deleted" report opens for an admin', async ({
  page,
  users,
}) => {
  test.info().annotations.push(DELETABLE)
  await page.goto(`/t/${users.a.slug}/scans`)
  await page.getByRole('link', { name: 'Scans that can be deleted' }).click()
  await expect(
    page.getByRole('heading', { name: 'Scans that can be deleted' }),
  ).toBeVisible()
  // A fresh world has no scan 7 years past its last covered gift.
  await expect(page.getByText('None.', { exact: true })).toBeVisible()
})
