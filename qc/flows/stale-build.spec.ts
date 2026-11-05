import { expect, test } from '../fixtures'
import type { Page } from '@playwright/test'

// A tab open across a deploy: the chunks it hasn't loaded yet are gone
// (404) on the server. Going to a page whose code it never loaded reloads
// the tab once, onto that page (src/lib/stale-build.ts). Untimed.

const HOME = { type: 'route', description: '/t/$slug/' }
const CONTACTS = { type: 'route', description: '/t/$slug/contacts/' }

/**
 * From now on, every file under /assets/ the page hasn't already loaded
 * answers 404, as after a deploy; with `fixedAfterReload`, only until
 * the next full page load (the new build's index names files that
 * exist). Returns the number of full page loads since.
 */
async function deploy(page: Page, opts: { fixedAfterReload: boolean }) {
  const loaded = new Set(
    await page.evaluate(() =>
      performance.getEntriesByType('resource').map((e) => e.name),
    ),
  )
  let stale = true
  let loads = 0
  page.on('load', () => {
    loads++
    if (opts.fixedAfterReload) stale = false
  })
  await page.route('**/assets/**', (route) =>
    stale && !loaded.has(route.request().url())
      ? route.fulfill({ status: 404, body: 'gone' })
      : route.fallback(),
  )
  return () => loads
}

test(
  'a missing chunk on the way to a page reloads once, onto that page',
  { annotation: [HOME, CONTACTS] },
  async ({ page, users }) => {
    const slug = users.a.slug
    await page.goto(`/t/${slug}`)
    const nav = page.getByRole('navigation', { name: 'Main' })
    await expect(nav).toBeVisible()
    const loads = await deploy(page, { fixedAfterReload: true })

    await nav.getByRole('link', { name: 'Contacts' }).click()
    await expect(page).toHaveURL(`/t/${slug}/contacts`)
    await expect(
      page.getByRole('heading', { level: 1, name: 'Contacts' }),
    ).toBeVisible()
    expect(loads()).toBe(1)
    await expect(page.getByText('A new version is available.')).toBeHidden()
    await expect(page.getByText('Something went wrong!')).toBeHidden()
  },
)

test(
  'when the reload does not fix it, the error shows and the tab stops reloading',
  { annotation: [HOME, CONTACTS] },
  async ({ page, users }) => {
    const slug = users.a.slug
    await page.goto(`/t/${slug}`)
    const nav = page.getByRole('navigation', { name: 'Main' })
    await expect(nav).toBeVisible()
    const loads = await deploy(page, { fixedAfterReload: false })

    await nav.getByRole('link', { name: 'Contacts' }).click()
    // The error can show on the page a reload is about to replace: the old
    // page renders it while the reload's request is in flight (keep-qc,
    // run 41950533339: error visible at 0 loads, the tab blank and mid-load
    // in the failure screenshot). So wait until the count of loads has held
    // for a second with the error on screen, then judge it.
    const error = page.getByText('Something went wrong!')
    let last = -1
    await expect
      .poll(
        async () => {
          const n = loads()
          const held = n === last
          last = n
          return held && (await error.isVisible())
        },
        { timeout: 15_000, intervals: [1_000] },
      )
      .toBe(true)
    await expect(page).toHaveURL(`/t/${slug}/contacts`)
    // Ours, then TanStack Router's own once-per-module reload at most.
    const settled = loads()
    expect(settled).toBeGreaterThanOrEqual(1)
    expect(settled).toBeLessThanOrEqual(2)
    await page.waitForTimeout(2_000)
    expect(loads()).toBe(settled)
  },
)
