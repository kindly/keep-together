import { expect } from '../fixtures'
import type { Browser, Locator, Page } from '@playwright/test'
import type { StorageState } from '../fixtures'
import { tapContext } from '../timing'

// Shared by the contact page specs (QC step 8). Every test makes its own
// contacts (the world is shared by the worker), so nothing here relies on
// what another test left behind.

export const CONTACT_ROUTE = {
  type: 'route',
  description: '/t/$slug/contacts/$contactId',
}
export const LIST_ROUTE = { type: 'route', description: '/t/$slug/contacts/' }

let made = 0

/**
 * A last name no other test in this worker's tenant uses. No run id: the
 * list search is full-text, and a shared token would put these contacts
 * in other specs' searches for the seeded `Alpha-<run>` names.
 */
export function uniqueName(tag: string): string {
  made += 1
  return `qc8-${tag}-${process.pid}-${made}`
}

/** Create an individual through the UI; resolves on its contact page. */
export async function createContact(
  page: Page,
  slug: string,
  lastName: string,
  firstName = 'Qc',
): Promise<string> {
  await page.goto(`/t/${slug}/contacts/new`)
  await page.getByLabel('First name').fill(firstName)
  await page.getByLabel('Last name').fill(lastName)
  await page.getByRole('button', { name: 'Create' }).click()
  await page.waitForURL(/\/contacts\/(?!new)[^/]+$/)
  await expect(page.getByRole('heading', { name: lastName })).toBeVisible()
  return page.url()
}

/** The autosaving contact form (not the notes composer or editor). */
export function contactForm(page: Page): Locator {
  return page.locator('form', {
    has: page.getByRole('heading', { name: 'Details' }),
  })
}

export function saveButton(page: Page): Locator {
  return contactForm(page).getByRole('button', { name: 'Save', exact: true })
}

export function saved(page: Page): Locator {
  return contactForm(page).getByText(/^All changes saved/)
}

export function section(page: Page, heading: string): Locator {
  return page.locator('section', {
    has: page.getByRole('heading', { name: heading, exact: true }),
  })
}

/** Rows of the Emails / Phones / Addresses section. */
export function rows(page: Page, heading: string): Locator {
  return section(page, heading).locator('ul > li')
}

/** A second tab as user A: its own browser context and its own session. */
export async function secondTab(
  browser: Browser,
  baseURL: string,
  storageState: StorageState,
): Promise<Page> {
  const context = await browser.newContext({
    baseURL,
    storageState,
    viewport: { width: 1280, height: 800 },
  })
  await tapContext(context)
  return context.newPage()
}

/**
 * Set the value a timed `until` waits for on `page`. Predicates run in the
 * page and `arg` is fixed per flow, so a value that changes per repeat
 * goes through the window.
 */
export async function want(page: Page, value: string) {
  await page.evaluate((v) => {
    ;(window as unknown as { __qcWant?: string }).__qcWant = v
  }, value)
}

// ── in-page predicates (serialised: no closures, no imports) ──────────────

/** The contact form's text field labelled `arg` holds window.__qcWant. */
export function fieldHoldsWant(label: string) {
  const w = (window as unknown as { __qcWant?: string }).__qcWant
  for (const l of document.querySelectorAll('label')) {
    const span = l.querySelector('span')
    if (span?.childNodes[0]?.textContent === label)
      return l.querySelector('input')?.value === w
  }
  return false
}

/** A button whose text is window.__qcWant exists. */
export function buttonIsWant() {
  const w = (window as unknown as { __qcWant?: string }).__qcWant
  return [...document.querySelectorAll('button')].some(
    (b) => b.textContent === w,
  )
}

/** The save pane says every change is saved. */
export function paneSaved() {
  return [...document.querySelectorAll('span')].some((s) =>
    s.textContent.startsWith('All changes saved'),
  )
}
