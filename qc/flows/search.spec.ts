import { ConvexHttpClient } from 'convex/browser'
import { expect, test } from '../fixtures'
import type { Instance, QcUser } from '../fixtures'
import type { Page } from '@playwright/test'
import type { FlowName } from '../budgets'
import { api } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'
import { formatNumber } from '../../convex/contacts/number'
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

/** A client signed in as `user`, to read what the pages don't show. */
async function signedIn(
  inst: Instance,
  user: QcUser,
): Promise<ConvexHttpClient> {
  const client = new ConvexHttpClient(inst.url)
  const { tokens } = await client.action(api.auth.signIn, {
    provider: 'password',
    params: { email: user.email, password: user.password, flow: 'signIn' },
  })
  if (!tokens) throw new Error(`no session for ${user.email}`)
  client.setAuth(tokens.token)
  return client
}

/**
 * The written contact number of the only contact named `last`, read
 * through the API: the pages don't show numbers yet (contact numbers
 * step 4).
 */
async function writtenNumber(
  client: ConvexHttpClient,
  tenantId: string,
  last: string,
): Promise<string> {
  const { rows } = await client.query(api.contacts.queries.search, {
    tenantId: tenantId as Id<'tenants'>,
    search: last,
  })
  expect(rows).toHaveLength(1)
  expect(rows[0].number).not.toBeNull()
  return formatNumber(rows[0].number!)
}

/** The `until` for "the first row is `name`'s, badged as a number match". */
function numberFirst(name: string) {
  const first = document.querySelector('main ul li a')
  return (
    first !== null &&
    first.textContent.includes(name) &&
    first.textContent.includes('contact no.')
  )
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

test.describe('search by contact number', () => {
  test(
    'the number off a paper form finds the contact first',
    { annotation: [LIST_ROUTE] },
    async ({
      page,
      browser,
      baseURL,
      session,
      flow,
      users,
      world,
      instance,
    }) => {
      const last = `qcs-${token()}`
      await createContact(page, users.a.slug, last, 'Femi')
      const written = await writtenNumber(
        await signedIn(instance, users.a),
        world.tenants[0].tenantId,
        last,
      )
      await toList(page)
      const search = searchBox(page)
      await flow(page, 'contacts.search.number', {
        before: async () => {
          await search.fill('')
          await expect(listRows(page).nth(1)).toBeVisible()
        },
        action: () => search.fill(written),
        until: numberFirst,
        arg: last,
      })

      // Untimed: the sequence without its check digit, typed with a space.
      await search.fill(`${written.slice(0, 3)} ${written.slice(3, 5)}`)
      await expect(listRows(page).first()).toContainText(last)
      await expect(listRows(page).first()).toContainText(
        `contact no. ${written}`,
      )
      // A wrong check digit says so.
      const typo = written.slice(0, 5) + ((Number(written[5]) + 1) % 10)
      await search.fill(typo)
      await expect(
        page.getByText(
          `${typo} isn’t a valid contact number. Check the last digit.`,
        ),
      ).toBeVisible()
      await expect(page.locator('main')).not.toContainText(last)

      // B, in its own group, never sees A's contact by its number (B may
      // have its own contact with the same number). The page must show
      // what B's own search returns, so a stale or unsettled list can't
      // pass for an empty one.
      const asB = await signedIn(instance, users.b)
      const b = await secondTab(browser, baseURL!, await session(users.b))
      await b.goto(`/t/${users.b.slug}/contacts`)
      await expect(b.getByRole('heading', { name: 'Contacts' })).toBeVisible()
      for (const term of [written, written.slice(0, 5)]) {
        const inB = await asB.query(api.contacts.queries.search, {
          tenantId: world.tenants[1].tenantId as Id<'tenants'>,
          search: term,
        })
        expect(inB.rows.some((r) => r.displayName.includes(last))).toBe(false)
        await searchBox(b).fill('')
        await expect(b.getByText('No contacts match.')).toBeHidden()
        await searchBox(b).fill(term)
        if (inB.rows.length === 0) {
          await expect(b.getByText('No contacts match.')).toBeVisible()
        } else {
          await expect(listRows(b)).toHaveCount(inB.rows.length)
          await expect(listRows(b).first()).toContainText(
            inB.rows[0].displayName,
          )
          if (inB.numberMatch) {
            await expect(listRows(b).first()).toContainText(
              `contact no. ${written}`,
            )
          }
        }
        await expect(b.locator('main')).not.toContainText(last)
      }
      await b.context().close()
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
    // An address needs line 1 to be saved at all.
    await addRow(page, 'Addresses', {
      'Address line 1': '2 Orchard Way',
      Postcode: postcode,
    })
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
