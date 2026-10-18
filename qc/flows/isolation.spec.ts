import { expect, test } from '../fixtures'
import { runId } from '../timing'

// The mandatory isolation spec (factory/plans/qc-suite.sv, "Isolation";
// CLAUDE.md rule 6). Signed in as user A, who belongs to tenant A only;
// tenant B and its `Bravo-<run>` contacts must never show through any
// route A can reach.

function route(...ids: Array<string>) {
  test
    .info()
    .annotations.push(
      ...ids.map((description) => ({ type: 'route', description })),
    )
}

test.describe('isolation', () => {
  test("B's group is not a group A can open", async ({ page, users }) => {
    route('/t/$slug', '/t/$slug/contacts/')
    await page.goto(`/t/${users.b.slug}/contacts`)
    await expect(
      page.getByText(`No group called “${users.b.slug}” that you belong to.`),
    ).toBeVisible()
    await expect(page.locator('body')).not.toContainText(`Bravo`)
  })

  test("B's settings are not A's to open", async ({ page, users }) => {
    route('/t/$slug', '/t/$slug/settings/identifiers')
    await page.goto(`/t/${users.b.slug}/settings/identifiers`)
    await expect(
      page.getByText(`No group called “${users.b.slug}” that you belong to.`),
    ).toBeVisible()
    await expect(page.getByLabel('New identifier type')).toHaveCount(0)
  })

  test("B's contact is not in A's group", async ({ page, users, world }) => {
    route('/t/$slug', '/t/$slug/contacts/$contactId')
    for (const id of world.tenants[1].contactIds) {
      await page.goto(`/t/${users.a.slug}/contacts/${id}`)
      await expect(page.getByText('No such contact.')).toBeVisible()
      await expect(page.locator('body')).not.toContainText(`Bravo-${runId()}`)
    }
  })

  test("A's list and search show none of B's contacts", async ({
    page,
    users,
    world,
  }) => {
    route('/t/$slug', '/t/$slug/contacts/')
    await page.goto(`/t/${users.a.slug}/contacts`)
    const rows = page.getByRole('main').getByRole('listitem')
    // One of A's seeded contacts is there, so the list has loaded. (Not
    // all of them: other specs may archive one for a moment.)
    await expect(
      rows.filter({ hasText: `Alpha-${runId()}` }).first(),
    ).toBeVisible()
    await expect(page.locator('body')).not.toContainText('Bravo')
    for (const id of world.tenants[1].contactIds) {
      await expect(page.locator(`a[href$="/contacts/${id}"]`)).toHaveCount(0)
    }

    const search = page.getByRole('searchbox', { name: 'Search contacts' })
    const empty = page.getByText('No contacts match.')
    const noneOfB = async () => {
      await expect(page.locator('body')).not.toContainText('Bravo')
      for (const id of world.tenants[1].contactIds) {
        await expect(page.locator(`a[href$="/contacts/${id}"]`)).toHaveCount(0)
      }
    }

    // B's own name, alone: nothing in A matches, so the list empties.
    await search.fill('Bravo')
    await expect(empty).toBeVisible()
    await noneOfB()

    // `Bravo-<run>` is two search tokens, and `<run>` matches A's own
    // contacts, so the result may hold A's rows. Start from a one-row
    // result ("Ada") so we can tell when the new result has arrived.
    await search.fill('Ada')
    await expect(rows).toHaveCount(1)
    await expect(rows).toContainText('Ada')
    for (const archived of [false, true]) {
      await page.getByLabel('show archived').setChecked(archived)
      await search.fill(`Bravo-${runId()}`)
      await expect(async () => {
        expect((await empty.isVisible()) || (await rows.count()) > 1).toBe(true)
      }).toPass()
      await noneOfB()
      await search.fill('Ada')
      await expect(rows).toHaveCount(1)
    }
  })

  test("A's groups list shows only A's group", async ({ page, users }) => {
    route('/')
    await page.goto('/')
    await expect(
      page.getByRole('heading', { name: 'Your groups' }),
    ).toBeVisible()
    const links = page.locator('a[href^="/t/"]')
    await expect(links).toHaveCount(1)
    await expect(links).toHaveAttribute('href', `/t/${users.a.slug}/contacts`)
    await expect(page.locator('body')).not.toContainText(users.b.slug)
    await expect(page.locator('body')).not.toContainText('Bravo')
  })
})
