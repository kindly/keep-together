import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { API, devLogin, expect, test } from '../fixtures'
import { runDir } from '../timing'
import type { Page } from '@playwright/test'

// Rust spike step 3: the flows the Convex specs can't run unchanged on the
// Rust backend (no live queries, no Settings tab, a plainer history), and
// the behaviour checks the step asks for: the two-tab stale merge,
// tenancy against id and slug manipulation, restore, contact numbers.
// Flow names and `until` predicates follow qc/flows/*.spec.ts, so samples
// sit beside the Convex history.

let made = 0
function uniq(tag: string): string {
  made += 1
  return `qcrs-${tag}-${process.pid}-${made}`
}

const listPath = (slug: string) => `/t/${slug}/contacts`
const section = (page: Page, heading: string) =>
  page.locator('section', {
    has: page.getByRole('heading', { name: heading, exact: true }),
  })
const contactForm = (page: Page) =>
  page.locator('form', { has: page.getByRole('heading', { name: 'Details' }) })
const saveButton = (page: Page) =>
  contactForm(page).getByRole('button', { name: 'Save', exact: true })
const saved = (page: Page) => contactForm(page).getByText(/^All changes saved/)

async function createContact(page: Page, slug: string, last: string) {
  await page.goto(`/t/${slug}/contacts/new`)
  await page.getByLabel('First name').fill('Qc')
  await page.getByLabel('Last name').fill(last)
  await page.getByRole('button', { name: 'Create' }).click()
  await page.waitForURL(/\/contacts\/(?!new)[^/]+$/)
  await expect(page.getByRole('heading', { name: last })).toBeVisible()
  return page.url()
}

async function want(page: Page, value: string) {
  await page.evaluate((v) => {
    ;(window as unknown as { __qcWant?: string }).__qcWant = v
  }, value)
}

// ── in-page predicates (serialised), as in qc/flows ───────────────────────

function onlyRowIsWant() {
  const w = (window as unknown as { __qcWant?: string }).__qcWant ?? ''
  const links = [...document.querySelectorAll('main ul li a')]
  return links.length === 1 && links[0].textContent.includes(w)
}

function fieldHoldsWant(label: string) {
  const w = (window as unknown as { __qcWant?: string }).__qcWant
  for (const l of document.querySelectorAll('label')) {
    const span = l.querySelector('span')
    if (span?.childNodes[0]?.textContent === label)
      return l.querySelector('input')?.value === w
  }
  return false
}

function paneSaved() {
  return [...document.querySelectorAll('span')].some((s) =>
    s.textContent.startsWith('All changes saved'),
  )
}

/**
 * A sample for a measurement with no Convex counterpart (and so no budget
 * in qc/budgets.ts): input event to `until`, the same clock as runFlow,
 * appended to the run's rust-extra.jsonl.
 */
async function timeOnce(
  page: Page,
  name: string,
  action: () => Promise<void>,
  until: () => unknown,
): Promise<number> {
  await page.evaluate(() => {
    const w = window as unknown as { __t0?: number }
    w.__t0 = undefined
    for (const t of ['pointerdown', 'keydown'])
      addEventListener(t, (e) => (w.__t0 ??= e.timeStamp), {
        capture: true,
        once: true,
      })
  })
  await action()
  const handle = await page.waitForFunction(
    `(() => (${until.toString()})() ? performance.now() : false)()`,
    undefined,
    { polling: 'raf', timeout: 15_000 },
  )
  const t1 = (await handle.jsonValue()) as number
  const t0 = await page.evaluate(
    () => (window as unknown as { __t0?: number }).__t0,
  )
  const ms = Math.round((t1 - t0!) * 10) / 10
  mkdirSync(runDir(), { recursive: true })
  appendFileSync(
    path.join(runDir(), 'rust-extra.jsonl'),
    JSON.stringify({ flow: name, ms, at: Date.now() }) + '\n',
  )
  return ms
}

