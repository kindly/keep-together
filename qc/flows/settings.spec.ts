import { expect, test } from '../fixtures'
import { secondTab, section, uniqueName, want } from './contact.helpers'
import type { Page } from '@playwright/test'

// Settings: the tabbed layout every member reaches from the "Settings"
// nav link, and its admin-only Identifier types tab (external-ids X4a:
// create, rename, archive / reactivate). The Tags tab's own flows are in
// tags.spec.ts. User A is an admin of tenant A. No types are seeded, and
// the world is shared by every test in a worker, so each test makes its
// own types.

const IDENTIFIERS_ROUTE = {
  type: 'route',
  description: '/t/$slug/settings/identifiers',
}
const SETTINGS_ROUTE = { type: 'route', description: '/t/$slug/settings' }
const SETTINGS_INDEX_ROUTE = {
  type: 'route',
  description: '/t/$slug/settings/',
}
const TAGS_ROUTE = { type: 'route', description: '/t/$slug/settings/tags' }

const identifiersPath = (slug: string) => `/t/${slug}/settings/identifiers`
const tagsPath = (slug: string) => `/t/${slug}/settings/tags`

/** The settings tab bar. */
const tabs = (page: Page) =>
  page.getByRole('navigation', { name: 'Settings sections' })

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

/** The staff-lists switch is on when window.__qcWant is 'on'. */
function switchIsWant() {
  const w = (window as unknown as { __qcWant?: string }).__qcWant
  const s = document.querySelector<HTMLInputElement>('input[role="switch"]')
  return s !== null && s.checked === (w === 'on')
}

/** The settings tab headed window.__qcWant has loaded its list. */
function tabLoaded() {
  const w = (window as unknown as { __qcWant?: string }).__qcWant
  return (
    document.querySelector('main h2')?.textContent === w &&
    [...document.querySelectorAll('main h3')].some(
      (h) => h.textContent === 'In use',
    )
  )
}

// ── specs ──────────────────────────────────────────────────────────────────

test.describe('settings tabs', () => {
  test('an admin reaches Settings from the nav, and switches tabs', async ({
    page,
    flow,
    users,
  }) => {
    test
      .info()
      .annotations.push(
        SETTINGS_ROUTE,
        SETTINGS_INDEX_ROUTE,
        TAGS_ROUTE,
        IDENTIFIERS_ROUTE,
      )
    await page.goto(`/t/${users.a.slug}/contacts`)
    const settings = page.getByRole('link', { name: 'Settings', exact: true })
    const contacts = page.getByRole('link', { name: 'Contacts', exact: true })
    await want(page, 'Tags')
    // The link opens the first tab, Tags.
    await flow(page, 'settings.nav', {
      before: async () => {
        if (page.url().includes('/settings')) {
          await contacts.click()
          await expect(page.getByRole('searchbox')).toBeVisible()
        }
      },
      action: () => settings.click(),
      until: tabLoaded,
    })
    await expect(page).toHaveURL(tagsPath(users.a.slug))

    const tagsTab = tabs(page).getByRole('link', { name: 'Tags' })
    const typesTab = tabs(page).getByRole('link', { name: 'Identifier types' })
    await expect(tagsTab).toHaveAttribute('aria-current', 'page')
    await expect(typesTab).not.toHaveAttribute('aria-current', 'page')

    let to = 'Tags'
    await flow(page, 'settings.tab', {
      before: async () => {
        to = to === 'Tags' ? 'Identifier types' : 'Tags'
        await want(page, to)
      },
      action: () => (to === 'Tags' ? tagsTab : typesTab).click(),
      until: tabLoaded,
    })
    await typesTab.click()
    await expect(page).toHaveURL(identifiersPath(users.a.slug))
    await expect(typesTab).toHaveAttribute('aria-current', 'page')
  })
})

