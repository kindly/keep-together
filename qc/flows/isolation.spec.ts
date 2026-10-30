import { sessionCookie, sessionToken, expect, test } from '../fixtures'
import { runId } from '../timing'
import {
  contactForm,
  createContact,
  saved,
  secondTab,
  section,
  uniqueName,
} from './contact.helpers'
import {
  createClaims,
  daysAgo,
  donorGift,
  recordGift,
  recorder,
} from './gift.helpers'
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

  test("B's bank statements are not A's to open", async ({ page, users }) => {
    route(
      '/t/$slug/bank/',
      '/t/$slug/bank/import',
      '/t/$slug/bank/imports/$importId',
      '/t/$slug/settings/bank',
    )
    for (const path of [
      'bank',
      'bank/import',
      'bank/imports/0190f0c0a0b0c0d0e0f0a0b0c0d0e0f0',
      'settings/bank',
    ]) {
      await page.goto(`/t/${users.b.slug}/${path}`)
      await expect(
        page.getByText(`No group called “${users.b.slug}” that you belong to.`),
      ).toBeVisible()
      await expect(
        page.getByRole('heading', { name: /Bank statements|Bank accounts/ }),
      ).toHaveCount(0)
    }
  })

  test("B's settings are not A's to open", async ({ page, users }) => {
    route(
      '/t/$slug',
      '/t/$slug/settings',
      '/t/$slug/settings/groups',
      '/t/$slug/settings/hmrc',
    )
    for (const tab of ['settings', 'settings/groups', 'settings/hmrc']) {
      await page.goto(`/t/${users.b.slug}/${tab}`)
      await expect(
        page.getByText(`No group called “${users.b.slug}” that you belong to.`),
      ).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Settings' })).toHaveCount(
        0,
      )
    }
  })

  // The groups API answers about the caller across their groups, outside
  // the per-slug middleware: it must show A nothing of B's, and B's slug
  // must be as unknown there as anywhere. The switches are per group.
  test("A's groups and switches show none of B's, nor B's A's", async ({
    instance,
    users,
  }) => {
    const call = async (
      email: string,
      method: 'GET' | 'POST',
      path: string,
      body?: unknown,
    ) => {
      const token = await sessionToken(instance, email)
      const res = await fetch(`${instance.api}${path}`, {
        method,
        headers: {
          cookie: sessionCookie(instance, token),
          ...(body !== undefined && { 'content-type': 'application/json' }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      })
      return { status: res.status, json: (await res.json()) as unknown }
    }
    const mine = await call(users.a.email, 'GET', '/api/groups')
    expect(mine.status).toBe(200)
    expect((mine.json as Array<{ slug: string }>).map((g) => g.slug)).toEqual([
      users.a.slug,
    ])
    // B's slug: unknown to A's "opened", and A's to B's.
    for (const [email, slug] of [
      [users.a.email, users.b.slug],
      [users.b.email, users.a.slug],
    ]) {
      const res = await call(email, 'POST', `/api/groups/${slug}/opened`)
      expect([res.status, res.json]).toEqual([404, { kind: 'not_found' }])
    }
    // B's switches: refused to A whether read or written.
    for (const [method, path, body] of [
      ['GET', `/api/t/${users.b.slug}/preferences`, undefined],
      [
        'POST',
        `/api/t/${users.b.slug}/preferences/fields`,
        { staffCanManage: true },
      ],
    ] as const) {
      const res = await call(users.a.email, method, path, body)
      expect([res.status, res.json]).toEqual([403, { kind: 'forbidden' }])
    }
    const bPrefs = await call(
      users.b.email,
      'GET',
      `/api/t/${users.b.slug}/preferences`,
    )
    expect(bPrefs.json).toMatchObject({ fields: { staffCanManage: false } })
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

  test("B's gift is not A's to open, nor in A's panels", async ({
    page,
    users,
    world,
    instance,
  }) => {
    route('/t/$slug', '/t/$slug/gifts/$giftId', '/t/$slug/contacts/$contactId')
    const asB = await recorder(instance, users.b, world.tenants[1].tenantId)
    const id = await recordGift(asB, world.tenants[1].contactIds[0], 4321n)
    await page.goto(`/t/${users.a.slug}/gifts/${id}`)
    await expect(page.getByText('No such gift.')).toBeVisible()
    await expect(page.locator('body')).not.toContainText('£43.21')
    await expect(page.locator('body')).not.toContainText(`Bravo-${runId()}`)
    // A's own contact's Gifts panel lists none of B's.
    await page.goto(
      `/t/${users.a.slug}/contacts/${world.tenants[0].contactIds[0]}`,
    )
    // Loaded first (rows or "No gifts yet."), so the check isn't vacuous.
    const panel = section(page, 'Gifts')
    await expect(
      panel.getByRole('link').or(panel.getByText('No gifts yet.')).first(),
    ).toBeVisible()
    await expect(page.locator('body')).not.toContainText('£43.21')
  })

  test("B's Gift Aid claim is not A's to open, nor in A's list", async ({
    page,
    users,
    world,
    instance,
  }) => {
    route('/t/$slug/giftaid', '/t/$slug/giftaid/', '/t/$slug/giftaid/$claimId')
    const asB = await recorder(instance, users.b, world.tenants[1].tenantId)
    const day = daysAgo(1100)
    await donorGift(asB, `Bravo-${runId()}-claim`, 2500n, day)
    const [claim] = await createClaims(asB, day)
    await page.goto(`/t/${users.a.slug}/giftaid/${claim.id}`)
    await expect(page.getByText('No such claim.')).toBeVisible()
    await page.goto(`/t/${users.a.slug}/giftaid`)
    await expect(
      page
        .getByTestId('claim-row')
        .first()
        .or(page.getByText(/^No claims yet/)),
    ).toBeVisible()
    await expect(page.locator(`a[href$="/giftaid/${claim.id}"]`)).toHaveCount(0)
    await page.goto(`/t/${users.b.slug}/giftaid`)
    await expect(
      page.getByText(`No group called “${users.b.slug}” that you belong to.`),
    ).toBeVisible()
  })

  test("A's record-gift search finds none of B's contacts", async ({
    page,
    users,
  }) => {
    route('/t/$slug', '/t/$slug/gifts/new')
    await page.goto(`/t/${users.a.slug}/gifts/new`)
    await page.getByRole('combobox', { name: 'Donor' }).fill(`Bravo-${runId()}`)
    // Only the two "new" choices: no match from B.
    await expect(page.getByRole('option')).toHaveText([
      /^New person/,
      /^New organisation/,
    ])
    await expect(page.getByText('No contacts match.')).toBeVisible()
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

  test("A lands in A's group, and Switch group lists only it", async ({
    page,
    users,
  }) => {
    route('/', '/t/$slug/', '/t/$slug/settings/groups')
    await page.goto('/')
    await expect(page).toHaveURL(`/t/${users.a.slug}`)
    await page.goto(`/t/${users.a.slug}/settings/groups`)
    await expect(page.getByRole('listitem')).toHaveCount(1)
    await expect(page.getByRole('listitem')).toContainText(users.a.slug)
    await expect(page.locator('body')).not.toContainText(users.b.slug)
    await expect(page.locator('body')).not.toContainText('Bravo')
  })
})
