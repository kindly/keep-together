import { expect, test } from '../fixtures'
import type { Page } from '@playwright/test'
import type { FlowName } from '../budgets'
import {
  LIST_ROUTE,
  createContact,
  rows,
  saveButton,
  saved,
  secondTab,
  section,
} from './contact.helpers'

// Search plan Q2: one search box finds a contact by a phone, a postcode,
// part of an email, or an organisation name, each under 100 ms like the
// name search (contacts.search in contacts.spec.ts). Each test makes its
// own contact with values no other contact in the worker's tenant has
// (random per test), so "exactly one row" means the search found it.

let made = 0
/** Lowercase letters and digits unique to this worker and call. */
function token(): string {
  made += 1
  return `${process.pid.toString(36)}${made}${Math.random().toString(36).slice(2, 6)}`
}
const digits = (n: number) =>
  Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('')
const letters = (n: number) =>
  Array.from({ length: n }, () =>
    String.fromCharCode(97 + Math.floor(Math.random() * 26)),
  ).join('')

const listRows = (page: Page) => page.locator('main ul li a')
const searchBox = (page: Page) =>
  page.getByRole('searchbox', { name: 'Search contacts' })

/** The `until` for "the list shows exactly one row, and it has `name`". */
function onlyRow(name: string) {
  const links = [...document.querySelectorAll('main ul li a')]
  return links.length === 1 && links[0].textContent.includes(name)
}

async function toList(page: Page) {
  await page.getByRole('link', { name: 'Contacts', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Contacts' })).toBeVisible()
}

/** On a contact page: add one phone / email / address row and save. */
async function addRow(
  page: Page,
  heading: 'Phones' | 'Emails' | 'Addresses',
  fill: Record<string, string>,
) {
  await section(page, heading).getByRole('button', { name: 'add' }).click()
  const row = rows(page, heading).last()
  for (const [placeholder, value] of Object.entries(fill)) {
    await row.getByPlaceholder(placeholder).fill(value)
  }
  await saveButton(page).click()
  await expect(saved(page)).toBeVisible()
}

/** Time typing `term` into the search until only `name`'s row shows. */
async function timeSearch(
  page: Page,
  flow: Parameters<Parameters<typeof test>[2]>[0]['flow'],
  name: string,
  term: string,
  flowName: FlowName,
) {
  const search = searchBox(page)
  await flow(page, flowName, {
    before: async () => {
      await search.fill('')
      await expect(listRows(page).nth(1)).toBeVisible()
    },
    // fill() is one input event: t0 is when the whole term arrives.
    action: () => search.fill(term),
    until: onlyRow,
    arg: name,
  })
}

test.describe('search by what you have in front of you', () => {
  test(
    'a phone number, typed with spaces',
    { annotation: [LIST_ROUTE] },
    async ({ page, flow, users }) => {
      const last = `qcs-${token()}`
      const tail = digits(6)
      await createContact(page, users.a.slug, last, 'Femi')
      await addRow(page, 'Phones', { 'phone number': `+44 7700 ${tail}` })
      await toList(page)
      await timeSearch(
        page,
        flow,
        last,
        `07700 ${tail}`,
        'contacts.search.phone',
      )
    },
  )

  test(
    'a postcode, typed without its space',
    { annotation: [LIST_ROUTE] },
    async ({ page, flow, users }) => {
      const last = `qcs-${token()}`
      const postcode = `Q${letters(1).toUpperCase()}${digits(2)} ${digits(1)}${letters(2).toUpperCase()}`
      await createContact(page, users.a.slug, last, 'Femi')
      await addRow(page, 'Addresses', {
        'Address line 1': '7 Mill Lane',
        Town: 'Stroud',
        Postcode: postcode,
      })
      await toList(page)
      await timeSearch(
        page,
        flow,
        last,
        postcode.replace(' ', '').toLowerCase(),
        'contacts.search.postcode',
      )
    },
  )

  test(
    'part of an email address',
    { annotation: [LIST_ROUTE] },
    async ({ page, flow, users }) => {
      const last = `qcs-${token()}`
      const domain = `mail${token()}`
      await createContact(page, users.a.slug, last, 'Femi')
      await addRow(page, 'Emails', {
        'email address': `femi@${domain}.example`,
      })
      await toList(page)
      await timeSearch(page, flow, last, domain, 'contacts.search.emailPart')
    },
  )

  test(
    'an organisation by two words of its name',
    { annotation: [LIST_ROUTE] },
    async ({ page, flow, users }) => {
      const word = `Orchard${token()}`
      const name = `${word} Allotment Society`
      await page.goto(`/t/${users.a.slug}/contacts/new`)
      await page.getByLabel('Kind').selectOption('organization')
      await page.getByLabel('Name', { exact: true }).fill(name)
      await page.getByRole('button', { name: 'Create' }).click()
      await expect(page.getByRole('heading', { name })).toBeVisible()
      await toList(page)
      // The kind chip narrows to organisations as well.
      await page
        .getByRole('group', { name: 'Filter by kind' })
        .getByRole('button', { name: 'organisations' })
        .click()
      await timeSearch(
        page,
        flow,
        name,
        `${word.toLowerCase()} allot`,
        'contacts.search.org',
      )
    },
  )
})

test(
  "B finds none of A's contacts by phone, postcode, email part or organisation",
  { annotation: [LIST_ROUTE] },
  async ({ page, browser, baseURL, session, users }) => {
    const last = `qcs-${token()}`
    const tail = digits(6)
    const postcode = `Q${letters(1).toUpperCase()}${digits(2)} ${digits(1)}${letters(2).toUpperCase()}`
    const domain = `mail${token()}`
    const org = `Orchard${token()} Society`
    await createContact(page, users.a.slug, last, 'Femi')
    await addRow(page, 'Phones', { 'phone number': `07700 ${tail}` })
    await addRow(page, 'Emails', { 'email address': `femi@${domain}.example` })
    await addRow(page, 'Addresses', { Postcode: postcode })
    await page.goto(`/t/${users.a.slug}/contacts/new`)
    await page.getByLabel('Kind').selectOption('organization')
    await page.getByLabel('Name', { exact: true }).fill(org)
    await page.getByRole('button', { name: 'Create' }).click()
    await expect(page.getByRole('heading', { name: org })).toBeVisible()

    // A finds each one (the terms work)...
    await toList(page)
    for (const term of [`07700${tail}`, postcode, domain, org]) {
      await searchBox(page).fill(term)
      await expect(listRows(page)).toHaveCount(1)
    }

    // ...and B, in its own group, finds none of them.
    const b = await secondTab(browser, baseURL!, await session(users.b))
    await b.goto(`/t/${users.b.slug}/contacts`)
    await expect(b.getByRole('heading', { name: 'Contacts' })).toBeVisible()
    for (const term of [`07700 ${tail}`, tail, postcode, domain, org]) {
      await searchBox(b).fill(term)
      await expect(b.getByText('No contacts match.')).toBeVisible()
    }
    await searchBox(b).fill('')
    await b
      .getByRole('group', { name: 'Filter by kind' })
      .getByRole('button', { name: 'organisations' })
      .click()
    await expect(listRows(b).first()).toBeVisible()
    await expect(b.locator('main')).not.toContainText(org)
    await b.context().close()
  },
)
