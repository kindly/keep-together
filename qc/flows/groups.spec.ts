import { expect, test } from '../fixtures'
import { runId } from '../timing'

// Groups (factory/plans/qc-suite.sv, step 6): the list, the link into a
// group's contacts (timed: `groups.open`), and a slug that isn't yours.
// Signed in as user A. A user with no group is covered by sign-up
// (auth.spec.ts), since every seeded user owns one.

function route(...ids: Array<string>) {
  test
    .info()
    .annotations.push(
      ...ids.map((description) => ({ type: 'route', description })),
    )
}

test('the groups list shows your group, its slug and your role', async ({
  page,
  users,
}) => {
  route('/')
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Your groups' })).toBeVisible()
  const item = page.getByRole('listitem')
  await expect(item).toHaveCount(1)
  await expect(item).toContainText(`Alpha r${runId()}`)
  // The role's name changes with auth-roles R1 ('owner' → 'admin').
  await expect(item).toContainText(
    new RegExp(`${users.a.slug} · (owner|admin)`),
  )
})

test('a group links to its contacts', async ({ page, flow, users }) => {
  route('/', '/t/$slug', '/t/$slug/contacts/')
  const link = page.locator(`a[href="/t/${users.a.slug}/contacts"]`)
  await flow(page, 'groups.open', {
    before: async () => {
      await page.goto('/')
      await expect(link).toBeVisible()
    },
    action: () => link.click(),
    until: (name) => document.body.innerText.includes(name),
    arg: `Alpha-${runId()}`,
  })
  await expect(page).toHaveURL(`/t/${users.a.slug}/contacts`)
  await expect(page.getByRole('heading', { name: 'Contacts' })).toBeVisible()
  await page.getByRole('link', { name: 'keep-together' }).click()
  await expect(page.getByRole('heading', { name: 'Your groups' })).toBeVisible()
})

test('an unknown slug says there is no such group', async ({ page }) => {
  route('/t/$slug', '/t/$slug/contacts/')
  const slug = `nope-${runId()}`
  await page.goto(`/t/${slug}/contacts`)
  await expect(
    page.getByText(`No group called “${slug}” that you belong to.`),
  ).toBeVisible()
  await page.getByRole('link', { name: 'Your groups' }).click()
  await expect(page.getByRole('heading', { name: 'Your groups' })).toBeVisible()
})
