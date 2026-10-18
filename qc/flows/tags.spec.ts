import { expect, test } from '../fixtures'
import {
  CONTACT_ROUTE,
  LIST_ROUTE,
  createContact,
  saved,
  section,
  uniqueName,
  want,
} from './contact.helpers'
import type { Page } from '@playwright/test'

// Tags (contact-model S5): the tags page (create, rename, archive /
// reactivate), tags on the contact form, the list's tag filter, and bulk
// add / remove from a list selection. Every test makes its own tags, so
// nothing depends on what another test left in the worker's tenant.

const TAGS_ROUTE = { type: 'route', description: '/t/$slug/tags' }

const tagsPath = (slug: string) => `/t/${slug}/tags`

/** The tags page's row for a tag. */
const tagRow = (page: Page, name: string) =>
  page.locator('main li').filter({ has: page.getByText(name, { exact: true }) })

async function createTag(page: Page, slug: string, name: string) {
  await page.goto(tagsPath(slug))
  await page.getByLabel('New tag name').fill(name)
  await page.getByRole('button', { name: 'Create tag' }).click()
  await expect(tagRow(page, name)).toBeVisible()
}

/** The contact form's tags section. */
const tagsSection = (page: Page) => section(page, 'Tags')

/** Add a tag on the open contact page and wait until it's saved. */
async function addTag(page: Page, name: string) {
  await tagsSection(page).getByLabel('Add tag').selectOption({ label: name })
  await expect(
    tagsSection(page).getByRole('button', { name: `remove tag ${name}` }),
  ).toBeVisible()
  await expect(saved(page)).toBeVisible()
}

// ── in-page predicates (serialised: no closures, no imports) ──────────────

/** The tags page lists a tag named window.__qcWant. */
function tagListed() {
  const w = (window as unknown as { __qcWant?: string }).__qcWant
  return [...document.querySelectorAll('main li span')].some(
    (s) => s.textContent === w,
  )
}

/** The tags page row for `name` has a button reading window.__qcWant. */
function tagRowButtonIsWant(name: string) {
  const w = (window as unknown as { __qcWant?: string }).__qcWant
  return [...document.querySelectorAll('main li')].some(
    (li) =>
      [...li.querySelectorAll('span')].some((s) => s.textContent === name) &&
      [...li.querySelectorAll('button')].some((b) => b.textContent === w),
  )
}

/** The form carries (or not) tag window.__qcWant, and has saved. */
function tagChipSaved(present: boolean) {
  const w = (window as unknown as { __qcWant?: string }).__qcWant
  const has = [...document.querySelectorAll('button[aria-label]')].some(
    (b) => b.getAttribute('aria-label') === `remove tag ${w}`,
  )
  const isSaved = [...document.querySelectorAll('span')].some((s) =>
    s.textContent.startsWith('All changes saved'),
  )
  return has === present && isSaved
}

/** The list shows exactly one row, and it names window.__qcWant. */
function onlyRowIsWant() {
  const w = (window as unknown as { __qcWant?: string }).__qcWant ?? ''
  const links = [...document.querySelectorAll('main ul li a')]
  return links.length === 1 && links[0].textContent.includes(w)
}

/** The bulk status line starts with window.__qcWant. */
function bulkStatusIsWant() {
  const w = (window as unknown as { __qcWant?: string }).__qcWant ?? '?'
  return (
    document.querySelector('[role="status"]')?.textContent.startsWith(w) ??
    false
  )
}

// ── specs ──────────────────────────────────────────────────────────────────

