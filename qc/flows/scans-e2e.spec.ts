import { fileURLToPath } from 'node:url'
import { devices } from '@playwright/test'
import { apiPost, expect, test } from '../fixtures'
import {
  createContact,
  secondTab,
  section,
  uniqueName,
} from './contact.helpers'
import { today } from './gift.helpers'
import type { Browser, Page } from '@playwright/test'

// Declaration scans step 6, end to end: a signed-in staff member's laptop
// and a phone with no session, two browser contexts. The laptop opens
// "Scan with phone" on a contact's Gift Aid panel and the phone opens the
// dialog's link (read from the copy-link field, not the QR). Pages the
// phone sends appear in the laptop's stack over SSE, with no reload; a
// two-page scan is accepted onto the contact's paper declaration, which
// then holds it. A second phone is refused the link, and Done on the
// laptop ends it on the phone.
//
// Timed: `scans.uploadToLaptop`, from Use page on the phone (the page
// is flattened, encoded and sent) to its thumbnail shown in the laptop's
// stack.

const CONTACT = { type: 'route', description: '/t/$slug/contacts/$contactId' }

const PHOTO = fileURLToPath(
  new URL('../assets/declaration-photo.jpg', import.meta.url),
)
const { defaultBrowserType: _, ...IPHONE } = devices['iPhone 15']
const NO_SESSION = { cookies: [], origins: [] }

/** A phone: an iPhone's screen, touch and user agent, not signed in. */
async function phone(browser: Browser, baseURL: string): Promise<Page> {
  const context = await browser.newContext({
    baseURL,
    ...IPHONE,
    storageState: NO_SESSION,
  })
  return context.newPage()
}

const screen = (page: Page) => page.locator('[data-screen]')

/** From the camera's photo to the crop screen, its page found. */
async function photograph(page: Page) {
  await page.locator('#camera').setInputFiles(PHOTO)
  await expect(screen(page)).toHaveAttribute('data-screen', 'crop')
  await expect(screen(page)).toHaveAttribute('data-found', 'true')
}

/** The phone's newest page reads `state`. */
function lastPageIs(state: string) {
  const pages = [...document.querySelectorAll('.pages li')]
  return pages.at(-1)?.getAttribute('data-state') === state
}

/** Photographed, used, and landed on the server. */
async function sendPage(page: Page) {
  await photograph(page)
  await page.getByRole('button', { name: 'Use page' }).click()
  await page.waitForFunction(lastPageIs, 'sent')
}

// ── in-page functions (serialised: no closures, no imports) ──────────────

/**
 * A phone in the hand draws every frame. Headless Chromium gives the
 * page of a second window frames only while it draws: Use page's "let
 * the message paint" frame (src/scan/main.ts) then waited about a second
 * (measured: the upload started 1.1 s after the tap, 0.1 s with this).
 */
function drawEveryFrame() {
  const tick = () => requestAnimationFrame(tick)
  tick()
}

/**
 * The laptop's stack holds `want` scans (by default the `qcWant` the
 * sample set) and the newest one's first page is drawn.
 */
function stackShows(want?: number) {
  const n = want ?? (window as unknown as { qcWant: number }).qcWant
  const items = document.querySelectorAll('[data-testid="sitting-scan"]')
  if (n === 0) return true
  if (items.length < n) return false
  const img = items[n - 1].querySelector('img')
  return img !== null && img.complete && img.naturalWidth > 0
}

