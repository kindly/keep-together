import { expect, test } from '../fixtures'
import { secondTab, section, uniqueName, want } from './contact.helpers'
import type { Page } from '@playwright/test'

// Settings: the tabbed layout every member reaches from the "Settings"
// nav link (tabs in a column on the left, a scrollable row on a phone),
// its Identifier types tab (external-ids X4a: create, rename, archive /
// reactivate), and the identifier types admin switch, which opens that
// list to staff and no other. The Fields tab, the first, has its own flows
// in fields.spec.ts. User A is an admin of tenant A. No types are seeded,
// and the world is shared by every test in a worker, so each test makes
// its own types, and leaves the switches off.

const IDENTIFIERS_ROUTE = {
  type: 'route',
  description: '/t/$slug/settings/identifiers',
}
const SETTINGS_ROUTE = { type: 'route', description: '/t/$slug/settings' }
const SETTINGS_INDEX_ROUTE = {
  type: 'route',
  description: '/t/$slug/settings/',
}
const FIELDS_ROUTE = { type: 'route', description: '/t/$slug/settings/fields' }

const identifiersPath = (slug: string) => `/t/${slug}/settings/identifiers`
const fieldsPath = (slug: string) => `/t/${slug}/settings/fields`

/** The settings tab bar. */
const tabs = (page: Page) =>
  page.getByRole('navigation', { name: 'Settings sections' })

/** The Fields tab's card for a field. */
const fieldCard = (page: Page, label: string) =>
  page
    .getByTestId('field')
    .filter({ has: page.getByText(label, { exact: true }) })

/**
 * Wait for the Fields tab's list, with the seeded field on it and a slot
 * free: with every slot taken a manager gets no "New field" either, so a
 * check for its absence would prove nothing.
 */
async function fieldsLoaded(page: Page, seeded: string) {
  const heading = page.getByRole('heading', { name: /^Fields / })
  const inUse = /\((\d+) of (\d+) in use\)/
  await expect(heading).toHaveText(inUse)
  const [, used, slots] = (await heading.textContent())!.match(inUse)!
  expect(Number(used)).toBeLessThan(Number(slots))
  await expect(fieldCard(page, seeded)).toBeVisible()
}

/** The Fields tab is read-only: no "New field", no edit on a card. */
async function fieldsReadOnly(page: Page, seeded: string) {
  await expect(page.getByLabel('New field')).toHaveCount(0)
  await expect(
    fieldCard(page, seeded).getByRole('button', { name: 'edit' }),
  ).toHaveCount(0)
}

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

/**
 * The settings tab headed window.__qcWant has loaded its list: identifier
 * types' "In use", or the Fields tab's "Fields (n of 5 in use)".
 */
function tabLoaded() {
  const w = (window as unknown as { __qcWant?: string }).__qcWant
  return (
    document.querySelector('main h2')?.textContent === w &&
    [...document.querySelectorAll('main h3')].some(
      (h) => h.textContent === 'In use' || /^Fields /.test(h.textContent),
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
        FIELDS_ROUTE,
        IDENTIFIERS_ROUTE,
      )
    await page.goto(`/t/${users.a.slug}/contacts`)
    const settings = page.getByRole('link', { name: 'Settings', exact: true })
    const contacts = page.getByRole('link', { name: 'Contacts', exact: true })
    await want(page, 'Fields')
    // The link opens the first tab, Fields. No round trip to time: the
    // Fields tab reads what the contacts list is itself subscribed to
    // (fields, the group, source filter options), so it draws at once.
    // That is the app's behaviour, not a held answer.
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
    await expect(page).toHaveURL(fieldsPath(users.a.slug))

    const fieldsTab = tabs(page).getByRole('link', { name: 'Fields' })
    const typesTab = tabs(page).getByRole('link', { name: 'Identifier types' })
    await expect(fieldsTab).toHaveAttribute('aria-current', 'page')
    await expect(typesTab).not.toHaveAttribute('aria-current', 'page')

    // `server: true`: the tab left behind no longer observes its query,
    // which the sample drops, so the tab it opens asks the server.
    let to = 'Fields'
    await flow(page, 'settings.tab', {
      before: async () => {
        to = to === 'Fields' ? 'Identifier types' : 'Fields'
        await want(page, to)
      },
      action: () => (to === 'Fields' ? fieldsTab : typesTab).click(),
      until: tabLoaded,
      server: true,
    })
    await typesTab.click()
    await expect(page).toHaveURL(identifiersPath(users.a.slug))
    await expect(typesTab).toHaveAttribute('aria-current', 'page')

    // Desktop: the tabs stand in a column left of the content.
    const heading = page.getByRole('heading', { name: 'Identifier types' })
    const box = async () => ({
      fields: (await fieldsTab.boundingBox())!,
      types: (await typesTab.boundingBox())!,
      content: (await heading.boundingBox())!,
    })
    let b = await box()
    expect(b.types.y).toBeGreaterThan(b.fields.y)
    expect(b.types.x).toBe(b.fields.x)
    expect(b.content.x).toBeGreaterThanOrEqual(b.fields.x + b.fields.width)
    // Phone: one row above the content, and no page-wide horizontal scroll.
    await page.setViewportSize({ width: 375, height: 700 })
    b = await box()
    expect(b.types.y).toBe(b.fields.y)
    expect(b.types.x).toBeGreaterThan(b.fields.x)
    expect(b.content.y).toBeGreaterThanOrEqual(b.fields.y + b.fields.height)
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true)
    await page.setViewportSize({ width: 1280, height: 800 })
  })
})

