import { convexOn, expect, test } from '../fixtures'
import { runId } from '../timing'
import { secondTab } from './contact.helpers'
import type { Page } from '@playwright/test'

// QC step 7 (factory/plans/qc-suite.sv): the contacts list and the new
// contact form. Tests run as user A in tenant A. The world is shared by
// every test in a worker, and step 8 edits seeded contacts, so each test
// that depends on a name creates its own contact (names unique per run
// and test) instead of relying on a seeded one keeping its name.

const LIST = { type: 'route', description: '/t/$slug/contacts/' }
const NEW = { type: 'route', description: '/t/$slug/contacts/new' }
const CONTACT = { type: 'route', description: '/t/$slug/contacts/$contactId' }

const listPath = (slug: string) => `/t/${slug}/contacts`

/** Rows per list page: LIST_PAGE_SIZE in src/lib/paged-list.ts. */
const LIST_PAGE_SIZE = 100

/** A name token unique to this run and call, safe for the search index. */
function uniq(prefix: string): string {
  return `${prefix}${runId()}${Math.random().toString(36).slice(2, 8)}`
}

/** A list row: the link to a contact. */
const rows = (page: Page) => page.locator('main ul li a')
const row = (page: Page, name: string) => rows(page).filter({ hasText: name })

/** Client-navigate to the list through the header link (or load it). */
async function toList(page: Page, slug: string) {
  const header = page.getByRole('link', { name: 'Contacts', exact: true })
  if (await header.isVisible()) await header.click()
  else await page.goto(listPath(slug))
  await expect(page.getByRole('heading', { name: 'Contacts' })).toBeVisible()
}

/** From anywhere in the tenant, open the new contact form. */
async function toNewForm(page: Page, slug: string) {
  await toList(page, slug)
  await page.getByRole('link', { name: 'New contact' }).click()
  await expect(page.getByRole('heading', { name: 'New contact' })).toBeVisible()
}

/** Create an individual through the form (untimed); returns its id. */
async function createIndividual(
  page: Page,
  slug: string,
  firstName: string,
  lastName: string,
): Promise<string> {
  await toNewForm(page, slug)
  await page.getByLabel('First name').fill(firstName)
  await page.getByLabel('Last name').fill(lastName)
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(
    page.getByRole('heading', { name: `${firstName} ${lastName}` }),
  ).toBeVisible()
  return contactIdFromUrl(page)
}

function contactIdFromUrl(page: Page): string {
  const id = new URL(page.url()).pathname.match(/\/contacts\/([^/]+)$/)?.[1]
  if (!id || id === 'new')
    throw new Error(`not on a contact page: ${page.url()}`)
  return id
}

/** The `until` for "the list shows exactly one row, and it has `name`". */
function onlyRow(name: string) {
  const links = [...document.querySelectorAll('main ul li a')]
  return links.length === 1 && links[0].textContent.includes(name)
}

