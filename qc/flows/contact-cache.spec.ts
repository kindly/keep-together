import { expect, test } from '../fixtures'
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
import type { BrowserContext, Page } from '@playwright/test'

// The contact page's keep-alive cache (factory/plans/perf-storage.sv, step
// 2, src/lib/query-cache.tsx): coming back to a contact opened in the last
// 2 minutes draws from the held subscriptions, stays live, never shows
// another session's data, and holds a bounded number of queries.

/** Past the loader prewarm's 5 s hold, so only the cache can explain a hit. */
const PAST_PREWARM_MS = 5_500

const listRow = (page: Page, name: string) =>
  page.locator('main ul li a').filter({ hasText: name })

async function toList(page: Page) {
  await page.getByRole('link', { name: 'Contacts', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Contacts' })).toBeVisible()
}

/** Queries the page holds on the Convex WebSocket, by function path. */
interface Subscriptions {
  live: () => Array<string>
}

/**
 * Track every query the page subscribes to (ModifyQuerySet Add / Remove)
 * through a pass-through route; set up before the page loads.
 */
async function trackSubscriptions(
  context: BrowserContext,
): Promise<Subscriptions> {
  const live = new Map<string, Map<number, string>>()
  let socket = 0
  await context.routeWebSocket(/.*/, (ws) => {
    const id = String(++socket)
    const mine = new Map<number, string>()
    live.set(id, mine)
    const server = ws.connectToServer()
    ws.onMessage((m) => {
      server.send(m)
      if (typeof m !== 'string') return
      const msg = JSON.parse(m) as {
        type?: string
        modifications?: Array<{
          type: 'Add' | 'Remove'
          queryId: number
          udfPath?: string
        }>
      }
      if (msg.type !== 'ModifyQuerySet') return
      for (const mod of msg.modifications ?? []) {
        if (mod.type === 'Add') mine.set(mod.queryId, mod.udfPath ?? '?')
        else mine.delete(mod.queryId)
      }
    })
    server.onMessage((m) => ws.send(m))
    ws.onClose(() => live.delete(id))
  })
  return { live: () => [...live.values()].flatMap((m) => [...m.values()]) }
}

const count = (paths: Array<string>, path: string) =>
  paths.filter((p) => p === path).length

test.describe(
  'contact keep-alive cache',
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
      // Each repeat waits out the prewarm hold: 7 repeats × ~6 s.
      test.setTimeout(150_000)
      const last = uniqueName('revisit')
      const url = await createContact(page, users.a.slug, last)
      const name = `Qc ${last}`
      let leftAt = 0
      await flow(page, 'contact.revisit', {
        before: async () => {
          if (
            await page.getByRole('heading', { name, exact: true }).isVisible()
          )
            await toList(page)
          leftAt = leftAt || Date.now()
          await expect(listRow(page, last)).toBeVisible()
          const wait = PAST_PREWARM_MS - (Date.now() - leftAt)
          if (wait > 0) await page.waitForTimeout(wait)
          leftAt = 0
        },
        action: () => listRow(page, last).click(),
        until: (n) => document.querySelector('main h1')?.textContent === n,
        arg: name,
      })
      // Every sample began on the list, past the prewarm hold, so the
      // contact's queries were held by the cache alone.

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

      // While A is on the list, the contact's queries sit idle in the cache.
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

    test('memory is bounded: 100 idle queries at most', async ({
      page,
      users,
    }) => {
      // CACHE_MAX_IDLE is 100 and a contact leaves 4 queries of its own:
      // 27 contacts go past it. The first two visits measure that 4.
      test.setTimeout(300_000)
      const visits: Array<{ last: string; path: string }> = []
      for (let i = 0; i < 27; i++) {
        const last = uniqueName(`bound${i}`)
        const url = await createContact(page, users.a.slug, last)
        visits.push({ last, path: new URL(url).pathname })
      }
      const subs = await trackSubscriptions(page.context())
      await page.goto(`/t/${users.a.slug}/contacts`)
      // What is left once the loader prewarms (5 s) lapse: the cache's
      // queries, without the list page's own.
      const heldNow = async () => {
        await page.waitForTimeout(PAST_PREWARM_MS)
        const live = subs.live()
        return {
          live,
          held: live.filter(
            (p) =>
              ![
                'platform/tenants:mine',
                'contacts/queries:list',
                // The list's source filter options.
                'sources/queries:filterOptions',
              ].includes(p),
          ),
        }
      }
      const afterVisit: Array<number> = []
      for (const { last, path } of visits) {
        // In-app navigation (the list shows at most 100 rows), so the
        // cache lives on between visits.
        await page.evaluate((to) => {
          history.pushState({}, '', to)
          dispatchEvent(new PopStateEvent('popstate'))
        }, path)
        await expect(page.getByRole('heading', { name: last })).toBeVisible()
        await expect(page.getByText('Loading…')).toHaveCount(0)
        await toList(page)
        if (afterVisit.length < 2)
          afterVisit.push((await heldNow()).held.length)
      }
      // The second contact added only its own queries; the first also
      // brought the ones every contact shares. Enough visits to pass the
      // cap, or the bound below proves nothing.
      const perContact = afterVisit[1] - afterVisit[0]
      const shared = afterVisit[0] - perContact
      test.info().annotations.push({
        type: 'idle queries',
        description: `${perContact} per contact, ${shared} shared`,
      })
      expect(perContact).toBe(4)
      expect(visits.length * perContact + shared).toBeGreaterThan(100)
      const { live, held } = await heldNow()
      test.info().annotations.push({
        type: 'held queries',
        description: JSON.stringify(live),
      })
      expect(held.length).toBeGreaterThan(0)
      expect(held.length).toBeLessThanOrEqual(100)
      // 27 contacts × 4 of their own queries is past the cap, so the last
      // ones left were dropped as they went idle (convex-helpers drops the
      // newest idle query, not the oldest): not every root is held, but
      // many more than the old cap's 4 contacts.
      const roots = count(live, 'contacts/queries:getRoot')
      expect(roots).toBeLessThan(visits.length)
      expect(roots).toBeGreaterThanOrEqual(15)
      // History is fetched, never held: a held one re-runs on every save.
      expect(count(live, 'contacts/queries:history')).toBe(0)
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
    const subs = await trackSubscriptions(page.context())
    const alpha = world.tenants[0].contactIds[0]
    const bravo = world.tenants[1].contactIds[0]
    const aContact = `/t/${users.a.slug}/contacts/${alpha}`
    // A opens one of A's contacts: its queries go into the cache.
    await page.goto(`/t/${users.a.slug}/contacts`)
    await page.locator(`main a[href="${aContact}"]`).click()
    await expect(page.getByRole('heading', { name: 'Details' })).toBeVisible()
    await toList(page)
    expect(count(subs.live(), 'contacts/queries:getRoot')).toBe(1)

    // Sign out in the app (no reload), then in as B.
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Settings' })
      .click()
    await page.getByRole('button', { name: 'Sign out' }).click()
    await expect(page.getByPlaceholder('Email')).toBeVisible()
    // Sign-out unmounted the cache, and it let go of A's queries at once.
    await expect
      .poll(() => count(subs.live(), 'contacts/queries:getRoot'))
      .toBe(0)
    await page.getByPlaceholder('Email').fill(users.b.email)
    await page.getByPlaceholder('Password').fill(users.b.password)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page).toHaveURL(`/t/${users.b.slug}`)

    // Client-side navigation, so the same client and its state carry on.
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
