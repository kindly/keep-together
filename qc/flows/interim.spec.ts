import { expect, test } from '../fixtures'
import {
  CONTACT_ROUTE,
  LIST_ROUTE,
  createContact,
  fieldHoldsWant,
  saveButton,
  saved,
  section,
  uniqueName,
  want,
} from './contact.helpers'

// Flows on the Rust backend's interim UI (rust spike step 3, folded in
// from qc-rs/), until B1 ports the real one: a field filter on the seeded
// field (fields.spec makes its own through Settings › Fields), and the
// plain history panel's "Restore this" (contact.spec's moments and
// "Restore to here"). B1 deletes this file as it lifts those from
// qc/pending.ts.

/** The list shows exactly one row, and it has window.__qcWant. */
function onlyRowIsWant() {
  const w = (window as unknown as { __qcWant?: string }).__qcWant ?? ''
  const links = [...document.querySelectorAll('main ul li a')]
  return links.length === 1 && links[0].textContent.includes(w)
}

test.describe('fields on the contacts list', { annotation: LIST_ROUTE }, () => {
  test('filter the list by the seeded field', async ({
    page,
    flow,
    users,
    world,
  }) => {
    const { label, options } = world.field
    const last = uniqueName('filtered')
    await createContact(page, users.a.slug, last)
    await section(page, 'Fields').getByLabel(label).selectOption({
      label: options[0],
    })
    await expect(saved(page)).toBeVisible()
    await page.getByRole('link', { name: 'Contacts', exact: true }).click()
    const filter = page.getByLabel(`Filter by ${label}`)
    const links = page.locator('main ul li a')
    // The seeded field is shared by the worker's tests: narrow by search
    // first, so "one row" means this contact (fields.spec makes a field
    // of its own instead, through Settings, which B1 ports).
    await flow(page, 'fields.filter', {
      before: async () => {
        await page.goto(`/t/${users.a.slug}/contacts`)
        await page.getByLabel('Search contacts').fill(last)
        await want(page, last)
        await filter.selectOption({ label: `${label} not set` })
        await expect(page.getByText('Loading…')).toBeHidden()
        await expect(links.filter({ hasText: last })).toBeHidden()
        await filter.focus()
      },
      action: () => filter.press('ArrowDown'),
      until: onlyRowIsWant,
    })
    await expect(links.first()).toContainText(`${label}: ${options[0]}`)
  })
})

test.describe('history', { annotation: CONTACT_ROUTE }, () => {
  test('Restore this brings back the previous nickname', async ({
    page,
    flow,
    users,
  }) => {
    await createContact(page, users.a.slug, uniqueName('restore'))
    const items = page.locator('aside ol > li')
    const known = page.getByLabel('Known as')
    let n = 0
    await flow(page, 'contact.restore', {
      before: async () => {
        await expect(items.first()).toBeVisible()
        if (n > 0)
          await expect(items.first().getByText('restored')).toBeVisible()
        const top = await items.first().getAttribute('data-revision')
        await known.fill(`restore ${++n}`)
        await saveButton(page).click()
        await expect(saved(page)).toBeVisible()
        await expect(items.first()).not.toHaveAttribute('data-revision', top!)
        await want(page, '')
      },
      // The revision before this save: the nickname was empty.
      action: () =>
        page.getByRole('button', { name: 'Restore this' }).first().click(),
      until: fieldHoldsWant,
      arg: 'Known as',
    })
    await expect(items.nth(0).getByText('restored')).toBeVisible()
    await page.reload()
    await expect(known).toHaveValue('')
  })
})