test.describe('tags page', { annotation: TAGS_ROUTE }, () => {
  test('create, rename, archive and reactivate', async ({
    page,
    flow,
    users,
  }) => {
    await page.goto(tagsPath(users.a.slug))
    await expect(page.getByRole('heading', { name: 'Tags' })).toBeVisible()
    // Seeded per tenant.
    await expect(tagRow(page, 'Member')).toBeVisible()
    await expect(tagRow(page, 'Volunteer')).toBeVisible()
    const name = page.getByLabel('New tag name')
    const create = page.getByRole('button', { name: 'Create tag' })
    await expect(create).toBeDisabled()

    const base = uniqueName('tag')
    let n = 0
    await flow(page, 'tags.create', {
      before: async () => {
        const next = `${base}-${++n}`
        await name.fill(next)
        await want(page, next)
      },
      action: () => create.click(),
      until: tagListed,
    })
    await expect(name).toHaveValue('')

    // Names are unique per tenant, case-insensitively.
    await name.fill('  volunteer ')
    await create.click()
    await expect(page.getByRole('alert')).toHaveText(
      'A tag called Volunteer exists',
    )

    let current = `${base}-1`
    let r = 0
    await flow(page, 'tags.rename', {
      before: async () => {
        await tagRow(page, current)
          .getByRole('button', { name: 'rename' })
          .click()
        current = `${base}-renamed-${++r}`
        await page.getByLabel(/^Rename /).fill(current)
        await want(page, current)
      },
      action: () =>
        page.getByRole('button', { name: 'Save', exact: true }).click(),
      until: tagListed,
    })

    const row = () => tagRow(page, current)
    await flow(page, 'tags.archive', {
      before: async () => {
        const label = await row()
          .getByRole('button', { name: /^(archive|reactivate)$/ })
          .textContent()
        await want(page, label === 'archive' ? 'reactivate' : 'archive')
      },
      action: () =>
        row()
          .getByRole('button', { name: /^(archive|reactivate)$/ })
          .click(),
      until: tagRowButtonIsWant,
      arg: current,
    })

    // Archived tags sit apart, and come back on reactivate.
    const toggle = row().getByRole('button', { name: /^(archive|reactivate)$/ })
    if ((await toggle.textContent()) === 'archive') await toggle.click()
    const archived = section(page, 'Archived')
    await expect(archived.getByText(current, { exact: true })).toBeVisible()
    await archived.getByRole('button', { name: 'reactivate' }).click()
    await expect(
      section(page, 'In use').getByText(current, { exact: true }),
    ).toBeVisible()
  })
})

test.describe('tags on a contact', { annotation: CONTACT_ROUTE }, () => {
  test('add and remove a tag', async ({ page, flow, users }) => {
    await createContact(page, users.a.slug, uniqueName('tagged'))
    const tags = tagsSection(page)
    await expect(tags.getByText('No tags.')).toBeVisible()
    await want(page, 'Member')
    const chip = tags.getByRole('button', { name: 'remove tag Member' })
    const picker = tags.getByLabel('Add tag')

    await flow(page, 'contact.tag.add', {
      before: async () => {
        if (await chip.isVisible()) {
          await chip.click()
          await expect(chip).toBeHidden()
          await expect(saved(page)).toBeVisible()
        }
      },
      // A trusted keypress (selectOption's events are synthetic, so they
      // start no timer): the picker rests on "add tag…", and Member is the
      // first tag offered (alphabetical).
      action: () => picker.press('ArrowDown'),
      until: tagChipSaved,
      arg: true,
    })
    // Once carried, a tag is no longer offered.
    await expect(picker.locator('option', { hasText: 'Member' })).toHaveCount(0)

    await flow(page, 'contact.tag.remove', {
      before: async () => {
        if (!(await chip.isVisible())) await addTag(page, 'Member')
      },
      action: () => chip.click(),
      until: tagChipSaved,
      arg: false,
    })

    await addTag(page, 'Volunteer')
    await page.reload()
    await expect(
      tags.getByRole('button', { name: 'remove tag Volunteer' }),
    ).toBeVisible()
    await expect(chip).toBeHidden()
  })

  test(
    'an archived tag stays on the contact, marked, and is not offered',
    { annotation: [CONTACT_ROUTE, TAGS_ROUTE] },
    async ({ page, users }) => {
      const tag = uniqueName('retired')
      await createTag(page, users.a.slug, tag)
      const url = await createContact(page, users.a.slug, uniqueName('keeps'))
      await addTag(page, tag)

      await page.goto(tagsPath(users.a.slug))
      await tagRow(page, tag).getByRole('button', { name: 'archive' }).click()
      await expect(
        section(page, 'Archived').getByText(tag, { exact: true }),
      ).toBeVisible()

      await page.goto(url)
      const tags = tagsSection(page)
      const chip = tags.locator('li', { hasText: tag })
      await expect(chip).toContainText('(archived)')
      await expect(
        tags.getByLabel('Add tag').locator('option', { hasText: tag }),
      ).toHaveCount(0)
      // It can still be taken off.
      await tags.getByRole('button', { name: `remove tag ${tag}` }).click()
      await expect(chip).toBeHidden()
      await expect(saved(page)).toBeVisible()
    },
  )
})