test.describe('old tags URLs', () => {
  test(
    '/tags and /settings/tags land on the Fields tab',
    {
      annotation: [
        { type: 'route', description: '/t/$slug/tags' },
        { type: 'route', description: '/t/$slug/settings/tags' },
        SETTINGS_ROUTE,
        FIELDS_ROUTE,
      ],
    },
    async ({ page, users, world }) => {
      for (const from of ['tags', 'settings/tags']) {
        await page.goto(`/t/${users.a.slug}/${from}`)
        await page.waitForURL(new RegExp(`${fieldsPath(users.a.slug)}$`))
        await expect(fieldCard(page, world.field.label)).toBeVisible()
      }
    },
  )
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
      world,
    }) => {
      test
        .info()
        .annotations.push(
          { type: 'route', description: '/t/$slug/contacts/' },
          SETTINGS_ROUTE,
          SETTINGS_INDEX_ROUTE,
          FIELDS_ROUTE,
          IDENTIFIERS_ROUTE,
        )
      const user = users[role]
      const other = await secondTab(browser, baseURL!, await session(user))
      await other.goto(`/t/${user.slug}/contacts`)
      await other.getByRole('link', { name: 'Settings', exact: true }).click()
      await other.waitForURL(new RegExp(`${fieldsPath(user.slug)}$`))
      // A4's Members and Your account follow the lists; Scans storage
      // (declaration scans) is for staff and admins, not viewers.
      await expect(tabs(other).getByRole('link')).toHaveText([
        'Fields',
        'Identifier types',
        'Source codes',
        ...(role === 'staff' ? ['Scans storage'] : []),
        'Members',
        'Your account',
      ])
      // Read-only: staff manage a list only when an admin allows it (all
      // off here), viewers never; neither sees the switches.
      await fieldsLoaded(other, world.field.label)
      await fieldsReadOnly(other, world.field.label)
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

test.describe('staff can manage lists, per list', () => {
  test('the identifier types switch opens identifier types alone to staff, live', async ({
    page,
    browser,
    baseURL,
    flow,
    session,
    users,
    world,
  }) => {
    test
      .info()
      .annotations.push(SETTINGS_ROUTE, FIELDS_ROUTE, IDENTIFIERS_ROUTE)
    const label = 'Staff can manage identifier types'
    await page.goto(identifiersPath(users.a.slug))
    const sw = page.getByRole('switch', { name: label })
    // Each tab carries only its own switch.
    await expect(page.getByRole('switch')).toHaveCount(1)
    // The tenant is shared by the worker's tests: it starts, and is left, off.
    await expect(sw).not.toBeChecked()
    const staff = await secondTab(browser, baseURL!, await session(users.staff))
    // The input is visually hidden; its label takes the (trusted) click.
    const toggle = page.getByText(label, { exact: true })
    // Open a tab; the identifier types tab's "create" input, or none while
    // the list is read-only.
    const createIn = async (tab: 'Fields' | 'Identifier types') => {
      await tabs(staff).getByRole('link', { name: tab }).click()
      if (tab === 'Fields') await fieldsLoaded(staff, world.field.label)
      return staff.getByLabel(
        tab === 'Fields' ? 'New field' : 'New identifier type',
      )
    }
    try {
      await staff.goto(identifiersPath(users.staff.slug))
      await expect(
        staff.getByRole('heading', { name: 'In use', exact: true }),
      ).toBeVisible()
      await expect(staff.getByLabel('New identifier type')).toHaveCount(0)

      await flow(page, 'settings.staffIdentifierTypes.toggle', {
        before: async () => want(page, (await sw.isChecked()) ? 'off' : 'on'),
        action: () => toggle.click(),
        until: switchIsWant,
        arg: label,
      })
      if (!(await sw.isChecked())) await toggle.click()
      await expect(sw).toBeChecked()

      // Staff's open pages follow: identifier types become theirs, fields
      // stay read-only.
      const input = await createIn('Identifier types')
      const name = uniqueName('staff-identifierTypes')
      await input.fill(name)
      await staff.getByRole('button', { name: 'Create type' }).click()
      await expect(staff.locator('main li', { hasText: name })).toBeVisible()
      await createIn('Fields')
      await fieldsReadOnly(staff, world.field.label)

      // Off again: the open page goes read-only.
      await createIn('Identifier types')
      await toggle.click()
      await expect(sw).not.toBeChecked()
      await expect(staff.getByLabel('New identifier type')).toHaveCount(0)
    } finally {
      if (await sw.isChecked()) {
        await toggle.click()
        await expect(sw).not.toBeChecked()
      }
      await staff.context().close()
    }
  })
})
