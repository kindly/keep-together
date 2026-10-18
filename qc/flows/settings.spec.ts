import { expect, test } from '../fixtures'
import { secondTab, section, uniqueName, want } from './contact.helpers'
import type { Page } from '@playwright/test'

// Settings (external-ids X4a): the admin-only identifier types page
// (create, rename, archive / reactivate) and the "Settings" nav link. User
// A is an admin of tenant A. No types are seeded, and the world is shared
// by every test in a worker, so each test makes its own types.

const IDENTIFIERS_ROUTE = {
  type: 'route',
  description: '/t/$slug/settings/identifiers',
}

const identifiersPath = (slug: string) => `/t/${slug}/settings/identifiers`

/** The page's row for a type. */
const typeRow = (page: Page, name: string) =>
  page.locator('main li').filter({ has: page.getByText(name, { exact: true }) })

// ── in-page predicates (serialised: no closures, no imports) ──────────────

/** The page lists a type named window.__qcWant. */
function typeListed() {
  const w = (window as unknown as { __qcWant?: string }).__qcWant
  return [...document.querySelectorAll('main li span')].some(
    (s) => s.textContent === w,
  )
}

/** The row for `name` has a button reading window.__qcWant. */
function typeRowButtonIsWant(name: string) {
  const w = (window as unknown as { __qcWant?: string }).__qcWant
  return [...document.querySelectorAll('main li')].some(
    (li) =>
      [...li.querySelectorAll('span')].some((s) => s.textContent === name) &&
      [...li.querySelectorAll('button')].some((b) => b.textContent === w),
  )
}

/** The identifier types page has loaded its list. */
function typesLoaded() {
  return (
    document.querySelector('main h1')?.textContent === 'Identifier types' &&
    [...document.querySelectorAll('main h2')].some(
      (h) => h.textContent === 'In use',
    )
  )
}

// ── specs ──────────────────────────────────────────────────────────────────

test.describe('identifier types', { annotation: IDENTIFIERS_ROUTE }, () => {
  test('an admin reaches the page from the Settings link', async ({
    page,
    flow,
    users,
  }) => {
    await page.goto(`/t/${users.a.slug}/contacts`)
    const settings = page.getByRole('link', { name: 'Settings', exact: true })
    const contacts = page.getByRole('link', { name: 'Contacts', exact: true })
    await flow(page, 'settings.nav', {
      before: async () => {
        if (!(await settings.isVisible()) || page.url().includes('/settings')) {
          await contacts.click()
          await expect(page.getByRole('searchbox')).toBeVisible()
        }
      },
      action: () => settings.click(),
      until: typesLoaded,
    })
    await expect(page).toHaveURL(identifiersPath(users.a.slug))
  })

  test('create, rename, archive and reactivate', async ({
    page,
    flow,
    users,
  }) => {
    await page.goto(identifiersPath(users.a.slug))
    await expect(
      page.getByRole('heading', { name: 'Identifier types' }),
    ).toBeVisible()
    const name = page.getByLabel('New identifier type')
    const create = page.getByRole('button', { name: 'Create type' })
    await expect(create).toBeDisabled()

    const base = uniqueName('idtype')
    let n = 0
    await flow(page, 'settings.identifierTypes.create', {
      before: async () => {
        const next = `${base}-${++n}`
        await name.fill(next)
        await want(page, next)
      },
      action: () => create.click(),
      until: typeListed,
    })
    await expect(name).toHaveValue('')

    // Names are unique per tenant: trimmed, case-insensitive.
    await name.fill(`  ${base.toUpperCase()}-1 `)
    await create.click()
    await expect(page.getByRole('alert')).toHaveText(
      `An identifier type called ${base}-1 exists`,
    )
    await name.fill('')

    let current = `${base}-1`
    let r = 0
    await flow(page, 'settings.identifierTypes.rename', {
      before: async () => {
        await typeRow(page, current)
          .getByRole('button', { name: 'rename' })
          .click()
        current = `${base}-renamed-${++r}`
        await page.getByLabel(/^Rename /).fill(current)
        await want(page, current)
      },
      action: () =>
        page.getByRole('button', { name: 'Save', exact: true }).click(),
      until: typeListed,
    })

    const row = () => typeRow(page, current)
    const toggle = () =>
      row().getByRole('button', { name: /^(archive|reactivate)$/ })
    await flow(page, 'settings.identifierTypes.archive', {
      before: async () => {
        const label = await toggle().textContent()
        await want(page, label === 'archive' ? 'reactivate' : 'archive')
      },
      action: () => toggle().click(),
      until: typeRowButtonIsWant,
      arg: current,
    })

    // Archived types sit apart, and come back on reactivate.
    if ((await toggle().textContent()) === 'archive') await toggle().click()
    const archived = section(page, 'Archived')
    await expect(archived.getByText(current, { exact: true })).toBeVisible()
    await archived
      .locator('li', { hasText: current })
      .getByRole('button', { name: 'reactivate' })
      .click()
    await expect(
      section(page, 'In use').getByText(current, { exact: true }),
    ).toBeVisible()
    // Still there after a reload: it was saved, not just shown.
    await page.reload()
    await expect(
      section(page, 'In use').getByText(current, { exact: true }),
    ).toBeVisible()
  })
})

test.describe('settings are for admins only', () => {
  for (const role of ['staff', 'viewer'] as const) {
    test(`${role}: no Settings link, and the page says admins only`, async ({
      browser,
      baseURL,
      session,
      users,
    }) => {
      test
        .info()
        .annotations.push(
          { type: 'route', description: '/t/$slug/contacts/' },
          IDENTIFIERS_ROUTE,
        )
      const user = users[role]
      const other = await secondTab(browser, baseURL!, await session(user))
      await other.goto(`/t/${user.slug}/contacts`)
      await expect(
        other.getByRole('link', { name: 'Contacts', exact: true }),
      ).toBeVisible()
      await expect(
        other.getByRole('link', { name: 'Tags', exact: true }),
      ).toBeVisible()
      await expect(
        other.getByRole('link', { name: 'Settings', exact: true }),
      ).toHaveCount(0)
      await other.goto(identifiersPath(user.slug))
      await expect(
        other.getByText('Only admins of this group can change its settings.'),
      ).toBeVisible()
      await expect(other.getByLabel('New identifier type')).toHaveCount(0)
      await other.context().close()
    })
  }
})
