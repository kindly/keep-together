import { expect, test } from '../fixtures'
import { runId } from '../timing'

// Groups and navigation (factory/plans/qc-suite.sv, step 6; cash-gifts
// step 4): "/" lands in a group's home, never a list; the home's actions
// and the header (timed: `home.toContacts`); Settings →
// Switch group; and a slug that isn't yours. Signed in as user A. A user
// with no group is covered by sign-up (auth.spec.ts), since every seeded
// user owns one. Every seeded user has one group, so the Switch group tab
// itself (more than one group only) is a dom test (src/routes/-nav).

function route(...ids: Array<string>) {
  test
    .info()
    .annotations.push(
      ...ids.map((description) => ({ type: 'route', description })),
    )
}

test('"/" goes straight to your group’s home', async ({ page, users }) => {
  route('/', '/t/$slug', '/t/$slug/')
  await page.goto('/')
  await expect(page).toHaveURL(`/t/${users.a.slug}`)
  const name = `Alpha r${runId()}`
  await expect(page.getByRole('heading', { level: 1 })).toContainText(name)
  const header = page.getByRole('navigation', { name: 'Main' })
  await expect(header.getByRole('link', { name: /qc group/ })).toHaveAttribute(
    'href',
    `/t/${users.a.slug}`,
  )
  await expect(header.getByRole('link', { name: 'keep-together' })).toHaveCount(
    0,
  )
  await expect(
    header.getByRole('button', { name: 'Donations', exact: true }),
  ).toBeVisible()
  // No gifts yet: the giving backend is still a stub here.
  await expect(page.getByText('My recent gifts')).toBeVisible()
})

test('home links to contacts, and the group name leads back', async ({
  page,
  flow,
  users,
}) => {
  route('/t/$slug', '/t/$slug/', '/t/$slug/contacts/')
  const link = page.getByRole('link', { name: 'Find a contact' })
  await flow(page, 'home.toContacts', {
    before: async () => {
      await page.goto(`/t/${users.a.slug}`)
      await expect(link).toBeVisible()
    },
    action: () => link.click(),
    until: (name) => document.body.innerText.includes(name),
    arg: `Alpha-${runId()}`,
  })
  await expect(page).toHaveURL(`/t/${users.a.slug}/contacts`)
  await expect(page.getByRole('heading', { name: 'Contacts' })).toBeVisible()
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: /qc group/ })
    .click()
  await expect(page).toHaveURL(`/t/${users.a.slug}`)
  await page.getByRole('link', { name: 'New contact' }).click()
  await expect(page).toHaveURL(`/t/${users.a.slug}/contacts/new`)
})

test('the Donations menu offers Record a gift, not yet live', async ({
  page,
  users,
}) => {
  route('/t/$slug/')
  await page.goto(`/t/${users.a.slug}`)
  await page.getByRole('button', { name: 'Donations', exact: true }).click()
  const menu = page.getByRole('menu')
  await expect(
    menu.getByRole('menuitem', { name: /Record a gift/ }),
  ).toHaveAttribute('aria-disabled', 'true')
  await expect(menu.getByText('My recent gifts')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
})

test('Switch group lists your one group', async ({ page, users }) => {
  route('/t/$slug/settings/groups')
  await page.goto(`/t/${users.a.slug}/settings/tags`)
  // One group: no tab for it.
  await expect(page.getByRole('link', { name: 'Switch group' })).toHaveCount(0)
  await page.goto(`/t/${users.a.slug}/settings/groups`)
  await expect(
    page.getByRole('heading', { name: 'Switch group' }),
  ).toBeVisible()
  await expect(page.getByRole('listitem')).toHaveCount(1)
  await expect(page.getByRole('listitem')).toContainText('(this group)')
})

test('an unknown slug says there is no such group', async ({ page, users }) => {
  route('/t/$slug', '/t/$slug/contacts/')
  const slug = `nope-${runId()}`
  await page.goto(`/t/${slug}/contacts`)
  await expect(
    page.getByText(`No group called “${slug}” that you belong to.`),
  ).toBeVisible()
  await page.getByRole('link', { name: 'Go to your group' }).click()
  await expect(page).toHaveURL(`/t/${users.a.slug}`)
})