test('a phone pairs with the laptop: pages arrive live, a scan is matched, the link ends', async ({
  browser,
  baseURL,
  instance,
  session,
  users,
  flow,
}) => {
  test.info().annotations.push(CONTACT)
  const slug = users.staff.slug
  const laptop = await secondTab(browser, baseURL!, await session(users.staff))
  const mobile = await phone(browser, baseURL!)
  try {
    const lastName = uniqueName('e2e')
    const contactUrl = await createContact(laptop, slug, lastName)
    const contactId = contactUrl.split('/').at(-1)!
    const madeOn = today()
    await apiPost(
      instance,
      users.staff,
      `/api/t/${slug}/contacts/${contactId}/giftaid`,
      {
        contactId,
        scope: 'future',
        madeOn,
        method: 'paperForm',
        wordingVersion: 'hmrc-2016-04',
        firstName: 'Qc',
        lastName,
        addressLine1: '12',
        postcode: 'SW1A 1AA',
      },
    )
    await laptop.reload()
    const giftAid = section(laptop, 'Gift Aid')
    await giftAid.getByRole('button', { name: 'Scan with phone' }).click()
    const dialog = laptop.getByRole('dialog')
    const linkField = dialog.locator('input[readonly]')
    await expect(linkField).toHaveValue(/\/scan\.html#/)
    const link = await linkField.inputValue()
    await expect(dialog.getByTestId('scan-link-state')).toContainText(
      'Waiting for the phone',
    )

    await mobile.goto(link)
    await expect(screen(mobile)).toHaveAttribute('data-screen', 'home')
    await mobile.evaluate(drawEveryFrame)

    // Each sample is a new one-page scan: Send closes the one before.
    const stack = dialog.getByTestId('sitting-scan')
    await flow(laptop, 'scans.uploadToLaptop', {
      inputPage: mobile,
      before: async () => {
        const send = mobile.getByRole('button', { name: 'Send' })
        if (await send.isVisible()) await send.click()
        await photograph(mobile)
        // Every earlier page is drawn: only this one is waited for.
        const n = await stack.count()
        await laptop.waitForFunction(stackShows, n)
        await laptop.evaluate((want) => {
          ;(window as unknown as { qcWant: number }).qcWant = want
        }, n + 1)
      },
      action: () => mobile.getByRole('button', { name: 'Use page' }).click(),
      until: stackShows,
      server: true,
    })
    await expect(dialog.getByTestId('scan-link-state')).toContainText(
      'A phone is connected',
    )

    // Two pages (Add page, then Send) arrive as one scan of 2 pages.
    await mobile.getByRole('button', { name: 'Send' }).click()
    const before = await stack.count()
    await sendPage(mobile)
    await mobile
      .locator('label[for="camera"]', { hasText: 'Add page' })
      .waitFor()
    await sendPage(mobile)
    await mobile.getByRole('button', { name: 'Send' }).click()
    await expect(stack).toHaveCount(before + 1)
    const twoPages = stack.nth(before)
    await expect(twoPages).toContainText('2 pages')

    // A second phone opening the same link is refused.
    const other = await phone(browser, baseURL!)
    try {
      await other.goto(link)
      await expect(screen(other)).toHaveAttribute('data-why', 'forbidden')
    } finally {
      await other.context().close()
    }

    // Matched onto the contact's paper declaration, beside the form.
    await twoPages.getByRole('button', { name: 'Review' }).click()
    await expect(
      dialog.getByRole('img', { name: 'Scan, page 2 of 2' }),
    ).toBeVisible()
    await dialog.getByRole('radio', { name: /^The declaration of / }).check()
    await dialog.getByRole('button', { name: 'Accept' }).click()
    await expect(
      stack.nth(before).getByRole('button', { name: 'Review' }),
    ).toHaveCount(0)

    // Done ends the link, and the phone with it.
    await dialog.getByRole('button', { name: 'Done' }).click()
    await expect(dialog).toHaveCount(0)
    await photograph(mobile)
    await mobile.getByRole('button', { name: 'Use page' }).click()
    await expect(screen(mobile)).toHaveAttribute('data-why', 'gone')
    await expect(mobile.getByText('This link has ended')).toBeVisible()

    // The declaration holds the scan, both pages.
    await expect(giftAid.getByTestId('scan-held').first()).toContainText(
      '✓ Scan held, scanned',
    )
    await giftAid.getByRole('button', { name: 'View scan' }).first().click()
    await expect(
      laptop
        .getByRole('dialog')
        .getByRole('img', { name: 'Scan, page 2 of 2' }),
    ).toBeVisible()
  } finally {
    await mobile.context().close()
    await laptop.context().close()
  }
})
