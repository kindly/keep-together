import { expect, test } from '../fixtures'
import type { Locator, Page } from '@playwright/test'

// The phone header (below md): the Menu button opens a drawer from the
// left with every destination; a link in it navigates and closes it, and
// back closes it without leaving the page. Untimed: it reaches the same
// pages the desktop flows already time.

const HOME = { type: 'route', description: '/t/$slug/' }
const CONTACTS = { type: 'route', description: '/t/$slug/contacts/' }
const NEW_GIFT = { type: 'route', description: '/t/$slug/gifts/new' }

const PHONE = { width: 390, height: 844 }
const parts = (page: Page) => ({
  menu: page.getByRole('button', { name: 'Menu' }),
  drawer: page.getByRole('dialog'),
  leave: page.getByRole('alertdialog'),
  donations: page
    .getByRole('dialog')
    .getByRole('button', { name: 'Donations' }),
})
/**
 * In the page: pointer presses (and what they hit), the history calls and
 * pops (with the drawer's marker), and the drawer opening and closing,
 * each to the console with its time.
 */
function traceDrawer() {
  const t = () => performance.now().toFixed(0)
  const mark = (s: unknown) =>
    (s as { mobileNav?: string } | null)?.mobileNav ?? '-'
  const what = (e: Event) => {
    const el = e.target
    if (!(el instanceof Element)) return '?'
    return el.getAttribute('data-slot') ?? el.tagName
  }
  for (const type of ['pointerdown', 'click'])
    document.addEventListener(
      type,
      (e) => console.log(`drawer-trace ${t()} ${type} ${what(e)}`),
      true,
    )
  const push = history.pushState
  history.pushState = function (...args) {
    console.log(`drawer-trace ${t()} pushState ${mark(args[0])}`)
    return push.apply(this, args)
  }
  const back = history.back
  history.back = function () {
    console.log(`drawer-trace ${t()} back from ${mark(history.state)}`)
    return back.apply(this)
  }
  addEventListener('popstate', (e) =>
    console.log(`drawer-trace ${t()} popstate to ${mark(e.state)}`),
  )
  new MutationObserver((records) => {
    const sel = '[data-slot=sheet-content]'
    const drawer = (n: Node) =>
      n instanceof Element && (n.matches(sel) || n.querySelector(sel))
    for (const r of records) {
      const el = r.target as Element
      if (r.type === 'attributes') {
        if (el.getAttribute('data-slot') === 'sheet-content')
          console.log(`drawer-trace ${t()} drawer ${el.getAttribute('data-state')}`)
        continue
      }
      for (const n of r.addedNodes)
        if (drawer(n)) console.log(`drawer-trace ${t()} drawer mounted`)
      for (const n of r.removedNodes)
        if (drawer(n)) console.log(`drawer-trace ${t()} drawer unmounted`)
    }
  }).observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['data-state'],
  })
}

/** The drawer's opening animation (if motion is allowed) has finished. */
const slidIn = (drawer: Locator) =>
  drawer.evaluate((el) =>
    Promise.all(el.getAnimations().map((a) => a.finished)),
  )

/** The page behind can scroll again (the drawer's scroll lock is gone). */
const unlocked = (page: Page) =>
  expect(page.locator('body')).not.toHaveAttribute('data-scroll-locked')