test.describe('identifier types', { annotation: IDENTIFIERS_ROUTE }, () => {
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

test.describe('settings for staff and viewers', () => {
  for (const role of ['staff', 'viewer'] as const) {
    test(`${role}: only the Tags tab, and Identifier types says admins only`, async ({
      browser,
      baseURL,
      session,
      users,
    }) => {
      test
        .info()
        .annotations.push(
          { type: 'route', description: '/t/$slug/contacts/' },
          SETTINGS_ROUTE,
          SETTINGS_INDEX_ROUTE,
          TAGS_ROUTE,
          IDENTIFIERS_ROUTE,
        )
      const user = users[role]
      const other = await secondTab(browser, baseURL!, await session(user))
      await other.goto(`/t/${user.slug}/contacts`)
      await expect(
        other.getByRole('link', { name: 'Tags', exact: true }),
      ).toHaveCount(0)
      await other.getByRole('link', { name: 'Settings', exact: true }).click()
      await other.waitForURL(new RegExp(`${tagsPath(user.slug)}$`))
      await expect(tabs(other).getByRole('link')).toHaveText(['Tags'])
      await expect(
        other.locator('main li', { hasText: 'Member' }),
      ).toBeVisible()
      // Read-only: staff manage lists only when an admin allows it (off
      // here), viewers never; neither sees the switch.
      await expect(other.getByLabel('New tag name')).toHaveCount(0)
      await expect(
        other.locator('main li', { hasText: 'Member' }).getByRole('button'),
      ).toHaveCount(0)
      await expect(other.getByRole('switch')).toHaveCount(0)

      await other.goto(identifiersPath(user.slug))
      await expect(
        other.getByText('Only admins of this group can change its settings.'),
      ).toBeVisible()
      await expect(other.getByLabel('New identifier type')).toHaveCount(0)
      await other.context().close()
    })
  }
})

test.describe('staff can manage lists', () => {
  test('the admin switch opens tags and identifier types to staff, live', async ({
    page,
    browser,
    baseURL,
    flow,
    session,
    users,
  }) => {
    test.info().annotations.push(SETTINGS_ROUTE, TAGS_ROUTE, IDENTIFIERS_ROUTE)
    const label = 'Staff can manage tags and identifier types'
    await page.goto(tagsPath(users.a.slug))
    const sw = page.getByRole('switch', { name: label })
    // The tenant is shared by the worker's tests: it starts, and is left, off.
    await expect(sw).not.toBeChecked()
    const staff = await secondTab(browser, baseURL!, await session(users.staff))
    try {
      await staff.goto(tagsPath(users.staff.slug))
      await expect(
        staff.locator('main li', { hasText: 'Member' }),
      ).toBeVisible()
      await expect(staff.getByLabel('New tag name')).toHaveCount(0)

      // The input is visually hidden; its label takes the (trusted) click.
      const toggle = page.getByText(label, { exact: true })
      await flow(page, 'settings.staffLists.toggle', {
        before: async () => want(page, (await sw.isChecked()) ? 'off' : 'on'),
        action: () => toggle.click(),
        until: switchIsWant,
      })
      if (!(await sw.isChecked())) await toggle.click()
      await expect(sw).toBeChecked()

      // Staff's open page follows: both lists become theirs to manage.
      await expect(tabs(staff).getByRole('link')).toHaveText([
        'Tags',
        'Identifier types',
      ])
      const tag = uniqueName('staff-tag')
      await staff.getByLabel('New tag name').fill(tag)
      await staff.getByRole('button', { name: 'Create tag' }).click()
      await expect(staff.locator('main li', { hasText: tag })).toBeVisible()
      await tabs(staff).getByRole('link', { name: 'Identifier types' }).click()
      const type = uniqueName('staff-type')
      await staff.getByLabel('New identifier type').fill(type)
      await staff.getByRole('button', { name: 'Create type' }).click()
      await expect(staff.locator('main li', { hasText: type })).toBeVisible()

      // Off again: the open identifier types page says admins only.
      await toggle.click()
      await expect(sw).not.toBeChecked()
      await expect(
        staff.getByText('Only admins of this group can change its settings.'),
      ).toBeVisible()
      await expect(tabs(staff).getByRole('link')).toHaveText(['Tags'])
    } finally {
      if (await sw.isChecked()) {
        await page.getByText(label, { exact: true }).click()
        await expect(sw).not.toBeChecked()
      }
      await staff.context().close()
    }
  })
})
