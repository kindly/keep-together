import { expect, test } from '../fixtures'
import { nextTotp } from '../totp'
import {
  CONTACT_ROUTE,
  LIST_ROUTE,
  contactForm,
  createContact,
  saveButton,
  saved,
  secondTab,
  uniqueName,
} from './contact.helpers'
import type { Page } from '@playwright/test'

// Coming back to a contact opened before (perf-storage step 2, on the
// Rust backend's TanStack cache, migration-rust F3): it draws from the
// cache at once, stays live through the change stream, shows a change
// made while away from its first frame, and never shows another
// session's data. Idle views go after TanStack's gcTime (5 min), so the
// cache is bounded by time, not by Convex's 100-query cap.

const listRow = (page: Page, name: string) =>
  page.locator('main ul li a').filter({ hasText: name })

async function toList(page: Page) {
  await page.getByRole('link', { name: 'Contacts', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Contacts' })).toBeVisible()
}

test.describe(
  'contact cache',
  { annotation: [CONTACT_ROUTE, LIST_ROUTE] },
  () => {
    test('a revisit draws at once, then stays live', async ({
      page,
      flow,
      users,
      browser,
      baseURL,
      session,
    }) => {
      const last = uniqueName('revisit')
      const url = await createContact(page, users.a.slug, last)
      const name = `Qc ${last}`
      await flow(page, 'contact.revisit', {
        before: async () => {
          if (
            await page.getByRole('heading', { name, exact: true }).isVisible()
          )
            await toList(page)
          await expect(listRow(page, last)).toBeVisible()
        },
        action: () => listRow(page, last).click(),
        until: (n) => document.querySelector('main h1')?.textContent === n,
        arg: name,
      })

      // Live: an edit from another session lands on the revisited page.
      const other = await secondTab(browser, baseURL!, await session())
      try {
        await other.goto(url)
        await other.getByLabel('Known as').fill('edited elsewhere')
        await saveButton(other).click()
        await expect(saved(other)).toBeVisible()
        await expect(page.getByLabel('Known as')).toHaveValue(
          'edited elsewhere',
        )
      } finally {
        await other.context().close()
      }
    })

    test('an edit made while away shows on the revisit', async ({
      page,
      users,
      browser,
      baseURL,
      session,
    }) => {
      const last = uniqueName('stale')
      const url = await createContact(page, users.a.slug, last)
      await expect(page.getByLabel('Known as')).toHaveValue('')
      await toList(page)

      // While A is on the list, the contact's view sits idle in the cache.
      const other = await secondTab(browser, baseURL!, await session())
      try {
        await other.goto(url)
        await other.getByLabel('Known as').fill('changed while away')
        await other.getByLabel('Title', { exact: true }).fill('Dr')
        await saveButton(other).click()
        await expect(saved(other)).toBeVisible()
      } finally {
        await other.context().close()
      }
      // The change event has reached A and its refetch has landed.
      await page.waitForTimeout(500)

      // Every value the field shows, frame by frame, from the click on.
      await page.evaluate(() => {
        const w = window as unknown as { __qcSeen: Array<string> }
        w.__qcSeen = []
        const until = performance.now() + 5_000
        const tick = () => {
          for (const l of document.querySelectorAll('label')) {
            if (
              l.querySelector('span')?.childNodes[0]?.textContent !== 'Known as'
            )
              continue
            const v = l.querySelector('input')?.value
            if (v !== undefined && w.__qcSeen.at(-1) !== v) w.__qcSeen.push(v)
          }
          if (performance.now() < until) requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
      await listRow(page, last).click()
      await expect(page.getByLabel('Known as')).toHaveValue(
        'changed while away',
      )
      await page.waitForTimeout(300)
      // The first frame of the page already held the edit: no old value.
      expect(
        await page.evaluate(
          () => (window as unknown as { __qcSeen: Array<string> }).__qcSeen,
        ),
      ).toEqual(['changed while away'])
      await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Dr')
      await expect(contactForm(page).getByText('Up to date')).toBeVisible()
    })
  },
)

test.describe('the cache and tenancy', { annotation: CONTACT_ROUTE }, () => {
  test('a user switch drops the cache and shows none of A’s data', async ({
    page,
    users,
    world,
  }) => {
    test.setTimeout(60_000)
    const alpha = world.tenants[0].contactIds[0]
    const bravo = world.tenants[1].contactIds[0]
    const aContact = `/t/${users.a.slug}/contacts/${alpha}`
    // A opens one of A's contacts: its view goes into the cache.
    await page.goto(`/t/${users.a.slug}/contacts`)
    await page.locator(`main a[href="${aContact}"]`).click()
    await expect(page.getByRole('heading', { name: 'Details' })).toBeVisible()
    await toList(page)

    // Sign out in the app (no reload), then in as B.
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('button', { name: 'Sign out' })
      .click()
    await expect(page.getByPlaceholder('Email')).toBeVisible()
    await page.getByPlaceholder('Email').fill(users.b.email)
    await page.getByPlaceholder('Password').fill(users.b.password)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.getByPlaceholder('Code').fill(await nextTotp(users.b.totpSecret))
    await page.getByRole('button', { name: 'Verify' }).click()
    await expect(page).toHaveURL(`/t/${users.b.slug}`)

    // Client-side navigation, so the same client and its cache carry on.
    const clientNav = (to: string) =>
      page.evaluate((path) => {
        history.pushState({}, '', path)
        dispatchEvent(new PopStateEvent('popstate'))
      }, to)
    await clientNav(aContact)
    await expect(
      page.getByText(`No group called “${users.a.slug}” that you belong to.`),
    ).toBeVisible()
    await expect(page.locator('body')).not.toContainText('Alpha')

    // A's contact id inside B's own group: the server answers, not a cache.
    await clientNav(`/t/${users.b.slug}/contacts/${alpha}`)
    await expect(page.getByText('No such contact.')).toBeVisible()
    await expect(page.locator('body')).not.toContainText('Alpha')

    // And B's own contact renders as B's.
    await clientNav(`/t/${users.b.slug}/contacts/${bravo}`)
    await expect(page.getByRole('heading', { name: 'Details' })).toBeVisible()
    await expect(page.locator('main h1')).toContainText('Bravo')
    await expect(page.locator('body')).not.toContainText('Alpha')
  })
})