test(
  'phone: the drawer goes to Contacts, then to Record a gift',
  { annotation: [HOME, CONTACTS, NEW_GIFT] },
  async ({ page, users }) => {
    await page.setViewportSize(PHONE)
    const slug = users.a.slug
    const { menu, drawer, donations } = parts(page)
    await page.goto(`/t/${slug}`)
    await expect(menu).toBeVisible()
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden()
    for (const target of [
      menu,
      // The group name: the banner's only link shown on a phone.
      page.getByRole('banner').getByRole('link'),
    ]) {
      const box = (await target.boundingBox())!
      expect(box.height).toBeGreaterThanOrEqual(44)
    }
    expect((await menu.boundingBox())!.width).toBeGreaterThanOrEqual(44)

    await menu.click()
    await expect(drawer).toBeVisible()
    await expect(drawer.getByRole('link', { name: 'Home' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    // The drawer slides in to the left edge.
    await expect.poll(async () => (await drawer.boundingBox())?.x).toBe(0)
    await drawer.getByRole('link', { name: 'Contacts' }).click()
    await expect(page).toHaveURL(`/t/${slug}/contacts`)
    await expect(
      page.getByRole('heading', { level: 1, name: 'Contacts' }),
    ).toBeVisible()
    await expect(drawer).toBeHidden()
    await unlocked(page)

    await menu.click()
    await expect(
      drawer.getByRole('link', { name: 'Contacts' }),
    ).toHaveAttribute('aria-current', 'page')
    // Donations is one row, collapsed: its items appear when it's tapped.
    const record = drawer.getByRole('link', { name: 'Record a gift' })
    await expect(donations).toHaveAttribute('aria-expanded', 'false')
    await expect(record).toBeHidden()
    expect((await donations.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    await donations.click()
    await expect(donations).toHaveAttribute('aria-expanded', 'true')
    await expect(drawer.getByText('My recent gifts')).toBeVisible()
    await donations.click()
    await expect(record).toBeHidden()
    await donations.click()
    await record.click()
    await expect(page).toHaveURL(`/t/${slug}/gifts/new`)
    await expect(drawer).toBeHidden()
    // The page's own autofocus wins: the donor search, not the Menu button.
    await expect(page.getByRole('combobox', { name: 'Donor' })).toBeFocused()
    await unlocked(page)
    // On a donations page the section opens by itself.
    await menu.click()
    await expect(donations).toHaveAttribute('aria-expanded', 'true')
    await page.keyboard.press('Escape')
    await expect(drawer).toBeHidden()

    // The drawer's link took the drawer's place in history: one back
    // returns to Contacts.
    await page.goBack()
    await expect(page).toHaveURL(`/t/${slug}/contacts`)

    // From md up, the desktop header as before.
    await page.setViewportSize({ width: 1280, height: 800 })
    await expect(menu).toBeHidden()
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible()
  },
)

test(
  'phone: back, Esc, the overlay and Close each close the drawer and stay on the page',
  { annotation: [HOME, CONTACTS] },
  async ({ page, users }) => {
    // On keep-qc the overlay step failed 4 times in 9 runs (2026-11-01/02):
    // the drawer stayed open after the overlay press, with nothing pending
    // and no console output; locally it never fails (CI's Chromium, 60 to
    // 300 ms on every request, CPU slowed 6x, the whole suite, the press
    // 0 to 120 ms after opening). So the page logs what the drawer and
    // its history entry do, and a failure's `console` attachment
    // (qc/fixtures.ts) shows whether the press reached the overlay, and
    // which pushes, backs and pops came when. It showed the press reached
    // the overlay before Radix listened for it (the 'overlay' closer).
    await page.addInitScript(traceDrawer)
    await page.setViewportSize(PHONE)
    const slug = users.a.slug
    const { menu, drawer } = parts(page)
    await page.goto(`/t/${slug}`)
    await page.goto(`/t/${slug}/contacts`)
    const closers: Array<[string, () => Promise<void>]> = [
      ['back', () => page.goBack().then(() => {})],
      ['Esc', () => page.keyboard.press('Escape')],
      // The overlay, to the right of the drawer, once the drawer has slid
      // in, as a person sees it. Radix starts listening for presses
      // outside the drawer in a 0 ms timer after it mounts, and a busy
      // main thread runs input ahead of timers, so a press a few ms after
      // mounting is ignored: on keep-qc it came 7 ms after (runs
      // 41380822567, 41812124166) and the drawer stayed open. No person
      // taps that fast. Back and Esc keep racing the opening on purpose.
      [
        'overlay',
        async () => {
          await slidIn(drawer)
          await page.mouse.click(PHONE.width - 20, PHONE.height / 2)
        },
      ],
      [
        'Close',
        () => drawer.getByRole('button', { name: 'Close menu' }).click(),
      ],
    ]
    for (const [how, close] of closers) {
      await menu.click()
      await expect(drawer, how).toBeVisible()
      await close()
      await expect(drawer, how).toBeHidden()
      await expect(page, how).toHaveURL(`/t/${slug}/contacts`)
      await expect(menu, how).toBeFocused()
      await unlocked(page)
    }
    // Every closing unwound the drawer's entry: one back leaves Contacts
    // for the page before it.
    await page.goBack()
    await expect(page).toHaveURL(`/t/${slug}`)
  },
)

test(
  'phone: back with the drawer open over unsaved work closes it without asking',
  { annotation: [NEW_GIFT] },
  async ({ page, users }) => {
    await page.setViewportSize(PHONE)
    const slug = users.a.slug
    const { menu, drawer, leave, donations } = parts(page)
    // In the app, so the way back is the router's (a page load's isn't).
    await page.goto(`/t/${slug}/contacts`)
    await menu.click()
    await donations.click()
    await drawer.getByRole('link', { name: 'Record a gift' }).click()
    await page.getByLabel('Amount (£)').fill('5')
    await menu.click()
    await expect(drawer).toBeVisible()
    await page.goBack()
    await expect(drawer).toBeHidden()
    await expect(leave).toBeHidden()
    await expect(page).toHaveURL(`/t/${slug}/gifts/new`)
    await expect(page.getByLabel('Amount (£)')).toHaveValue('5')
    // The next back leaves the page, and the guard asks as before.
    await page.goBack()
    await expect(leave).toContainText('unsaved changes')
    await leave.getByRole('button', { name: 'Stay' }).click()
    await expect(page).toHaveURL(`/t/${slug}/gifts/new`)
    // A drawer link away from it asks too, over the closed drawer.
    await menu.click()
    await drawer.getByRole('link', { name: 'Contacts' }).click()
    await expect(leave).toContainText('unsaved changes')
    await leave.getByRole('button', { name: 'Leave anyway' }).click()
    await expect(page).toHaveURL(`/t/${slug}/contacts`)
    await unlocked(page)
  },
)

// Gift Aid claims G3: the drawer's Gift Aid claims, admins only, as the
// header's; declaration scans: its scans entries, for staff too.
test(
  'phone: the drawer goes to Gift Aid claims for an admin; staff have only the scans',
  {
    annotation: [{ type: 'route', description: '/t/$slug/giftaid/' }],
  },
  async ({ page, users, browser, baseURL, session }) => {
    await page.setViewportSize(PHONE)
    const slug = users.a.slug
    const { menu, drawer } = parts(page)
    await page.goto(`/t/${slug}/contacts`)
    await menu.click()
    await drawer.getByRole('link', { name: 'Claims' }).click()
    await expect(page).toHaveURL(`/t/${slug}/giftaid`)
    await expect(
      page.getByRole('heading', { level: 1, name: 'Gift Aid claims' }),
    ).toBeVisible()
    await expect(drawer).toBeHidden()
    await unlocked(page)

    const staff = await browser.newPage({
      baseURL,
      storageState: await session(users.staff),
      viewport: PHONE,
    })
    try {
      const other = parts(staff)
      await staff.goto(`/t/${users.staff.slug}/contacts`)
      await other.menu.click()
      await expect(
        other.drawer.getByRole('link', { name: 'Contacts' }),
      ).toBeVisible()
      // Staff get Gift Aid's scans, not its claims.
      await expect(
        other.drawer.getByRole('link', { name: 'Scans to match' }),
      ).toBeVisible()
      await expect(
        other.drawer.getByRole('link', { name: 'Claims' }),
      ).toHaveCount(0)
    } finally {
      await staff.context().close()
    }
  },
)
