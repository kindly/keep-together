import { expect, test } from '../fixtures'
import { runId } from '../timing'
import { secondTab, want } from './contact.helpers'
import type { Page } from '@playwright/test'

// Settings › Source codes (source-codes plan, step 3): the category →
// detail → version tree, adding a detail (which brings its version 001),
// editing a part, archiving it, deleting an unused one, a save merged
// over someone else's, and the admin-only "staff can manage source codes"
// switch. User A is an admin of tenant A, whose categories are the seven
// starters plus a Street detail named `Alpha<run>` (qcSeed). The world is
// shared by every test in a worker, so each test makes its own details
// under Online, and leaves the switch off.

const SOURCES_ROUTE = {
  type: 'route',
  description: '/t/$slug/settings/sources',
}
const SETTINGS_ROUTE = { type: 'route', description: '/t/$slug/settings' }

const sourcesPath = (slug: string) => `/t/${slug}/settings/sources`

let made = 0
/** A detail name no other test in the worker uses: no hyphens allowed. */
function detailName(tag: string): string {
  made += 1
  return `qc${tag}${process.pid}x${made}`
}

/** The tree's row for a full code. */
const row = (page: Page, code: string) =>
  page
    .locator('main li')
    .filter({ has: page.locator('code').getByText(code, { exact: true }) })

/** Add a detail under Online; resolves once its version 001 is listed. */
async function addDetail(page: Page, name: string) {
  await row(page, 'Online')
    .getByRole('button', { name: 'add detail', exact: true })
    .click()
  await page.getByLabel('New detail under Online').fill(name)
  await page.getByRole('button', { name: 'Add detail', exact: true }).click()
  await expect(row(page, `Online-${name}-001`)).toBeVisible()
}

/** Delete an unused detail under Online and wait until it's gone. */
async function deleteDetail(page: Page, name: string) {
  await row(page, `Online-${name}`)
    .getByRole('button', { name: 'delete' })
    .click()
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Delete' })
    .click()
  await expect(row(page, `Online-${name}`)).toHaveCount(0)
}

// ── in-page predicates (serialised: no closures, no imports) ──────────────

/** The Source codes tab has loaded its tree. */
function sourcesLoaded() {
  return (
    document.querySelector('main h2')?.textContent === 'Source codes' &&
    document.querySelector('main li code') !== null
  )
}

/** The tree lists the full code window.__qcWant. */
function codeListed() {
  const w = (window as unknown as { __qcWant?: string }).__qcWant
  return [...document.querySelectorAll('main li code')].some(
    (c) => c.textContent === w,
  )
}

