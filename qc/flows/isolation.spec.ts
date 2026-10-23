import { expect, test } from '../fixtures'
import { runId } from '../timing'
import {
  contactForm,
  createContact,
  saved,
  secondTab,
  section,
  uniqueName,
} from './contact.helpers'
import type { Page } from '@playwright/test'

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

  // A's field flows are fields.spec.ts. A has a seeded field and B none,
  // so B's own field tab and list show none of A's.
  test("B's fields are not A's to open, nor A's B's", async ({
    page,
    browser,
    baseURL,
    session,
    users,
    world,
  }) => {
    route('/t/$slug', '/t/$slug/settings/fields', '/t/$slug/contacts/')
    const { label } = world.field
    await page.goto(`/t/${users.a.slug}/settings/fields`)
    await expect(
      page.getByTestId('field').filter({ hasText: label }),
    ).toBeVisible()
    await page.goto(`/t/${users.b.slug}/settings/fields`)
    await expect(
      page.getByText(`No group called “${users.b.slug}” that you belong to.`),
    ).toBeVisible()
    await expect(page.getByLabel('New field')).toHaveCount(0)

    const b = await secondTab(browser, baseURL!, await session(users.b))
    await b.goto(`/t/${users.b.slug}/settings/fields`)
    await expect(b.getByText('No fields yet.')).toBeVisible()
    await expect(b.getByTestId('field')).toHaveCount(0)
    await b.goto(`/t/${users.b.slug}/contacts`)
    await expect(b.locator('main ul li a').first()).toBeVisible()
    await expect(b.getByLabel(`Filter by ${label}`)).toHaveCount(0)
    await b.context().close()
  })

  test("A's source codes show none of B's", async ({ page, users }) => {
    route('/t/$slug', '/t/$slug/settings/sources')
    await page.goto(`/t/${users.a.slug}/settings/sources`)
    // A's own seeded detail is there, so the tree has loaded.
    await expect(
      page.locator('main li code').getByText(`Street-Alpha${runId()}`, {
        exact: true,
      }),
    ).toBeVisible()
    await expect(page.locator('body')).not.toContainText('Bravo')
    await page.goto(`/t/${users.b.slug}/settings/sources`)
    await expect(
      page.getByText(`No group called “${users.b.slug}” that you belong to.`),
    ).toBeVisible()
    await expect(page.locator('body')).not.toContainText('Bravo')
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

    const search = page.getByRole('searchbox')
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

  /**
   * Search `slug`'s list for each value and check no result is one of
   * `foreign`'s contacts (and `foreignLabel` never shows). Between values
   * it goes back to `shared`, whose one result is `own`, so the next
   * result has arrived once `own` is gone (no value here matches it).
   * Asserts on ids, not "No contacts yet.": another test may leave its
   * own contact holding one of the values in this group.
   */
  async function searchShowsNoneOf(
    page: Page,
    slug: string,
    shared: string,
    own: string,
    foreign: Array<string>,
    foreignLabel: string,
    values: Array<string>,
  ) {
    await page.goto(`/t/${slug}/contacts`)
    const links = page.locator('main ul li a')
    const ownLink = page.locator(`main a[href="/t/${slug}/contacts/${own}"]`)
    const noneForeign = async () => {
      await expect(page.locator('body')).not.toContainText(foreignLabel)
      for (const id of foreign) {
        await expect(page.locator(`a[href$="/contacts/${id}"]`)).toHaveCount(0)
      }
    }
    const search = page.getByRole('searchbox')
    // A value both groups hold: only this group's own contact.
    await search.fill(shared)
    await expect(links).toHaveCount(1)
    await expect(ownLink).toBeVisible()
    await noneForeign()
    for (const value of values) {
      await search.fill(value)
      await expect(ownLink).toHaveCount(0)
      await noneForeign()
      await search.fill(shared)
      await expect(links).toHaveCount(1)
      await expect(ownLink).toBeVisible()
    }
  }

  test("B's identifiers are not found from A", async ({
    page,
    users,
    world,
  }) => {
    route('/t/$slug/contacts/')
    const { shared, bOnly, bReuse } = world.identifiers
    const [tenantA, tenantB] = world.tenants
    await searchShowsNoneOf(
      page,
      users.a.slug,
      shared,
      tenantA.contactIds[0],
      tenantB.contactIds,
      'Bravo',
      [bOnly, bReuse],
    )
  })

  test("A's identifier is not found from B", async ({
    browser,
    baseURL,
    session,
    users,
    world,
  }) => {
    route('/t/$slug/contacts/')
    const [tenantA, tenantB] = world.tenants
    const other = await secondTab(browser, baseURL!, await session(users.b))
    // `shared` is the value A holds; B's own Ada holds it too, so B finds
    // exactly that one, never A's.
    await searchShowsNoneOf(
      other,
      users.b.slug,
      world.identifiers.shared,
      tenantB.contactIds[0],
      tenantA.contactIds,
      'Alpha',
      [],
    )
    await other.context().close()
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
    // Removed so a rerun in this worker doesn't clash with its own row.
    // Nothing else relies on it: the searches check ids, not emptiness.
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
