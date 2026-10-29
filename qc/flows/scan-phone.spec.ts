import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { devices } from '@playwright/test'
import { expect, sessionCookie, sessionToken, test } from '../fixtures'
import type { Instance, QcUser } from '../fixtures'
import type { Page, Request } from '@playwright/test'
import type { ScanPairingStarted } from '../../src/lib/data/rust-types/ScanPairingStarted'
import type { ScanPairingView } from '../../src/lib/data/rust-types/ScanPairingView'

// Declaration scans, step 5: the phone's page (`/scan.html#<token>`). A
// pairing is started over the api as the laptop would (step 4's dialog
// isn't needed for it); the "phone" is a context with no session, a
// phone's viewport, touch and user agent, and the camera's photo is a
// fixture set on the camera input: 12 MP, stored on its side with EXIF
// orientation 6 as an iPhone does, the page tilted in perspective on a
// dark background.
//
// Chromium only: the iOS run emulates an iPhone's screen and user agent,
// not WebKit (Playwright's WebKit isn't installed here).

const PHOTO = fileURLToPath(
  new URL('../assets/declaration-photo.jpg', import.meta.url),
)
/** The page's corners in the photo as shown upright (3024 × 4032). */
const PHOTO_CORNERS = [
  [520, 640],
  [2480, 820],
  [2620, 3500],
  [380, 3300],
]

/** The phone page's own code, gzipped: plan step 5's budget. */
const SCAN_PAGE_GZIP_BYTES = 150_000

const PHONES = {
  android: devices['Pixel 7'],
  ios: devices['iPhone 15'],
}

const NO_SESSION = { cookies: [], origins: [] }