test.describe('contacts list', () => {
  test(
    'renders the list with the seeded contacts',
    { annotation: [LIST] },
    async ({ page, users, world }) => {
      await page.goto(listPath(users.a.slug))
      await expect(
        page.getByRole('heading', { name: 'Contacts' }),
      ).toBeVisible()
      await expect(page.getByRole('searchbox')).toBeVisible()
      await expect(page.getByLabel('show archived')).not.toBeChecked()
      await expect(
        page.getByRole('link', { name: 'New contact' }),
      ).toBeVisible()
      // By href, not name: step 8 may be editing a seeded contact's name.
      for (const id of world.tenants[0].contactIds) {
        await expect(
          page.locator(`main a[href="${listPath(users.a.slug)}/${id}"]`),
        ).toBeVisible()
      }
    },
  )

  test(
    'cold load renders the list',
    { annotation: [LIST] },
    async ({ page, flow, users, world }) => {
      const url = listPath(users.a.slug)
      await flow(page, 'contacts.coldLoad', {
        before: () => page.goto('about:blank').then(() => undefined),
        action: () =>
          page.goto(url, { waitUntil: 'commit' }).then(() => undefined),
        start: 'navigation',
        // Any seeded contact's row: the list query has answered and rendered.
        until: (ids) =>
          ids.some((id) => document.querySelector(`main a[href$="/${id}"]`)),
        arg: world.tenants[0].contactIds,
      })
    },
  )

  test(
    'search narrows the list to a match',
    { annotation: [LIST] },
    async ({ page, flow, users }) => {
      const lastName = uniq('Search')
      await createIndividual(page, users.a.slug, 'Sam', lastName)
      await toList(page, users.a.slug)
      const search = page.getByRole('searchbox')
      await flow(page, 'contacts.search', {
        before: async () => {
          await search.fill('')
          await expect(rows(page).nth(1)).toBeVisible()
        },
        // fill() is one input event: t0 is when the whole term arrives.
        action: () => search.fill(lastName),
        until: onlyRow,
        arg: lastName,
        server: true,
      })
    },
  )

  test(
    'search by exact email finds the contact',
    { annotation: [LIST] },
    async ({ page, users, world }) => {
      // The seeded Ada's primary email (convex/platform/qcSeed.ts). Step 8
      // edits emails on contacts it creates, not this one.
      const email = `ada-${users.a.slug}@example.com`
      const adaId = world.tenants[0].contactIds[0]
      await page.goto(listPath(users.a.slug))
      await page.getByRole('searchbox').fill(email)
      await expect(rows(page)).toHaveCount(1)
      await expect(rows(page).first()).toHaveAttribute(
        'href',
        `${listPath(users.a.slug)}/${adaId}`,
      )
      await expect(rows(page).first()).toContainText(email)
    },
  )

  test(
    'search by exact identifier opens the contact',
    { annotation: [LIST, CONTACT] },
    async ({ page, flow, users, world }) => {
      // The seeded Ada's identifier (convex/platform/qcSeed.ts); B's Ada
      // holds the same value, and must not show here.
      const { shared } = world.identifiers
      const adaId = world.tenants[0].contactIds[0]
      const adaHref = `${listPath(users.a.slug)}/${adaId}`
      await page.goto(listPath(users.a.slug))
      const search = page.getByRole('searchbox')
      await flow(page, 'contacts.searchIdentifier', {
        before: async () => {
          await search.fill('')
          await expect(rows(page).nth(1)).toBeVisible()
        },
        // Typed with different case and spaces: matching is normalised.
        action: () => search.fill(`  ${shared.toLowerCase()} `),
        until: (href) => {
          const links = [...document.querySelectorAll('main ul li a')]
          return links.length === 1 && links[0].getAttribute('href') === href
        },
        arg: adaHref,
        server: true,
      })
      await rows(page).first().click()
      await expect(page).toHaveURL(adaHref)
      await expect(
        page
          .locator('section', {
            has: page.getByRole('heading', { name: 'Identifiers' }),
          })
          .getByText(shared, { exact: true }),
      ).toBeVisible()
    },
  )

  test(
    'show archived reveals an archived contact',
    { annotation: [LIST, CONTACT] },
    async ({ page, flow, users }) => {
      const lastName = uniq('Archived')
      await createIndividual(page, users.a.slug, 'Avery', lastName)
      await page.getByRole('button', { name: 'Archive' }).click()
      await expect(
        page.getByRole('button', { name: 'Unarchive' }),
      ).toBeVisible()
      await toList(page, users.a.slug)
      await page.getByRole('searchbox').fill(lastName)
      await expect(page.getByText('No contacts match.')).toBeVisible()
      const toggle = page.getByLabel('show archived')
      await flow(page, 'contacts.showArchived', {
        before: async () => {
          await toggle.uncheck()
          await expect(page.getByText('No contacts match.')).toBeVisible()
        },
        action: () => toggle.check(),
        until: onlyRow,
        arg: lastName,
        server: true,
      })
      await expect(row(page, lastName)).toContainText('archived')
    },
  )

  test(
    'client navigation between the list and a contact',
    { annotation: [LIST, CONTACT] },
    async ({ page, flow, users }) => {
      const lastName = uniq('Nav')
      const name = `Nora ${lastName}`
      await createIndividual(page, users.a.slug, 'Nora', lastName)
      await toList(page, users.a.slug)
      // Every repeat starts on a freshly loaded list, with the row
      // rendered: a contact opened in the last 2 minutes draws from the
      // keep-alive cache (contact.revisit times that), so a client
      // navigation back would never ask the server.
      await flow(page, 'contacts.nav', {
        before: async () => {
          await page.goto(listPath(users.a.slug))
          await expect(row(page, lastName)).toBeVisible()
        },
        action: () => row(page, lastName).click(),
        until: (n) => document.querySelector('main h1')?.textContent === n,
        arg: name,
        server: true,
      })
      // And back: every repeat starts on the contact page.
      await flow(page, 'contacts.nav', {
        before: async () => {
          const heading = page.getByRole('heading', { name, exact: true })
          if (!(await heading.isVisible())) await row(page, lastName).click()
          await expect(heading).toBeVisible()
        },
        action: () =>
          page.getByRole('link', { name: 'Contacts', exact: true }).click(),
        until: (n) =>
          [...document.querySelectorAll('main ul li a')].some((a) =>
            a.textContent.includes(n),
          ),
        arg: lastName,
        server: true,
      })
    },
  )

  test(
    'Load more shows the next page, and a page that grows splits without loss',
    { annotation: [LIST] },
    async ({ browser, baseURL, flow, instance, session, users, world }) => {
      test.setTimeout(120_000)
      // In B, whose list no timed flow browses, so A's list stays the size
      // the other flows were budgeted on.
      const crowd = (lastName: string, count: number) =>
        convexOn(instance, [
          'run',
          'platform/qcSeed:crowd',
          JSON.stringify({
            tenantId: world.tenants[1].tenantId,
            lastName,
            count,
          }),
        ])
      // After B's seeded `Bravo-<run>` contacts: more than two pages.
      await crowd(uniq('Crowd'), 2 * LIST_PAGE_SIZE)
      const b = await secondTab(browser, baseURL!, await session(users.b))
      const links = rows(b)
      const more = b.getByRole('button', { name: 'Load more' })
      const hrefs = async () =>
        links.evaluateAll((as) => as.map((a) => a.getAttribute('href')))

      await flow(b, 'contacts.loadMore', {
        before: async () => {
          await b.goto(listPath(users.b.slug))
          await expect(links).toHaveCount(LIST_PAGE_SIZE)
          await expect(more).toBeEnabled()
        },
        action: () => more.click(),
        until: (n) => document.querySelectorAll('main ul li a').length > n,
        arg: LIST_PAGE_SIZE,
      })
      await expect(links).toHaveCount(2 * LIST_PAGE_SIZE)
      const before = await hrefs()
      expect(new Set(before).size).toBe(before.length)

      // Page 0 is now pinned to end where page 1 starts. Contacts arriving
      // in its range grow it past LIST_PAGE_MAX_ROWS
      // (convex/contacts/queries.ts). The backend reads the grown range in
      // full (whatever maximumRowsRead says), and `list` answers it with no
      // rows, SplitRequired and a splitCursor: that call is the server
      // exception in qc/budgets.ts. The list keeps its rows on screen while
      // it loads the halves (paged-list.ts). Every row still shows, once.
      const early = uniq('Aardvark')
      const arriving = 250
      // 100 a transaction, as every bulk write here commits.
      await crowd(early, arriving)
      await expect(links).toHaveCount(before.length + arriving, {
        timeout: 30_000,
      })
      const after = await hrefs()
      expect(new Set(after).size).toBe(after.length)
      expect(after.slice(arriving)).toEqual(before)
      await expect(links.filter({ hasText: early })).toHaveCount(arriving)
      // And the list carries on past page 1.
      await more.click()
      await expect
        .poll(async () => (await hrefs()).length)
        .toBeGreaterThan(after.length)
      const all = await hrefs()
      expect(new Set(all).size).toBe(all.length)
      await b.context().close()
    },
  )
})

