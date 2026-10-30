import { expect, test } from '../fixtures'
import type { Page } from '@playwright/test'
import { formatNumber } from '../../src/lib/domain/contacts'
import { uniqueName } from './contact.helpers'

// Bank transfers 6b part 2 (and plan step 7's two flows): reconcile. A
// hand-made CAF-style statement (a printed statement's preamble and
// footer around Date, Description, Paid in, Paid out, Balance; CAF Bank's
// preset waits for a real file, so its columns are mapped) is imported
// with each credit quoting a donor's contact number, so each line has a
// strong, pre-ticked suggestion; "Accept ticked" is timed from the click
// to the page saying how many it matched (the server's answer). Then one
// line matched by hand as not a donation, timed from the click to the
// line saying so. Signed in as user A, an admin; accounts, contacts and
// imports are made through the API, untimed.

const RECONCILE = { type: 'route', description: '/t/$slug/bank/reconcile' }
const LINE = { type: 'route', description: '/t/$slug/bank/lines/$lineId' }
const RULES = { type: 'route', description: '/t/$slug/bank/rules' }

/** Lines each "Accept ticked" sample matches. */
const PER_SAMPLE = 5

const CAF_MAPPING = {
  kind: 'mapping',
  mapping: {
    header: { kind: 'find' },
    date: { name: 'Date' },
    amount: {
      kind: 'paidInOut',
      paidIn: { name: 'Paid in' },
      paidOut: { name: 'Paid out' },
    },
    narrative: [{ name: 'Description' }],
  },
}

async function post<T>(page: Page, path: string, data: unknown): Promise<T> {
  const res = await page.request.post(path, { data })
  expect(res.ok(), `POST ${path}: ${res.status()}`).toBe(true)
  return (await res.json()) as T
}

async function get<T>(page: Page, path: string): Promise<T> {
  const res = await page.request.get(path)
  expect(res.ok(), `GET ${path}: ${res.status()}`).toBe(true)
  return (await res.json()) as T
}

/** A fresh account, with a seeded code as its default (g2q6). */
async function account(page: Page, slug: string): Promise<string> {
  if (!page.url().startsWith('http')) await page.goto(`/t/${slug}/contacts`)
  const tree = await get<{ parts: Array<{ id: string; level: string }> }>(
    page,
    `/api/t/${slug}/sources`,
  )
  const version = tree.parts.find((p) => p.level === 'version')
  expect(version, 'a seeded source code').toBeDefined()
  const made = await post<{ id: string }>(
    page,
    `/api/t/${slug}/bank/accounts`,
    {
      name: uniqueName('CAF'),
      active: true,
      defaultSourceCodeId: version!.id,
    },
  )
  return made.id
}

/** A new donor; answers their written contact number. */
async function donor(page: Page, slug: string): Promise<string> {
  const c = await post<{ number: number }>(page, `/api/t/${slug}/contacts`, {
    kind: 'individual',
    title: '',
    firstName: 'Qc',
    lastName: uniqueName('payer'),
    nickname: '',
    name: '',
    isDeceased: false,
  })
  return formatNumber(c.number)
}

let pence = 1000
const today = new Date()
const ukDate = (d: Date) =>
  `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`

/** A CAF-style statement: preamble, the rows, a debit, a footer. */
function statement(rows: Array<{ description: string; pence: number }>) {
  const day = ukDate(today)
  const money = (p: number) =>
    `${Math.floor(p / 100)}.${String(p % 100).padStart(2, '0')}`
  return [
    'CAF Bank Ltd,Statement of account',
    'Account name,QC Friends',
    '',
    'Date,Description,Paid in,Paid out,Balance',
    ...rows.map((r) => `${day},${r.description},${money(r.pence)},,0.00`),
    `${day},STATIONERY LTD,,12.00,0.00`,
    ',,Total paid in,,',
    'End of statement',
  ].join('\n')
}

