import { expect, test } from '../fixtures'
import type { Page } from '@playwright/test'

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
})
/** The page behind can scroll again (the drawer's scroll lock is gone). */
const unlocked = (page: Page) =>
  expect(page.locator('body')).not.toHaveAttribute('data-scroll-locked')

test(
  'phone: the drawer goes to Contacts, then to Record a gift',
  { annotation: [HOME, CONTACTS, NEW_GIFT] },
  async ({ page, users }) => {
    await page.setViewportSize(PHONE)
    const slug = users.a.slug
    const { menu, drawer } = parts(page)
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
    await drawer.getByRole('link', { name: 'Record a gift' }).click()
    await expect(page).toHaveURL(`/t/${slug}/gifts/new`)
    await expect(drawer).toBeHidden()
    // The page's own autofocus wins: the donor search, not the Menu button.
    await expect(page.getByRole('combobox', { name: 'Donor' })).toBeFocused()
    await unlocked(page)

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
    await page.setViewportSize(PHONE)
    const slug = users.a.slug
    const { menu, drawer } = parts(page)
    await page.goto(`/t/${slug}`)
    await page.goto(`/t/${slug}/contacts`)
    const closers: Array<[string, () => Promise<void>]> = [
      ['back', () => page.goBack().then(() => {})],
      ['Esc', () => page.keyboard.press('Escape')],
      // The overlay, to the right of the drawer.
      ['overlay', () => page.mouse.click(PHONE.width - 20, PHONE.height / 2)],
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
    const { menu, drawer, leave } = parts(page)
    // In the app, so the way back is the router's (a page load's isn't).
    await page.goto(`/t/${slug}/contacts`)
    await menu.click()
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
