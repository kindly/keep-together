import { expect, test } from '../fixtures'
import { runId } from '../timing'
import {
  contactForm,
  createContact,
  saved,
  section,
  uniqueName,
} from './contact.helpers'

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

    const search = page.getByPlaceholder('Search by name')
    const empty = page.getByText('No contacts yet.')
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

  test("B's identifiers are not found from A", async ({
    page,
    users,
    world,
  }) => {
    route('/t/$slug/contacts/')
    const { shared, bOnly, bReuse } = world.identifiers
    await page.goto(`/t/${users.a.slug}/contacts`)
    const rows = page.getByRole('main').getByRole('listitem')
    const search = page.getByPlaceholder('Search by name')
    const ada = `/t/${users.a.slug}/contacts/${world.tenants[0].contactIds[0]}`
    // A value both groups hold: only A's own contact.
    await search.fill(shared)
    await expect(rows).toHaveCount(1)
    await expect(page.locator('main ul li a')).toHaveAttribute('href', ada)
    // Values only B holds: nothing. (Back to `shared` between them, so we
    // can tell when each new result has arrived.)
    for (const value of [bOnly, bReuse]) {
      await search.fill(value)
      await expect(page.getByText('No contacts yet.')).toBeVisible()
      await expect(page.locator('body')).not.toContainText('Bravo')
      await search.fill(shared)
      await expect(rows).toHaveCount(1)
    }
  })

  test('a value B holds saves in A without a clash', async ({
    page,
    users,
    world,
  }) => {
    route('/t/$slug/contacts/$contactId')
    const { bReuse } = world.identifiers
    await createContact(page, users.a.slug, uniqueName('noclash'))
    const identifiers = section(page, 'Identifiers')
    await identifiers.getByRole('button', { name: 'add' }).click()
    const row = identifiers.locator('ul > li').last()
    await row
      .getByLabel('Identifier type')
      .selectOption({ label: world.identifierType })
    await row.getByLabel('Identifier value').fill(bReuse)
    await row.getByLabel('Identifier value').press('Tab')
    await expect(identifiers.getByText(bReuse, { exact: true })).toBeVisible()
    await expect(saved(page)).toBeVisible()
    await expect(contactForm(page).getByText(/to fix/)).toHaveCount(0)
    await expect(page.locator('body')).not.toContainText('Bravo')
    // Put it back: the isolation search above expects A to hold none.
    await identifiers
      .getByRole('button', { name: `remove identifier ${bReuse}` })
      .click()
    await expect(identifiers.getByText('No identifiers.')).toBeVisible()
    await expect(saved(page)).toBeVisible()
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