async function apiAs(
  token: string,
  method: 'GET' | 'POST',
  route: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${API}${route}`, {
    method,
    headers: {
      cookie: `kt_session=${token}`,
      ...(body !== undefined && { 'content-type': 'application/json' }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  let json: any = null
  try {
    json = JSON.parse(text)
  } catch {
    json = text
  }
  return { status: res.status, json }
}

// ── flows ─────────────────────────────────────────────────────────────────

test.describe('rust: fields on the contacts list', () => {
  test('filter the list by the seeded field', async ({
    page,
    flow,
    users,
    world,
  }) => {
    const { label, options } = world.field
    const last = uniq('filtered')
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
    // of its own instead, through Settings, which Rust doesn't have).
    await flow(page, 'fields.filter', {
      before: async () => {
        await page.goto(listPath(users.a.slug))
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

test.describe('rust: history', () => {
  test('Restore this brings back the previous nickname', async ({
    page,
    flow,
    users,
  }) => {
    await createContact(page, users.a.slug, uniq('restore'))
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

test.describe('rust: two tabs, no live queries', () => {
  test('a stale save merges and retries, and both edits land', async ({
    page,
    browser,
    baseURL,
    session,
    users,
  }) => {
    const url = await createContact(page, users.a.slug, uniq('stale'))
    const id = url.split('/').pop()!
    const b = await (
      await browser.newContext({ baseURL, storageState: await session() })
    ).newPage()
    try {
      await b.goto(url)
      await expect(b.getByLabel('Known as')).toBeVisible()

      // Tab A saves; B has not seen it (no live query, and B keeps focus).
      await page.getByLabel('Known as').fill('from a')
      await saveButton(page).click()
      await expect(saved(page)).toBeVisible()
      await expect(b.getByLabel('Known as')).toHaveValue('')

      // B edits another field of the same slice and saves: 200 with the
      // slice stale + current, the reducer merges and retries.
      await b.getByLabel('Title', { exact: true }).fill('from b')
      const responses: Array<any> = []
      b.on('response', async (r) => {
        if (r.url().endsWith(`/contacts/${id}/save`))
          responses.push(await r.json().catch(() => null))
      })
      const ms = await timeOnce(
        b,
        'contact.save.staleMerge',
        () => saveButton(b).click(),
        paneSaved,
      )
      await expect(b.getByLabel('Known as')).toHaveValue('from a')
      await expect(b.getByLabel('Title', { exact: true })).toHaveValue('from b')
      expect(responses.length).toBeGreaterThanOrEqual(2)
      expect(Object.keys(responses[0].stale ?? {})).toContain('details')
      test.info().annotations.push({
        type: 'staleMerge',
        description: `${ms} ms, ${responses.length} save calls`,
      })

      // The server has both; A sees B's on reload (or on focus).
      await page.reload()
      await expect(page.getByLabel('Title', { exact: true })).toHaveValue(
        'from b',
      )
      await expect(page.getByLabel('Known as')).toHaveValue('from a')

      // A plain save, for the same tab and slice, as the baseline.
      await b.getByLabel('Known as').fill('plain')
      await timeOnce(
        b,
        'contact.save.plainInStaleTest',
        () => saveButton(b).click(),
        paneSaved,
      )
    } finally {
      await b.context().close()
    }
  })

  test('the same field edited in both: the later save wins, after merging', async ({
    page,
    browser,
    baseURL,
    session,
    users,
  }) => {
    const url = await createContact(page, users.a.slug, uniq('clash'))
    const b = await (
      await browser.newContext({ baseURL, storageState: await session() })
    ).newPage()
    try {
      await b.goto(url)
      await b.getByLabel('Known as').fill('mine in b')
      await page.getByLabel('Known as').fill('theirs in a')
      await saveButton(page).click()
      await expect(saved(page)).toBeVisible()
      await saveButton(b).click()
      // The merge keeps B's own edit (the spike-04 reducer's rule).
      await expect(saved(b)).toBeVisible()
      await expect(b.getByLabel('Known as')).toHaveValue('mine in b')
      await page.reload()
      await expect(page.getByLabel('Known as')).toHaveValue('mine in b')
    } finally {
      await b.context().close()
    }
  })

  test('another tab sees a change on focus, not live', async ({
    page,
    browser,
    baseURL,
    session,
    users,
  }) => {
    const url = await createContact(page, users.a.slug, uniq('focus'))
    const b = await (
      await browser.newContext({ baseURL, storageState: await session() })
    ).newPage()
    try {
      await b.goto(url)
      await expect(b.getByLabel('Known as')).toHaveValue('')
      await page.getByLabel('Known as').fill('later')
      await saveButton(page).click()
      await expect(saved(page)).toBeVisible()
      await b.waitForTimeout(1000)
      await expect(b.getByLabel('Known as')).toHaveValue('')
      // TanStack Query refetches on window focus.
      // (TanStack Query's focusManager listens for visibilitychange on window.)
      await b.evaluate(() =>
        window.dispatchEvent(new Event('visibilitychange')),
      )
      await expect(b.getByLabel('Known as')).toHaveValue('later')
    } finally {
      await b.context().close()
    }
  })
})

test.describe('rust: tenancy against id and slug manipulation', () => {
  test('the UI: B ids in A slug, B slug as A', async ({
    page,
    users,
    world,
  }) => {
    const [a, b] = world.tenants
    await page.goto(`/t/${b.slug}/contacts`)
    await expect(page.locator('main')).not.toContainText(/Bravo|Ada B/)
    await expect(page.locator(`a[href*="${b.contactIds[0]}"]`)).toHaveCount(0)
    for (const id of b.contactIds) {
      await page.goto(`/t/${users.a.slug}/contacts/${id}`)
      await expect(page.getByText('No such contact.')).toBeVisible()
      await page.goto(`/t/${b.slug}/contacts/${id}`)
      await expect(page.getByRole('heading', { name: 'Details' })).toHaveCount(
        0,
      )
    }
    await page.goto(`/t/${a.slug}/contacts/${a.contactIds[0]}`)
    await expect(page.getByRole('heading', { name: 'Details' })).toBeVisible()
  })

  test('the API: every route, with ids, slugs and paths tampered', async ({
    users,
    world,
  }) => {
    const [a, b] = world.tenants
    const tokA = await devLogin(users.a.email)
    const tokB = await devLogin(users.b.email)
    const bId = b.contactIds[0]
    const aId = a.contactIds[0]
    const viewB = await apiAs(tokB, 'GET', `/api/t/${b.slug}/contacts/${bId}`)
    expect(viewB.status).toBe(200)
    const histB = await apiAs(
      tokB,
      'GET',
      `/api/t/${b.slug}/contacts/${bId}/history`,
    )
    const bRevision = histB.json.revisions[0].id as number
    const viewA = await apiAs(tokA, 'GET', `/api/t/${a.slug}/contacts/${aId}`)
    const fieldsA = await apiAs(tokA, 'GET', `/api/t/${a.slug}/fields`)
    const field = fieldsA.json[0] ?? fieldsA.json.fields?.[0]

    // A's own data is fine.
    expect(viewA.status).toBe(200)

    // A's cookie on B's slug: every route, 403, the same body.
    const onB: Array<['GET' | 'POST', string, unknown?]> = [
      ['GET', ''],
      ['GET', '/contacts'],
      ['GET', '/contacts/search?q=ada'],
      ['GET', `/contacts/${bId}`],
      ['GET', `/contacts/${bId}/history`],
      ['POST', '/contacts', { kind: 'individual', lastName: 'x' }],
      ['POST', `/contacts/${bId}/save`, { details: viewB.json.details }],
      ['POST', `/contacts/${bId}/archive`, { expected: 0, archived: true }],
      ['POST', `/contacts/${bId}/restore`, { revisionId: bRevision }],
      ['GET', '/fields'],
      ['POST', '/fields', { label: 'x' }],
      ['POST', '/fields/options', { label: 'x' }],
    ]
    for (const [m, r, body] of onB) {
      const res = await apiAs(tokA, m, `/api/t/${b.slug}${r}`, body)
      expect([m, r, res.status, res.json]).toEqual([
        m,
        r,
        403,
        { kind: 'forbidden' },
      ])
    }

    // B's contact id under A's own slug: not found, nothing written.
    // History of an id A's file doesn't hold answers an empty page (200),
    // not 404 like the contact itself: nothing of B's, but inconsistent.
    const hist = await apiAs(
      tokA,
      'GET',
      `/api/t/${a.slug}/contacts/${bId}/history`,
    )
    expect([404, 200]).toContain(hist.status)
    if (hist.status === 200) expect(hist.json.revisions).toEqual([])
    for (const [m, r, body] of [
      ['GET', `/contacts/${bId}`],
      [
        'POST',
        `/contacts/${bId}/save`,
        { details: { ...viewB.json.details, expected: 1, nickname: 'pwned' } },
      ],
      ['POST', `/contacts/${bId}/archive`, { expected: 1, archived: true }],
      ['POST', `/contacts/${bId}/restore`, { revisionId: bRevision }],
    ] as Array<['GET' | 'POST', string, unknown?]>) {
      const res = await apiAs(tokA, m, `/api/t/${a.slug}${r}`, body)
      expect([m, r, res.status]).toEqual([m, r, 404])
    }
    const stillB = await apiAs(tokB, 'GET', `/api/t/${b.slug}/contacts/${bId}`)
    expect(stillB.json.details).toEqual(viewB.json.details)
    expect(stillB.json.archived).toBe(viewB.json.archived)

    // A revision id from another of A's contacts can't restore onto this one.
    const histA2 = await apiAs(
      tokA,
      'GET',
      `/api/t/${a.slug}/contacts/${a.contactIds[1]}/history`,
    )
    const other = await apiAs(
      tokA,
      'POST',
      `/api/t/${a.slug}/contacts/${aId}/restore`,
      { revisionId: histA2.json.revisions[0].id },
    )
    expect(other.status).toBe(404)

    // B's field and option ids in A's list filter: refused or empty, never B's rows.
    if (field) {
      const res = await apiAs(
        tokA,
        'GET',
        `/api/t/${a.slug}/contacts?fields=${encodeURIComponent(`${field.id}:none`)}`,
      )
      expect(res.status).toBe(200)
      expect(
        res.json.rows.some((r: { id: string }) => b.contactIds.includes(r.id)),
      ).toBe(false)
    }

    // Slug tampering: case, encoding, traversal, B's file name. Never 2xx,
    // never B's data.
    const tenantFiles = ['..', '../orgs', '%2e%2e', 'orgs', 'platform']
    const slugs = [
      b.slug.toUpperCase(),
      `${b.slug}%00`,
      `${b.slug}%2F..%2F${b.slug}`,
      `${a.slug}%2F..%2F${b.slug}`,
      `${a.slug}/../${b.slug}`,
      encodeURIComponent(`../${b.slug}`),
      ...tenantFiles,
      ' ' + b.slug,
    ]
    for (const s of slugs) {
      const res = await apiAs(tokA, 'GET', `/api/t/${s}/contacts`)
      const body = JSON.stringify(res.json)
      expect([s, res.status < 300]).toEqual([s, false])
      expect(body).not.toContain(bId)
    }
    // A's slug with a path that climbs out of it, to B's id.
    for (const r of [
      `/api/t/${a.slug}/contacts/..%2F..%2F${b.slug}%2Fcontacts%2F${bId}`,
      `/api/t/${a.slug}/contacts/${bId}%00`,
      `/api/t/${a.slug}/contacts/${bId.toUpperCase()}`,
    ]) {
      const res = await apiAs(tokA, 'GET', r)
      expect([r, res.status < 300]).toEqual([r, false])
    }

    // No cookie, a forged cookie, B's cookie on A's slug.
    expect(
      (await apiAs('nope', 'GET', `/api/t/${a.slug}/contacts`)).status,
    ).toBe(401)
    expect(
      (await apiAs(tokB, 'GET', `/api/t/${a.slug}/contacts/${aId}`)).status,
    ).toBe(403)

    // Search can't cross: B's own Ada name, searched from A.
    const bName = viewB.json.details.lastName as string
    const s = await apiAs(
      tokA,
      'GET',
      `/api/t/${a.slug}/contacts/search?q=${encodeURIComponent(bName)}`,
    )
    expect(
      s.json.rows.some((r: { id: string }) => b.contactIds.includes(r.id)),
    ).toBe(false)
  })
})

test.describe('rust: contact numbers (Luhn)', () => {
  test('written, short, typo, and never across groups', async ({
    page,
    flow,
    users,
    world,
  }) => {
    const last = uniq('luhn')
    await createContact(page, users.a.slug, last)
    const shown = page.getByTestId('contact-number')
    await expect(shown).toHaveText(/^\d{6}$/)
    const written = (await shown.textContent())!
    await page.getByRole('link', { name: 'Contacts', exact: true }).click()
    const search = page.getByRole('searchbox', { name: 'Search contacts' })
    const listRows = page.locator('main ul li a')
    await flow(page, 'contacts.search.number', {
      before: async () => {
        await search.fill('')
        await expect(listRows.nth(1)).toBeVisible()
      },
      action: () => search.fill(written),
      until: (name: string) => {
        const first = document.querySelector('main ul li a')
        return (
          first !== null &&
          first.textContent.includes(name) &&
          first.textContent.includes('contact no.')
        )
      },
      arg: last,
    })
    await search.fill(`${written.slice(0, 3)} ${written.slice(3, 5)}`)
    await expect(listRows.first()).toContainText(last)
    await expect(listRows.first()).toContainText(`contact no. ${written}`)
    const typo = written.slice(0, 5) + ((Number(written[5]) + 1) % 10)
    await search.fill(typo)
    await expect(
      page.getByText(
        `${typo} isn’t a valid contact number. Check the last digit.`,
      ),
    ).toBeVisible()
    await expect(page.locator('main')).not.toContainText(last)

    // B, by A's number: B's own search never returns A's contact.
    const tokB = await devLogin(users.b.email)
    for (const term of [written, written.slice(0, 5)]) {
      const res = await apiAs(
        tokB,
        'GET',
        `/api/t/${world.tenants[1].slug}/contacts/search?q=${term}`,
      )
      expect(res.status).toBe(200)
      expect(
        res.json.rows.some((r: { displayName: string }) =>
          r.displayName.includes(last),
        ),
      ).toBe(false)
    }
  })
})