/** The row for code `arg` has a button reading window.__qcWant. */
function rowButtonIsWant(code: string) {
  const w = (window as unknown as { __qcWant?: string }).__qcWant
  return [...document.querySelectorAll('main li')].some(
    (li) =>
      li.querySelector('code')?.textContent === code &&
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

// ── specs ──────────────────────────────────────────────────────────────────

test.describe('source codes', { annotation: SOURCES_ROUTE }, () => {
  test('open the tab: the seeded tree, in tree order', async ({
    page,
    flow,
    users,
  }) => {
    test.info().annotations.push(SETTINGS_ROUTE)
    await page.goto(`/t/${users.a.slug}/settings/tags`)
    const tabs = page.getByRole('navigation', { name: 'Settings sections' })
    const sources = tabs.getByRole('link', { name: 'Source codes' })
    const tagsTab = tabs.getByRole('link', { name: 'Tags' })
    await flow(page, 'settings.sourceCodes.open', {
      before: async () => {
        if (page.url().endsWith('/settings/sources')) {
          await tagsTab.click()
          await expect(
            page.getByRole('heading', { name: 'Tags', exact: true }),
          ).toBeVisible()
        }
      },
      action: () => sources.click(),
      until: sourcesLoaded,
    })
    await expect(page).toHaveURL(sourcesPath(users.a.slug))
    await expect(sources).toHaveAttribute('aria-current', 'page')

    // The seeded Street detail follows its category, and its version
    // follows it, each row showing the full code: the names joined.
    const detail = `Alpha${runId()}`
    const codes = page.locator('main li code')
    await expect(row(page, `Street-${detail}-001`)).toBeVisible()
    const all = await codes.allTextContents()
    const street = all.indexOf('Street')
    expect(all.slice(street, street + 3)).toEqual([
      'Street',
      `Street-${detail}`,
      `Street-${detail}-001`,
    ])
    // Phone: no page-wide horizontal scroll.
    await page.setViewportSize({ width: 375, height: 700 })
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true)
    await page.setViewportSize({ width: 1280, height: 800 })
  })

  test('add a detail: it comes with version 001', async ({
    page,
    flow,
    users,
  }) => {
    await page.goto(sourcesPath(users.a.slug))
    await expect(row(page, 'Online')).toBeVisible()
    let name = ''
    // Each sample deletes the last one's detail first (untimed), so every
    // sample reads the same tree, however many repeats ran before.
    await flow(page, 'settings.sourceCodes.addDetail', {
      before: async () => {
        if (name) await deleteDetail(page, name)
        name = detailName('add')
        const field = page.getByLabel('New detail under Online')
        if (!(await field.isVisible())) {
          await row(page, 'Online')
            .getByRole('button', { name: 'add detail', exact: true })
            .click()
        }
        await field.fill(name)
        await want(page, `Online-${name}-001`)
      },
      action: () =>
        page.getByRole('button', { name: 'Add detail', exact: true }).click(),
      until: codeListed,
    })
    await expect(row(page, `Online-${name}`)).toBeVisible()

    // A sibling's name, in another case, is refused; so is a hyphen.
    await row(page, 'Online')
      .getByRole('button', { name: 'add detail', exact: true })
      .click()
    const field = page.getByLabel('New detail under Online')
    await field.fill(name.toUpperCase())
    await page.getByRole('button', { name: 'Add detail', exact: true }).click()
    await expect(row(page, 'Online').getByRole('alert')).toHaveText(
      `${name} already exists here`,
    )
    await field.fill('Two-parts')
    await page.getByRole('button', { name: 'Add detail', exact: true }).click()
    await expect(row(page, 'Online').getByRole('alert')).toContainText(
      'can’t contain a hyphen',
    )
  })

  test('edit: rename a detail, its versions read the new code', async ({
    page,
    flow,
    users,
  }) => {
    await page.goto(sourcesPath(users.a.slug))
    let current = detailName('ren')
    await addDetail(page, current)
    await flow(page, 'settings.sourceCodes.rename', {
      before: async () => {
        await row(page, `Online-${current}`)
          .getByRole('button', { name: 'edit' })
          .click()
        const field = page.getByLabel(`Name of Online-${current}`)
        current = detailName('ren')
        await field.fill(current)
        await want(page, `Online-${current}-001`)
      },
      action: () =>
        page.getByRole('button', { name: 'Save', exact: true }).click(),
      until: codeListed,
    })
    await expect(row(page, `Online-${current}`)).toBeVisible()

    // Description and dates: saved, and shown under the code.
    await row(page, `Online-${current}-001`)
      .getByRole('button', { name: 'edit' })
      .click()
    const version = row(page, `Online-${current}-001`)
    await version.getByLabel('Description').fill('Spring run')
    await version.getByLabel('Start date').fill('2026-03-01')
    await version.getByLabel('End date').fill('2026-05-31')
    await version.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(version).toContainText('1 Mar 2026 to 31 May 2026')
    await expect(version).toContainText('Spring run')
    // An end before the start is refused, with the form left open.
    await version.getByRole('button', { name: 'edit' }).click()
    await version.getByLabel('End date').fill('2026-01-31')
    await version.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(version.getByRole('alert')).toHaveText(
      'End date is before start date',
    )
    await version.getByRole('button', { name: 'cancel' }).click()
    // Categories have no dates.
    await row(page, 'Online').getByRole('button', { name: 'edit' }).click()
    await expect(row(page, 'Online').getByLabel('Start date')).toHaveCount(0)
    await row(page, 'Online').getByRole('button', { name: 'cancel' }).click()
  })

  test('archive: hidden with everything under it, until shown', async ({
    page,
    flow,
    users,
  }) => {
    await page.goto(sourcesPath(users.a.slug))
    const name = detailName('arc')
    await addDetail(page, name)
    const code = `Online-${name}`
    const showArchived = page.getByLabel(/^Show archived/)
    await showArchived.check()
    const toggle = () =>
      row(page, code).getByRole('button', { name: /^(archive|reactivate)$/ })
    await flow(page, 'settings.sourceCodes.archive', {
      before: async () => {
        const label = await toggle().textContent()
        await want(page, label === 'archive' ? 'reactivate' : 'archive')
      },
      action: () => toggle().click(),
      until: rowButtonIsWant,
      arg: code,
    })
    if ((await toggle().textContent()) === 'archive') await toggle().click()
    await expect(row(page, code)).toContainText('archived')
    await expect(row(page, `${code}-001`)).toContainText(
      'a part above it is archived',
    )
    // Hidden, version and all, with "Show archived" off.
    await showArchived.uncheck()
    await expect(row(page, code)).toHaveCount(0)
    await expect(row(page, `${code}-001`)).toHaveCount(0)
    await showArchived.check()
    await toggle().click()
    await showArchived.uncheck()
    await expect(row(page, `${code}-001`)).toBeVisible()
  })

  test('archiving a category asks first, counting what it hides', async ({
    page,
    users,
  }) => {
    await page.goto(sourcesPath(users.a.slug))
    // A category of its own: the starters are shared by the worker's tests.
    const category = detailName('cat')
    await page.getByLabel('New category', { exact: true }).fill(category)
    await page.getByRole('button', { name: 'Add category' }).click()
    await row(page, category)
      .getByRole('button', { name: 'add detail', exact: true })
      .click()
    await page.getByLabel(`New detail under ${category}`).fill('One')
    await page.getByRole('button', { name: 'Add detail', exact: true }).click()
    await expect(row(page, `${category}-One-001`)).toBeVisible()

    const archive = () =>
      row(page, category).getByRole('button', { name: 'archive', exact: true })
    const dialog = page.getByRole('alertdialog')
    await archive().click()
    await expect(dialog).toContainText(`Archive ${category}?`)
    await expect(dialog).toContainText('1 detail and 1 version')
    await dialog.getByRole('button', { name: 'Keep it' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(row(page, `${category}-One-001`)).toBeVisible()

    await archive().click()
    await dialog.getByRole('button', { name: 'Archive' }).click()
    await expect(row(page, category)).toHaveCount(0)
    await expect(row(page, `${category}-One-001`)).toHaveCount(0)

    // Reactivating is one click; then tidy it away (never used).
    await page.getByLabel(/^Show archived/).check()
    await row(page, category)
      .getByRole('button', { name: 'reactivate' })
      .click()
    await expect(
      row(page, category).getByText('archived', { exact: true }),
    ).toHaveCount(0)
    await row(page, category).getByRole('button', { name: 'delete' }).click()
    await dialog.getByRole('button', { name: 'Delete' }).click()
    await expect(row(page, category)).toHaveCount(0)
    await page.getByLabel(/^Show archived/).uncheck()
  })

  test('delete an unused detail, with its versions', async ({
    page,
    users,
  }) => {
    await page.goto(sourcesPath(users.a.slug))
    const name = detailName('del')
    await addDetail(page, name)
    await row(page, `Online-${name}`)
      .getByRole('button', { name: 'delete' })
      .click()
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toContainText('the 1 code part under it')
    await dialog.getByRole('button', { name: 'Delete' }).click()
    await expect(row(page, `Online-${name}`)).toHaveCount(0)
    await expect(row(page, `Online-${name}-001`)).toHaveCount(0)
  })

  test('a save made elsewhere meanwhile is merged, not lost', async ({
    page,
    browser,
    baseURL,
    session,
    users,
  }) => {
    await page.goto(sourcesPath(users.a.slug))
    const name = detailName('mrg')
    await addDetail(page, name)
    const code = `Online-${name}`
    await row(page, code).getByRole('button', { name: 'edit' }).click()
    // The row with this tab's open editor, whatever its code reads.
    const mine = page
      .locator('main li')
      .filter({ has: page.getByRole('button', { name: 'Save', exact: true }) })
    const ours = detailName('mrg')
    await mine.getByLabel(/^Name of /).fill(ours)

    // Another admin renames it differently, describes it, then archives it.
    const theirs = detailName('mrg')
    const other = await secondTab(browser, baseURL!, await session(users.a))
    try {
      await other.goto(sourcesPath(users.a.slug))
      await row(other, code).getByRole('button', { name: 'edit' }).click()
      await row(other, code).getByLabel(`Name of ${code}`).fill(theirs)
      await row(other, code)
        .getByLabel('Description')
        .fill('From the other tab')
      await row(other, code)
        .getByRole('button', { name: 'Save', exact: true })
        .click()
      await expect(row(other, `Online-${theirs}`)).toContainText(
        'From the other tab',
      )
      await row(other, `Online-${theirs}`)
        .getByRole('button', { name: 'archive', exact: true })
        .click()
      await expect(row(other, `Online-${theirs}`)).toHaveCount(0)
    } finally {
      await other.context().close()
    }
    // This editor took their description, kept and flagged its own name,
    // and stays open on the archived row, saying so.
    await expect(mine.getByLabel('Description')).toHaveValue(
      'From the other tab',
    )
    await expect(mine.getByLabel(/^Name of /)).toHaveValue(ours)
    await expect(mine).toContainText(`changed by someone else to “${theirs}”`)
    await expect(mine.getByRole('status')).toContainText(
      'Archived while this was open',
    )
    await mine.getByRole('button', { name: 'Save', exact: true }).click()
    // Saved, still archived, so hidden until shown.
    await expect(row(page, `Online-${ours}`)).toHaveCount(0)
    await page.getByLabel(/^Show archived/).check()
    await expect(row(page, `Online-${ours}`)).toContainText(
      'From the other tab',
    )
    await expect(row(page, `Online-${ours}`)).toContainText('archived')
  })
})

test.describe('source codes for staff and viewers', () => {
  for (const role of ['staff', 'viewer'] as const) {
    test(`${role}: the tree, read-only, no switch`, async ({
      browser,
      baseURL,
      session,
      users,
    }) => {
      test.info().annotations.push(SOURCES_ROUTE)
      const user = users[role]
      const other = await secondTab(browser, baseURL!, await session(user))
      try {
        await other.goto(sourcesPath(user.slug))
        await expect(row(other, 'Street')).toBeVisible()
        await expect(other.getByLabel('New category')).toHaveCount(0)
        await expect(other.locator('main li button')).toHaveCount(0)
        await expect(other.getByRole('switch')).toHaveCount(0)
      } finally {
        await other.context().close()
      }
    })
  }

  test('the switch opens source codes to staff, live', async ({
    page,
    browser,
    baseURL,
    flow,
    session,
    users,
  }) => {
    test.info().annotations.push(SOURCES_ROUTE)
    const label = 'Staff can manage source codes'
    await page.goto(sourcesPath(users.a.slug))
    const sw = page.getByRole('switch', { name: label })
    await expect(page.getByRole('switch')).toHaveCount(1)
    // The tenant is shared by the worker's tests: it starts, and is left, off.
    await expect(sw).not.toBeChecked()
    const toggle = page.getByText(label, { exact: true })
    const staff = await secondTab(browser, baseURL!, await session(users.staff))
    try {
      await staff.goto(sourcesPath(users.staff.slug))
      await expect(row(staff, 'Street')).toBeVisible()
      await expect(staff.getByLabel('New category')).toHaveCount(0)

      await flow(page, 'settings.staffSourceCodes.toggle', {
        before: async () => want(page, (await sw.isChecked()) ? 'off' : 'on'),
        action: () => toggle.click(),
        until: switchIsWant,
        arg: label,
      })
      if (!(await sw.isChecked())) await toggle.click()
      await expect(sw).toBeChecked()

      // Staff's open page follows: they add a detail.
      const name = detailName('staff')
      await addDetail(staff, name)

      // Off again: the open page goes read-only.
      await toggle.click()
      await expect(sw).not.toBeChecked()
      await expect(staff.locator('main li button')).toHaveCount(0)
    } finally {
      if (await sw.isChecked()) {
        await toggle.click()
        await expect(sw).not.toBeChecked()
      }
      await staff.context().close()
    }
  })
})
