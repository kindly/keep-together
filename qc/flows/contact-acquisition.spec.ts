import { expect, test } from '../fixtures'
import { runId } from '../timing'
import type { Page } from '@playwright/test'

// Source codes step 5 (factory/plans/source-codes.sv): the acquisition code
// picker on a contact and on the new-contact form, and the list's source
// filter. The seed (convex/platform/qcSeed.ts) gives each tenant
// Street-<Alpha|Bravo><run>-001/-002 and Event-Gala-001/-002, with Charles
// on Street-…-001 and the Trust on Street-…-002. Tests here set only
// Event-Gala codes, so the Street filter's answer stays those two.

const LIST = { type: 'route', description: '/t/$slug/contacts/' }
const NEW = { type: 'route', description: '/t/$slug/contacts/new' }
const CONTACT = { type: 'route', description: '/t/$slug/contacts/$contactId' }

const listPath = (slug: string) => `/t/${slug}/contacts`

function uniq(prefix: string): string {
  return `${prefix}${runId()}${Math.random().toString(36).slice(2, 8)}`
}

const picker = (page: Page) =>
  page.getByRole('combobox', { name: 'Source code' })
const shownCode = (page: Page) => page.getByTestId('source-code')

/** Type into the picker and wait for `code` among the matches. */
async function search(page: Page, term: string, code: string) {
  await picker(page).fill(term)
  await expect(page.getByRole('option', { name: code })).toBeVisible()
}

async function toNewForm(page: Page, slug: string) {
  await page.goto(listPath(slug))
  await page.getByRole('link', { name: 'New contact' }).click()
  await expect(page.getByRole('heading', { name: 'New contact' })).toBeVisible()
}

/** The `until` for "the list shows exactly these contacts". */
function exactly(hrefs: Array<string>) {
  const links = [...document.querySelectorAll('main ul li a')].map((a) =>
    a.getAttribute('href'),
  )
  return links.length === hrefs.length && hrefs.every((h) => links.includes(h))
}

test.describe('acquisition code', () => {
  test(
    'set a code on an existing contact',
    { annotation: [NEW, CONTACT] },
    async ({ page, flow, users }) => {
      const lastName = uniq('Coded')
      await toNewForm(page, users.a.slug)
      await page.getByLabel('First name').fill('Cody')
      await page.getByLabel('Last name').fill(lastName)
      await page.getByRole('button', { name: 'Create' }).click()
      await expect(
        page.getByRole('heading', { name: `Cody ${lastName}` }),
      ).toBeVisible()
      await expect(shownCode(page)).toHaveText('No source code.')

      await flow(page, 'contact.acquisition.set', {
        before: async () => {
          const clear = page.getByRole('button', { name: 'clear source code' })
          if (await clear.isVisible()) {
            await clear.click()
            await expect(shownCode(page)).toHaveText('No source code.')
          }
          await search(page, 'gala-001', 'Event-Gala-001')
        },
        action: () =>
          page.getByRole('option', { name: 'Event-Gala-001' }).click(),
        // Saved: the code shows and the clear button is back.
        until: () => {
          const el = document.querySelector('[data-testid="source-code"]')
          return Boolean(
            el?.textContent.includes('Event-Gala-001') &&
            el.querySelector('button[aria-label="clear source code"]'),
          )
        },
      })
      // History names the action after the code.
      await expect(
        page.getByText('acquisition code Event-Gala-001').first(),
      ).toBeVisible()
      // And it survives a reload.
      await page.reload()
      await expect(shownCode(page)).toContainText('Event-Gala-001')
    },
  )

  test(
    'create a contact with a code',
    { annotation: [NEW, CONTACT] },
    async ({ page, flow, users }) => {
      await flow(page, 'contacts.createWithCode', {
        before: async () => {
          await toNewForm(page, users.a.slug)
          const lastName = uniq('New')
          await page.getByLabel('First name').fill('Nia')
          await page.getByLabel('Last name').fill(lastName)
          await search(page, 'GALA-002', 'Event-Gala-002')
          await page.getByRole('option', { name: 'Event-Gala-002' }).click()
          await expect(shownCode(page)).toContainText('Event-Gala-002')
          await page.evaluate((n) => {
            ;(window as unknown as { __qcName: string }).__qcName = n
          }, `Nia ${lastName}`)
        },
        action: () => page.getByRole('button', { name: 'Create' }).click(),
        until: () =>
          document.querySelector('main h1')?.textContent ===
            (window as unknown as { __qcName: string }).__qcName &&
          Boolean(
            document
              .querySelector('[data-testid="source-code"]')
              ?.textContent.includes('Event-Gala-002'),
          ),
      })
      await expect(
        page.getByText('new contact, acquisition code Event-Gala-002'),
      ).toBeVisible()
    },
  )
})

test.describe('the source filter', () => {
  test(
    'by category, then down to a version',
    { annotation: [LIST] },
    async ({ page, flow, users, world }) => {
      const [, charles, trust] = world.tenants[0].contactIds
      const href = (id: string) => `${listPath(users.a.slug)}/${id}`
      await page.goto(listPath(users.a.slug))
      const category = page.getByLabel('Filter by source category')
      const rows = page.locator('main ul li a')

      // A trusted ArrowDown from the option just above (selectOption's
      // events are synthetic and start no timer), as tags.filter does.
      const above = async (select: typeof category, label: string) => {
        // Once the options have loaded.
        await expect(
          select.locator('option', { hasText: new RegExp(`^${label}$`) }),
        ).toHaveCount(1)
        const options = await select.locator('option').allTextContents()
        return options[options.indexOf(label) - 1]
      }
      const categoryAbove = await above(category, 'Street')
      await flow(page, 'contacts.filter.sourceCategory', {
        before: async () => {
          await category.selectOption({ label: categoryAbove })
          await expect(
            page.locator(`main a[href="${href(charles)}"]`),
          ).toBeHidden()
          await category.focus()
        },
        action: () => category.press('ArrowDown'),
        until: exactly,
        arg: [href(charles), href(trust)],
      })

      const version = page.getByLabel('Filter by source version')
      await page
        .getByLabel('Filter by source detail')
        .selectOption({ label: `Alpha${runId()}` })
      await expect(version).toBeVisible()
      const versionAbove = await above(version, '002')
      await flow(page, 'contacts.filter.sourceVersion', {
        before: async () => {
          await version.selectOption({ label: versionAbove })
          await expect(
            page.locator(`main a[href="${href(trust)}"]`),
          ).toBeHidden()
          await version.focus()
        },
        action: () => version.press('ArrowDown'),
        until: exactly,
        arg: [href(trust)],
      })

      // With search text too: the Trust's name, under the version it isn't on.
      await version.selectOption({ label: '001' })
      await page.getByRole('searchbox').fill('Trust')
      await expect(page.getByText('No contacts match.')).toBeVisible()
      await version.selectOption({ label: '002' })
      await expect(rows).toHaveCount(1)
      await expect(rows.first()).toHaveAttribute('href', href(trust))
    },
  )
})
