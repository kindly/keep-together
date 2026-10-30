import { expect, test } from '../fixtures'
import type { Page } from '@playwright/test'
import { createContact, uniqueName, want } from './contact.helpers'

// Bank transfers 6b part 3: recording a standing order on the contact
// (the donor set it up in their own bank; nothing reaches GoCardless),
// timed from the click on "Record" to the dialog saying what was
// recorded; then the card shows it, as the server has it. Signed in as
// user A, an admin.

const CONTACT = {
  type: 'route',
  description: '/t/$slug/contacts/$contactId',
}

/** The dialog's "Recorded:" line holds window.__qcWant. */
function recordedIsWant() {
  const w = (window as unknown as { __qcWant?: string }).__qcWant
  return [...document.querySelectorAll('[role="status"]')].some((s) =>
    s.textContent.startsWith(`Recorded: ${w}`),
  )
}

async function pickCode(page: Page, code: string) {
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('combobox', { name: 'Source code' }).fill(code)
  await dialog
    .getByRole('listbox', { name: 'Source code matches' })
    .getByRole('option', { name: new RegExp(code) })
    .first()
    .click()
}

let pence = 500
/** A different amount each sample, so each "Recorded" line is new. */
function nextAmount(): { typed: string; shown: string } {
  pence += 1
  const pounds = `${Math.floor(pence / 100)}.${String(pence % 100).padStart(2, '0')}`
  return { typed: pounds, shown: `£${pounds}` }
}

test.describe('standing orders', { annotation: [CONTACT] }, () => {
  test('record a standing order on a contact', async ({
    page,
    flow,
    users,
  }) => {
    const slug = users.a.slug
    const contactUrl = await createContact(page, slug, uniqueName('so'))
    let shown = ''
    await flow(page, 'standingOrder.record', {
      before: async () => {
        await page.goto(contactUrl)
        await page
          .getByRole('button', { name: 'Record a standing order' })
          .click()
        const dialog = page.getByRole('dialog')
        const amount = nextAmount()
        shown = amount.shown
        await dialog.getByLabel('Amount (£)').fill(amount.typed)
        await dialog.getByLabel('How often').selectOption('quarterly')
        await dialog.getByLabel('First payment').fill('2026-02-10')
        await expect(dialog).toContainText(
          'every quarter on the 10th from February',
        )
        await pickCode(page, 'Event-Gala-001')
        await expect(
          dialog.getByRole('button', { name: 'Record', exact: true }),
        ).toBeEnabled()
        await want(page, `${amount.shown} every quarter on the 10th`)
      },
      action: () =>
        page
          .getByRole('dialog')
          .getByRole('button', { name: 'Record', exact: true })
          .click(),
      until: recordedIsWant,
      server: true,
    })
    // The card, as the server read it back.
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Close' })
      .click()
    await expect(
      page.getByTestId('standing-order').filter({ hasText: shown }).first(),
    ).toContainText('every quarter on the 10th from February')
  })
})