async function api<T>(
  inst: Instance,
  user: QcUser,
  method: 'POST' | 'GET' | 'DELETE',
  route: string,
  body?: unknown,
): Promise<T> {
  const token = await sessionToken(inst, user.email)
  const res = await fetch(`${inst.api}${route}`, {
    method,
    headers: {
      cookie: sessionCookie(inst, token),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${route}: ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}

/** A stack sitting started as the laptop does: its id and the QR's path. */
async function startPairing(inst: Instance, user: QcUser) {
  const started = await api<ScanPairingStarted>(
    inst,
    user,
    'POST',
    `/api/t/${user.slug}/scan-pairings`,
    { purpose: 'stack' },
  )
  return { id: started.pairing.id, path: started.path }
}

function sitting(inst: Instance, user: QcUser, id: string) {
  return api<ScanPairingView>(
    inst,
    user,
    'GET',
    `/api/t/${user.slug}/scan-pairings/${id}`,
  )
}

const screen = (page: Page) => page.locator('[data-screen]')

/** From the camera's photo to the crop screen. */
async function photograph(page: Page) {
  await page.locator('#camera').setInputFiles(PHOTO)
  await expect(screen(page)).toHaveAttribute('data-screen', 'crop')
}

/** The newest page of this scan reads `state`. */
function lastPageIs(state: string) {
  const pages = [...document.querySelectorAll('.pages li')]
  return pages.at(-1)?.getAttribute('data-state') === state
}

for (const [phone, device] of Object.entries(PHONES)) {
  test.describe(`phone (${phone})`, () => {
    test.use({
      viewport: device.viewport,
      userAgent: device.userAgent,
      deviceScaleFactor: device.deviceScaleFactor,
      isMobile: device.isMobile,
      hasTouch: device.hasTouch,
      // Not signed in: the link is the phone's only credential.
      storageState: NO_SESSION,
    })

    test('opens the link, finds the page, flattens and sends it', async ({
      page,
      instance,
      users,
      flow,
    }) => {
      const { id, path } = await startPairing(instance, users.a)
      const requests: Array<Request> = []
      page.on('request', (r) => requests.push(r))

      await flow(page, 'scan.open', {
        // Each sample opens the link afresh (this phone holds it already).
        before: async () => {
          await page.goto('about:blank')
        },
        action: async () => {
          await page.goto(path, { waitUntil: 'commit' })
        },
        start: 'navigation',
        until: () => document.querySelector('[data-screen="home"]') !== null,
        server: true,
      })
      // The organisation's name, so staff know the scans' destination.
      await expect(page.locator('.top .org')).not.toBeEmpty()
      await expect(
        page.locator('label[for="camera"]', {
          hasText: 'Photograph a declaration',
        }),
      ).toBeVisible()

      // The phone page loads none of the app, and fits its budget.
      const js = requests.filter((r) =>
        ['script', 'stylesheet', 'document'].includes(r.resourceType()),
      )
      let gzipped = 0
      const seen = new Set<string>()
      for (const r of js) {
        const url = new URL(r.url())
        if (url.pathname.includes('/scanic')) continue
        expect(url.pathname, 'the app bundle on the phone').not.toMatch(
          /\/assets\/main-/,
        )
        // Fetched again: the samples' pages are gone with their bodies.
        if (seen.has(url.pathname)) continue
        seen.add(url.pathname)
        const res = await page.request.get(url.pathname)
        gzipped += gzipSync(await res.body()).length
      }
      expect(gzipped).toBeLessThan(SCAN_PAGE_GZIP_BYTES)

      await photograph(page)
      // scanic found the page, through the EXIF turn and the perspective.
      await expect(screen(page)).toHaveAttribute('data-found', 'true')
      const corners = await page
        .locator('.crop-handle')
        .evaluateAll((hs) =>
          hs.map((h) => [
            parseFloat((h as HTMLElement).style.left) / 100,
            parseFloat((h as HTMLElement).style.top) / 100,
          ]),
        )
      corners.forEach(([x, y], i) => {
        expect(Math.abs(x * 3024 - PHOTO_CORNERS[i][0])).toBeLessThan(120)
        expect(Math.abs(y * 4032 - PHOTO_CORNERS[i][1])).toBeLessThan(120)
      })
      await page.getByRole('button', { name: 'Use page' }).click()
      await page.waitForFunction(lastPageIs, 'sent')

      // Timed: Use page to "Sent", the warp, the encode and the upload.
      await flow(page, 'scan.sendPage', {
        before: async () => {
          // A fresh scan each time, so no sample meets the 6-page cap.
          if (await page.getByRole('button', { name: 'Send' }).isVisible()) {
            await page.getByRole('button', { name: 'Send' }).click()
          }
          await photograph(page)
          await expect(screen(page)).toHaveAttribute('data-found', 'true')
        },
        action: async () => {
          await page.getByRole('button', { name: 'Use page' }).click()
        },
        until: () => {
          const pages = [...document.querySelectorAll('.pages li')]
          return pages.at(-1)?.getAttribute('data-state') === 'sent'
        },
        server: true,
      })

      const view = await sitting(instance, users.a, id)
      expect(view.claimed).toBe(true)
      const first = view.scans[0]
      expect(first.via).toBe('phone')
      expect(first.status).toBe('draft')
      expect(first.pages).toHaveLength(1)
      // A4 at 150 dpi, portrait, within the server's 400 KB.
      expect(first.pages[0]).toMatchObject({ width: 1240, height: 1754 })
      expect(first.pages[0].size).toBeLessThanOrEqual(400_000)

      // The token went only where it must: the api path, never a page
      // URL, a query or a Referer.
      const token = path.split('#')[1]
      for (const r of requests) {
        const url = new URL(r.url())
        expect(url.search).not.toContain(token)
        if (!url.pathname.startsWith(`/api/scan/${token}`)) {
          expect(url.pathname).not.toContain(token)
        }
        const referer = (await r.allHeaders()).referer as string | undefined
        expect(referer ?? '').not.toContain(token)
      }
    })

    test('several pages make one scan; Send starts the next', async ({
      page,
      instance,
      users,
    }) => {
      const { id, path } = await startPairing(instance, users.a)
      await page.goto(path)
      await expect(screen(page)).toHaveAttribute('data-screen', 'home')

      await photograph(page)
      await page.getByRole('button', { name: 'Use page' }).click()
      await page.waitForFunction(lastPageIs, 'sent')
      await page
        .locator('label[for="camera"]', { hasText: 'Add page' })
        .waitFor()
      await photograph(page)
      // Turned a quarter: the page comes out landscape.
      await page.getByRole('button', { name: 'Rotate' }).click()
      await page.getByRole('button', { name: 'Use page' }).click()
      await page.waitForFunction(lastPageIs, 'sent')
      await expect(
        page.getByRole('heading', { name: 'This scan: 2 pages' }),
      ).toBeVisible()
      await page.getByRole('button', { name: 'Send' }).click()
      await expect(page.locator('.done li')).toHaveCount(1)
      await expect(page.locator('.done li')).toContainText('On the laptop')

      await photograph(page)
      await page.getByRole('button', { name: 'Use page' }).click()
      await page.waitForFunction(lastPageIs, 'sent')

      const view = await sitting(instance, users.a, id)
      expect(view.scans.map((s) => s.pages.length)).toEqual([2, 1])
      expect(view.scans[0].pages[1]).toMatchObject({
        width: 1754,
        height: 1240,
      })
    })

    test('a corner can be dragged', async ({ page, instance, users }) => {
      const { path } = await startPairing(instance, users.a)
      await page.goto(path)
      await photograph(page)
      const handle = page.getByRole('button', { name: 'Top left corner' })
      const before = (await handle.boundingBox())!
      const [x, y] = [before.x + before.width / 2, before.y + before.height / 2]
      await page.mouse.move(x, y)
      await page.mouse.down()
      await page.mouse.move(x + 30, y + 40, { steps: 5 })
      await page.mouse.up()
      const after = (await handle.boundingBox())!
      expect(after.x - before.x).toBeCloseTo(30, 0)
      expect(after.y - before.y).toBeCloseTo(40, 0)
      // The keyboard moves it too.
      await handle.press('ArrowRight')
      expect((await handle.boundingBox())!.x).toBeGreaterThan(after.x)
    })

    test('a crossed outline is refused, not sent mirrored', async ({
      page,
      instance,
      users,
    }) => {
      const { id, path } = await startPairing(instance, users.a)
      await page.goto(path)
      await photograph(page)
      // Top left dragged past top right.
      const tl = (await page
        .getByRole('button', { name: 'Top left corner' })
        .boundingBox())!
      const tr = (await page
        .getByRole('button', { name: 'Top right corner' })
        .boundingBox())!
      await page.mouse.move(tl.x + tl.width / 2, tl.y + tl.height / 2)
      await page.mouse.down()
      await page.mouse.move(tr.x + tr.width / 2 + 20, tr.y + tr.height / 2, {
        steps: 8,
      })
      await page.mouse.up()
      await page.getByRole('button', { name: 'Use page' }).click()
      await expect(page.locator('[data-crossed]')).toBeVisible()
      await expect(screen(page)).toHaveAttribute('data-screen', 'crop')
      expect((await sitting(instance, users.a, id)).scans).toHaveLength(0)
    })

    test('a page taken offline waits, then sends once when back', async ({
      page,
      context,
      instance,
      users,
    }) => {
      const { id, path } = await startPairing(instance, users.a)
      await page.goto(path)
      await photograph(page)
      await context.setOffline(true)
      await page.getByRole('button', { name: 'Use page' }).click()
      await expect(page.locator('[data-retrying="offline"]')).toBeVisible()
      await page.waitForFunction(lastPageIs, 'waiting')
      await context.setOffline(false)
      await page.waitForFunction(lastPageIs, 'sent')
      await expect(page.locator('[data-retrying]')).toHaveCount(0)
      const view = await sitting(instance, users.a, id)
      expect(view.scans).toHaveLength(1)
      expect(view.scans[0].pages).toHaveLength(1)
    })

    test('a page kept on the phone is sent after the page is thrown away', async ({
      page,
      context,
      instance,
      users,
    }) => {
      // As iOS does while the camera is open: the tab is discarded with a
      // page still waiting for a signal, and the link opened again.
      const { id, path } = await startPairing(instance, users.a)
      await page.goto(path)
      await photograph(page)
      await page.getByRole('button', { name: 'Use page' }).click()
      await page.waitForFunction(lastPageIs, 'sent')
      await photograph(page)
      await context.setOffline(true)
      await page.getByRole('button', { name: 'Use page' }).click()
      await page.waitForFunction(lastPageIs, 'waiting')
      await page.close()
      await context.setOffline(false)

      const again = await context.newPage()
      await again.goto(path)
      await expect(again.getByText('Picked up 1 page')).toBeVisible()
      await expect(
        again.getByRole('heading', { name: 'This scan: 2 pages' }),
      ).toBeVisible()
      await again.waitForFunction(lastPageIs, 'sent')
      const view = await sitting(instance, users.a, id)
      expect(view.scans).toHaveLength(1)
      expect(view.scans[0].pages).toHaveLength(2)
      // Nothing is picked up a second time.
      await again.reload()
      await expect(screen(again)).toHaveAttribute('data-screen', 'scan')
      await expect(again.getByText('Picked up')).toHaveCount(0)
    })

    test('the link ending on the laptop ends it on the phone', async ({
      page,
      instance,
      users,
    }) => {
      const { id, path } = await startPairing(instance, users.a)
      await page.goto(path)
      await expect(screen(page)).toHaveAttribute('data-screen', 'home')
      await api(
        instance,
        users.a,
        'DELETE',
        `/api/t/${users.a.slug}/scan-pairings/${id}`,
      )
      await photograph(page)
      await page.getByRole('button', { name: 'Use page' }).click()
      await expect(screen(page)).toHaveAttribute('data-why', 'gone')
      await expect(page.getByText('This link has ended')).toBeVisible()
      await expect(
        page.getByText('1 page didn’t reach the laptop'),
      ).toBeVisible()
      // Opening it again says the same.
      await page.reload()
      await expect(screen(page)).toHaveAttribute('data-why', 'gone')
    })

    test('a second phone is refused the link', async ({
      page,
      browser,
      instance,
      users,
    }) => {
      const { path } = await startPairing(instance, users.a)
      await page.goto(path)
      await expect(screen(page)).toHaveAttribute('data-screen', 'home')
      const { defaultBrowserType: _, ...phoneOptions } = device
      const other = await browser.newContext({
        baseURL: instance.baseURL,
        ...phoneOptions,
      })
      try {
        const second = await other.newPage()
        await second.goto(path)
        await expect(screen(second)).toHaveAttribute('data-why', 'forbidden')
      } finally {
        await other.close()
      }
    })

    test('without a token it asks for the laptop’s code', async ({ page }) => {
      await page.goto('/scan.html')
      await expect(screen(page)).toHaveAttribute('data-why', 'no_token')
    })
  })
}
