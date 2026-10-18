import { expect, test } from '../fixtures'
import { secondTab, section, uniqueName, want } from './contact.helpers'
import type { Page } from '@playwright/test'

// Settings: the tabbed layout every member reaches from the "Settings"
// nav link (tabs in a column on the left, a scrollable row on a phone),
// its Identifier types tab (external-ids X4a: create, rename, archive /
// reactivate), and the two admin switches, one per tab, that open tags and
// identifier types to staff independently. The Tags tab's own flows are in
// tags.spec.ts. User A is an admin of tenant A. No types are seeded, and
// the world is shared by every test in a worker, so each test makes its
// own types, and leaves both switches off.

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

/** The switch labelled `label` is on when window.__qcWant is 'on'. */
function switchIsWant(label: string) {
  const w = (window as unknown as { __qcWant?: string }).__qcWant
  const s = [...document.querySelectorAll('label')]
    .find((l) => l.textContent === label)
    ?.querySelector<HTMLInputElement>('input[role="switch"]')
  return s != null && s.checked === (w === 'on')
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

    // Desktop: the tabs stand in a column left of the content.
    const heading = page.getByRole('heading', { name: 'Identifier types' })
    const box = async () => ({
      tags: (await tagsTab.boundingBox())!,
      types: (await typesTab.boundingBox())!,
      content: (await heading.boundingBox())!,
    })
    let b = await box()
    expect(b.types.y).toBeGreaterThan(b.tags.y)
    expect(b.types.x).toBe(b.tags.x)
    expect(b.content.x).toBeGreaterThanOrEqual(b.tags.x + b.tags.width)
    // Phone: one row above the content, and no page-wide horizontal scroll.
    await page.setViewportSize({ width: 375, height: 700 })
    b = await box()
    expect(b.types.y).toBe(b.tags.y)
    expect(b.types.x).toBeGreaterThan(b.tags.x)
    expect(b.content.y).toBeGreaterThanOrEqual(b.tags.y + b.tags.height)
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true)
    await page.setViewportSize({ width: 1280, height: 800 })
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
    test(`${role}: both tabs, read-only, no switches`, async ({
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
      await expect(tabs(other).getByRole('link')).toHaveText([
        'Tags',
        'Identifier types',
      ])
      await expect(
        other.locator('main li', { hasText: 'Member' }),
      ).toBeVisible()
      // Read-only: staff manage a list only when an admin allows it (both
      // off here), viewers never; neither sees the switches.
      await expect(other.getByLabel('New tag name')).toHaveCount(0)
      await expect(
        other.locator('main li', { hasText: 'Member' }).getByRole('button'),
      ).toHaveCount(0)
      await expect(other.getByRole('switch')).toHaveCount(0)

      await tabs(other).getByRole('link', { name: 'Identifier types' }).click()
      await expect(
        other.getByRole('heading', { name: 'In use', exact: true }),
      ).toBeVisible()
      await expect(other.getByLabel('New identifier type')).toHaveCount(0)
      await expect(other.locator('main li button')).toHaveCount(0)
      await expect(other.getByRole('switch')).toHaveCount(0)
      await other.context().close()
    })
  }
})

const SWITCHES = {
  tags: {
    label: 'Staff can manage tags',
    flow: 'settings.staffTags.toggle',
    path: tagsPath,
  },
  identifierTypes: {
    label: 'Staff can manage identifier types',
    flow: 'settings.staffIdentifierTypes.toggle',
    path: identifiersPath,
  },
} as const

test.describe('staff can manage lists, per list', () => {
  for (const kind of ['tags', 'identifierTypes'] as const) {
    const other = kind === 'tags' ? 'identifierTypes' : 'tags'
    test(`the ${kind} switch opens ${kind} alone to staff, live`, async ({
      page,
      browser,
      baseURL,
      flow,
      session,
      users,
    }) => {
      test
        .info()
        .annotations.push(SETTINGS_ROUTE, TAGS_ROUTE, IDENTIFIERS_ROUTE)
      const { label } = SWITCHES[kind]
      await page.goto(SWITCHES[kind].path(users.a.slug))
      const sw = page.getByRole('switch', { name: label })
      // Each tab carries only its own switch.
      await expect(page.getByRole('switch')).toHaveCount(1)
      // The tenant is shared by the worker's tests: it starts, and is left, off.
      await expect(sw).not.toBeChecked()
      const staff = await secondTab(
        browser,
        baseURL!,
        await session(users.staff),
      )
      // The input is visually hidden; its label takes the (trusted) click.
      const toggle = page.getByText(label, { exact: true })
      try {
        await staff.goto(tagsPath(users.staff.slug))
        await expect(
          staff.locator('main li', { hasText: 'Member' }),
        ).toBeVisible()
        await expect(staff.getByLabel('New tag name')).toHaveCount(0)

        await flow(page, SWITCHES[kind].flow, {
          before: async () => want(page, (await sw.isChecked()) ? 'off' : 'on'),
          action: () => toggle.click(),
          until: switchIsWant,
          arg: label,
        })
        if (!(await sw.isChecked())) await toggle.click()
        await expect(sw).toBeChecked()

        // Staff's open pages follow: this list becomes theirs, the other
        // stays read-only.
        const createIn = async (k: typeof kind) => {
          await tabs(staff)
            .getByRole('link', {
              name: k === 'tags' ? 'Tags' : 'Identifier types',
            })
            .click()
          return staff.getByLabel(
            k === 'tags' ? 'New tag name' : 'New identifier type',
          )
        }
        const input = await createIn(kind)
        const name = uniqueName(`staff-${kind}`)
        await input.fill(name)
        await staff
          .getByRole('button', {
            name: kind === 'tags' ? 'Create tag' : 'Create type',
          })
          .click()
        await expect(staff.locator('main li', { hasText: name })).toBeVisible()
        await expect(await createIn(other)).toHaveCount(0)

        // Off again: the open page goes read-only.
        await createIn(kind)
        await toggle.click()
        await expect(sw).not.toBeChecked()
        await expect(
          staff.getByLabel(
            kind === 'tags' ? 'New tag name' : 'New identifier type',
          ),
        ).toHaveCount(0)
      } finally {
        if (await sw.isChecked()) {
          await toggle.click()
          await expect(sw).not.toBeChecked()
        }
        await staff.context().close()
      }
    })
  }
})
