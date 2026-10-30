import { expect, test } from '../fixtures'
import type { Page } from '@playwright/test'
import { createContact, uniqueName, want } from './contact.helpers'

// Bank transfers 6b: paying-in batches. Recording a cheque into an open
// batch (from the batch's page, so the record-gift page opens with it
// chosen), timed from the click on "Record gift" to the "Saved" line; and
// closing a batch with its slip's total, timed from "Close it" to the
// page saying it is closed. Signed in as user A, an admin; the bank
// account is made through the API, untimed.

const LIST = { type: 'route', description: '/t/$slug/bank/batches/' }
const BATCH = { type: 'route', description: '/t/$slug/bank/batches/$batchId' }
const NEW = { type: 'route', description: '/t/$slug/gifts/new' }

async function post<T>(page: Page, path: string, data: unknown): Promise<T> {
  const res = await page.request.post(path, { data })
  expect(res.ok(), `POST ${path}: ${res.status()}`).toBe(true)
  return (await res.json()) as T
}

/** A fresh bank account in the group, so no other test's batches mix in. */
async function account(page: Page, slug: string): Promise<string> {
  if (!page.url().startsWith('http')) await page.goto(`/t/${slug}/contacts`)
  const made = await post<{ id: string }>(
    page,
    `/api/t/${slug}/bank/accounts`,
    {
      name: uniqueName('Current'),
      active: true,
    },
  )
  return made.id
}

const openBatch = (page: Page, slug: string, accountId: string) =>
  post<{ id: string }>(page, `/api/t/${slug}/bank/batches`, {
    accountId,
    slipNumber: '',
  }).then((b) => b.id)

/** The "Saved" line holds window.__qcWant. */
function savedIsWant() {
  const w = (window as unknown as { __qcWant?: string }).__qcWant
  return [...document.querySelectorAll('[role="status"]')].some((s) =>
    s.textContent.startsWith(`Saved: ${w}`),
  )
}

/** The batch's page says it is closed. */
function batchClosed() {
  const s = document.querySelector('[data-testid="batch-state"]')
  return s?.textContent.startsWith('Closed:') ?? false
}

let pence = 300
function nextAmount(): { typed: string; shown: string } {
  pence += 1
  const pounds = `${Math.floor(pence / 100)}.${String(pence % 100).padStart(2, '0')}`
  return { typed: pounds, shown: `£${pounds}` }
}

test.describe('paying-in batches', { annotation: [LIST, BATCH] }, () => {
  test('record a cheque into an open batch', async ({ page, flow, users }) => {
    test.info().annotations.push(NEW)
    const slug = users.a.slug
    const lastName = uniqueName('cheque')
    await createContact(page, slug, lastName)
    const batchId = await openBatch(page, slug, await account(page, slug))
    await page.goto(`/t/${slug}/bank/batches`)
    await expect(
      page.getByRole('heading', { name: 'Paying-in batches' }),
    ).toBeVisible()
    await page.goto(`/t/${slug}/bank/batches/${batchId}`)
    await page
      .getByRole('link', { name: 'Record cash or a cheque into it' })
      .click()
    await expect(page).toHaveURL(/\/gifts\/new\?batch=/)
    await flow(page, 'gift.recordCheque', {
      before: async () => {
        await page.getByRole('combobox', { name: 'Donor' }).fill(lastName)
        await page
          .getByRole('option', { name: new RegExp(`^Qc ${lastName}`) })
          .click()
        await expect(page.getByTestId('donor')).toContainText(lastName)
        if (
          !(await page.getByTestId('source-code').textContent())?.includes(
            'Event-Gala-001',
          )
        ) {
          const box = page.getByRole('combobox', { name: 'Source code' })
          await box.fill('Event-Gala-001')
          await page
            .getByRole('listbox', { name: 'Source code matches' })
            .getByRole('option', { name: /Event-Gala-001/ })
            .first()
            .click()
        }
        const amount = nextAmount()
        await page.getByLabel('Amount (£)').fill(amount.typed)
        await page.getByRole('radio', { name: 'Cheque' }).check()
        await page.getByLabel(/^Cheque number/).fill(String(pence))
        await expect(page.getByLabel(/^Paying-in batch/)).toHaveValue(batchId)
        await expect(
          page.getByRole('button', { name: 'Record gift' }),
        ).toBeEnabled()
        await want(page, `${amount.shown} from Qc ${lastName}`)
      },
      action: () => page.getByRole('button', { name: 'Record gift' }).click(),
      until: savedIsWant,
    })
    // On the batch's page, its cheques, pending until it is matched.
    await page.goto(`/t/${slug}/bank/batches/${batchId}`)
    await expect(
      page.getByRole('region', { name: 'Gifts in this batch' }),
    ).toContainText('Cheque, pending')
  })

  test('close a batch with its slip’s total', async ({ page, flow, users }) => {
    const slug = users.a.slug
    const accountId = await account(page, slug)
    await flow(page, 'batch.close', {
      before: async () => {
        const id = await openBatch(page, slug, accountId)
        await page.goto(`/t/${slug}/bank/batches/${id}`)
        await page.getByRole('button', { name: 'Close the batch' }).click()
        await page.getByLabel('Slip’s total (£)').fill('10.00')
        await page.getByLabel('Paid in on').fill('2026-11-03')
        await expect(
          page.getByRole('button', { name: 'Close it' }),
        ).toBeEnabled()
      },
      action: () => page.getByRole('button', { name: 'Close it' }).click(),
      until: batchClosed,
    })
    await expect(page.getByTestId('batch-difference')).toContainText(
      'The slip says £10.00 more',
    )
  })
})