test.describe('new contact', () => {
  for (const kind of ['individual', 'organization'] as const) {
    test(
      `create an ${kind} lands on its contact page`,
      { annotation: [NEW, CONTACT] },
      async ({ page, flow, users }) => {
        const label = kind === 'individual' ? 'Ind' : 'Org'
        await flow(page, 'contacts.create', {
          before: async () => {
            await toNewForm(page, users.a.slug)
            const lastName = uniq(label)
            let name: string
            if (kind === 'individual') {
              await page.getByLabel('First name').fill('Ivy')
              await page.getByLabel('Last name').fill(lastName)
              name = `Ivy ${lastName}`
            } else {
              await page.getByLabel('Kind').selectOption('organization')
              name = `${lastName} Trust`
              await page.getByLabel('Name', { exact: true }).fill(name)
            }
            // `until` is serialised, so each repeat's name goes via window.
            await page.evaluate((n) => {
              ;(window as unknown as { __qcName: string }).__qcName = n
            }, name)
          },
          action: () => page.getByRole('button', { name: 'Create' }).click(),
          until: () =>
            document.querySelector('main h1')?.textContent ===
            (window as unknown as { __qcName: string }).__qcName,
        })
        await expect(page).toHaveURL(/\/contacts\/(?!new$)[^/]+$/)
      },
    )
  }

  test(
    'invalid input shows inline problems',
    { annotation: [NEW] },
    async ({ page, users }) => {
      await toNewForm(page, users.a.slug)
      const create = page.getByRole('button', { name: 'Create' })

      // An individual needs a last name.
      await page.getByLabel('First name').fill('Nameless')
      await create.click()
      await expect(
        page.getByText('An individual needs a last name'),
      ).toBeVisible()
      await expect(page).toHaveURL(/\/contacts\/new$/)

      // An organisation needs a name.
      await page.getByLabel('Kind').selectOption('organization')
      await create.click()
      await expect(page.getByText('A organization needs a name')).toBeVisible()
      await expect(page).toHaveURL(/\/contacts\/new$/)
      await expect(
        page.getByRole('heading', { name: 'New contact' }),
      ).toBeVisible()
    },
  )

  test(
    'a double-click on Create lands on one contact',
    { annotation: [NEW, CONTACT, LIST] },
    async ({ page, users }) => {
      const lastName = uniq('Double')
      await toNewForm(page, users.a.slug)
      await page.getByLabel('First name').fill('Dee')
      await page.getByLabel('Last name').fill(lastName)
      await page.getByRole('button', { name: 'Create' }).dblclick()
      await expect(
        page.getByRole('heading', { name: `Dee ${lastName}` }),
      ).toBeVisible()
      const id = contactIdFromUrl(page)

      // The clientKey dedupe: one contact, the one we landed on.
      await toList(page, users.a.slug)
      await page.getByRole('searchbox').fill(lastName)
      await expect(rows(page)).toHaveCount(1)
      await expect(rows(page).first()).toHaveAttribute(
        'href',
        `${listPath(users.a.slug)}/${id}`,
      )
    },
  )
})