/** Import `rows` into the account; answers the new lines' ids. */
async function importRows(
  page: Page,
  slug: string,
  accountId: string,
  rows: Array<{ description: string; pence: number }>,
): Promise<Array<string>> {
  const q = new URLSearchParams({
    accountId,
    fileName: 'caf-statement.csv',
    layout: JSON.stringify(CAF_MAPPING),
  })
  const res = await page.request.post(
    `/api/t/${slug}/bank/imports?${q.toString()}`,
    {
      data: Buffer.from(statement(rows)),
      headers: { 'content-type': 'text/csv' },
    },
  )
  expect(res.ok(), `import: ${res.status()} ${await res.text()}`).toBe(true)
  const { id } = (await res.json()) as { id: string; newLines: number }
  const detail = await get<{ lines: Array<{ id: string }> }>(
    page,
    `/api/t/${slug}/bank/imports/${id}`,
  )
  expect(detail.lines).toHaveLength(rows.length)
  return detail.lines.map((l) => l.id)
}

/** The accept summary says window.__qcWant lines were matched. */
function acceptedIsWant() {
  const w = (window as unknown as { __qcWant?: string }).__qcWant
  const s = document.querySelector('[data-testid="accept-summary"]')
  return s?.textContent === `${w} matched`
}

/** The line says it isn't a donation. */
function lineNotDonation() {
  const s = document.querySelector('[data-testid="line-state"]')
  return s?.textContent.startsWith('Not a donation') ?? false
}

test.describe('reconcile', { annotation: [RECONCILE] }, () => {
  test('import a CAF-style statement, then accept ticked', async ({
    page,
    flow,
    users,
  }) => {
    const slug = users.a.slug
    const accountId = await account(page, slug)
    await flow(page, 'bank.acceptTicked', {
      before: async () => {
        const rows = []
        for (let i = 0; i < PER_SAMPLE; i++) {
          pence += 1
          rows.push({
            description: `QC PAYER ${await donor(page, slug)} GIFT`,
            pence,
          })
        }
        await importRows(page, slug, accountId, rows)
        await page.goto(`/t/${slug}/bank/reconcile?account=${accountId}`)
        await expect(
          page.getByRole('button', { name: `Accept ticked (${PER_SAMPLE})` }),
        ).toBeEnabled()
        await page.evaluate((v) => {
          ;(window as unknown as { __qcWant?: string }).__qcWant = v
        }, String(PER_SAMPLE))
      },
      action: () =>
        page
          .getByRole('button', { name: `Accept ticked (${PER_SAMPLE})` })
          .click(),
      until: acceptedIsWant,
    })
    // Every line matched: none left, and a donor's gift came from one.
    await expect(
      page.getByText('Nothing left to match on this account.'),
    ).toBeVisible()
  })

  test('match a line by hand: not a donation', async ({
    page,
    flow,
    users,
  }) => {
    test.info().annotations.push(LINE)
    const slug = users.a.slug
    const accountId = await account(page, slug)
    await flow(page, 'bank.matchLine', {
      before: async () => {
        pence += 1
        const [id] = await importRows(page, slug, accountId, [
          { description: 'COUNCIL GRANT', pence },
        ])
        await page.goto(`/t/${slug}/bank/lines/${id}`)
        await page.getByRole('button', { name: 'Not a donation' }).click()
        await page.getByLabel('What it is').fill('A council grant')
        await expect(
          page.getByRole('button', { name: 'Mark not a donation' }),
        ).toBeEnabled()
      },
      action: () =>
        page.getByRole('button', { name: 'Mark not a donation' }).click(),
      until: lineNotDonation,
    })
    await expect(page.getByRole('button', { name: 'Unmatch' })).toBeVisible()
  })

  test('a not-a-donation rule is added, suggested, and deleted', async ({
    page,
    users,
  }) => {
    test.info().annotations.push(RULES)
    const slug = users.a.slug
    const accountId = await account(page, slug)
    const word = uniqueName('PAYOUT').toUpperCase()
    await page.goto(`/t/${slug}/bank/rules`)
    await page.getByLabel('contains').fill(word)
    await page.getByLabel(/^It is/).fill('A payout')
    await page.getByRole('button', { name: 'Add the rule' }).click()
    await expect(page.getByText(`contains “${word}”`)).toBeVisible()
    pence += 1
    await importRows(page, slug, accountId, [
      { description: `${word} REF`, pence },
    ])
    await page.goto(`/t/${slug}/bank/reconcile?account=${accountId}`)
    await expect(page.getByText('Not a donation: A payout')).toBeVisible()
    await page.goto(`/t/${slug}/bank/rules`)
    const row = page.locator('li', { hasText: word })
    await row.getByRole('button', { name: 'Delete' }).click()
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Delete' })
      .click()
    await expect(page.getByText(`contains “${word}”`)).toHaveCount(0)
  })
})