test.describe('tags on the contacts list', { annotation: LIST_ROUTE }, () => {
  test(
    'filter the list by a tag',
    { annotation: [LIST_ROUTE, CONTACT_ROUTE, TAGS_ROUTE] },
    async ({ page, flow, users }) => {
      const tag = uniqueName('filter')
      const last = uniqueName('filtered')
      await createTag(page, users.a.slug, tag)
      await createContact(page, users.a.slug, last)
      await addTag(page, tag)
      await page.getByRole('link', { name: 'Contacts', exact: true }).click()
      const filter = page.getByLabel('Filter by tag')
      const links = page.locator('main ul li a')
      await want(page, last)

      // The option just above ours, so a trusted ArrowDown (selectOption's
      // events are synthetic and start no timer) lands on our tag.
      const options = await filter.locator('option').allTextContents()
      const above = options[options.indexOf(tag) - 1]
      await flow(page, 'tags.filter', {
        before: async () => {
          await filter.selectOption({ label: above })
          await expect(page.getByText('Loading…')).toBeHidden()
          await expect(links.filter({ hasText: last })).toBeHidden()
          await filter.focus()
        },
        action: () => filter.press('ArrowDown'),
        until: onlyRowIsWant,
      })
      // The row shows its tag.
      await expect(links.first()).toContainText(tag)
    },
  )

  test(
    'select rows, then add and remove a tag in bulk',
    { annotation: [LIST_ROUTE, TAGS_ROUTE] },
    async ({ page, flow, users }) => {
      const tag = uniqueName('bulk')
      await createTag(page, users.a.slug, tag)
      await page.goto(`/t/${users.a.slug}/contacts`)
      const links = page.locator('main ul li a')
      await expect(links.nth(1)).toBeVisible()

      // A tag nobody carries yet says so (not "No contacts yet").
      const filter = page.getByLabel('Filter by tag')
      await filter.selectOption({ label: tag })
      await expect(page.getByText('No contacts with this tag.')).toBeVisible()
      await filter.selectOption('')
      await expect(links.nth(1)).toBeVisible()

      // Every contact in the worker's tenant, up to the list's 100.
      await page.getByLabel(/^select all \d+ shown/).check()
      const shown = await links.count()
      await expect(page.getByText(`${shown} selected`)).toBeVisible()
      await page.getByLabel('Tag to change').selectOption({ label: tag })

      let op: 'Add tag' | 'Remove tag' = 'Remove tag'
      await flow(page, 'contacts.bulkTag', {
        before: async () => {
          op = op === 'Add tag' ? 'Remove tag' : 'Add tag'
          await want(page, op === 'Add tag' ? 'Added' : 'Removed')
        },
        action: () => page.getByRole('button', { name: op }).click(),
        until: bulkStatusIsWant,
      })

      // Leave it added, then the filter shows exactly the selection.
      const status = page.getByRole('status')
      if ((await status.textContent())?.startsWith('Removed')) {
        await page.getByRole('button', { name: 'Add tag' }).click()
        await expect(page.getByRole('status')).toHaveText(
          `Added “${tag}” to ${shown} contacts`,
        )
      }
      await filter.selectOption({ label: tag })
      await expect(links).toHaveCount(shown)

      // Adding again changes nothing: one revision per contact that changes.
      await page.getByLabel(/^select all \d+ shown/).check()
      await page.getByLabel('Tag to change').selectOption({ label: tag })
      await page.getByRole('button', { name: 'Add tag' }).click()
      await expect(page.getByRole('status')).toHaveText(
        `Added “${tag}” to 0 contacts`,
      )
    },
  )
})
