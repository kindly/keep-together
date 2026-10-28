import { expect, test } from '../fixtures'

// The phone header (below md): the Menu button opens a drawer from the
// left with every destination; a link in it navigates and closes it.
// Untimed: it reaches the same pages the desktop flows already time.

const HOME = { type: 'route', description: '/t/$slug/' }
const CONTACTS = { type: 'route', description: '/t/$slug/contacts/' }
const NEW_GIFT = { type: 'route', description: '/t/$slug/gifts/new' }

test(
  'phone: the drawer goes to Contacts, then to Record a gift',
  { annotation: [HOME, CONTACTS, NEW_GIFT] },
  async ({ page, users }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    const slug = users.a.slug
    await page.goto(`/t/${slug}`)
    const menu = page.getByRole('button', { name: 'Menu' })
    const drawer = page.getByRole('dialog')
    await expect(menu).toBeVisible()
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden()
    const box = (await menu.boundingBox())!
    expect(box.width).toBeGreaterThanOrEqual(44)
    expect(box.height).toBeGreaterThanOrEqual(44)

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
    await expect(menu).toBeFocused()

    await menu.click()
    await expect(
      drawer.getByRole('link', { name: 'Contacts' }),
    ).toHaveAttribute('aria-current', 'page')
    await drawer.getByRole('link', { name: 'Record a gift' }).click()
    await expect(page).toHaveURL(`/t/${slug}/gifts/new`)
    await expect(
      page.getByRole('heading', { level: 1, name: 'Record a gift' }),
    ).toBeVisible()
    await expect(drawer).toBeHidden()

    // Esc closes it; the back gesture leaves it closed.
    await menu.click()
    await expect(drawer).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(drawer).toBeHidden()
    await expect(menu).toBeFocused()
    await menu.click()
    await page.goBack()
    await expect(page).toHaveURL(`/t/${slug}/contacts`)
    await expect(drawer).toBeHidden()

    // From md up, the desktop header as before.
    await page.setViewportSize({ width: 1280, height: 800 })
    await expect(menu).toBeHidden()
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible()
  },
)
