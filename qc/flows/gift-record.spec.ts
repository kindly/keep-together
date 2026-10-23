import { expect, test } from '../fixtures'
import { createContact, uniqueName, want } from './contact.helpers'
import type { Page } from '@playwright/test'

// Cash gifts step 3: the record-gift page. Each sample records one gift
// and is timed from the click on "Record gift" to the "Saved" line; the
// form then clears for the next (fast entry, g1q7), so samples follow
// one another on one page, as staff entering a pile of gifts would.

const NEW = { type: 'route', description: '/t/$slug/gifts/new' }
const HOME = { type: 'route', description: '/t/$slug/' }

const donorBox = (page: Page) => page.getByRole('combobox', { name: 'Donor' })

/** Pick the code under its search box: type it, take the first match. */
async function pickCode(page: Page, code: string) {
  const box = page.getByRole('combobox', { name: 'Source code' })
  await box.fill(code)
  await page
    .getByRole('listbox', { name: 'Source code matches' })
    .getByRole('option', { name: new RegExp(code) })
    .first()
    .click()
  await expect(page.getByTestId('source-code')).toContainText(code)
}

/** The "Saved" line holds window.__qcWant. */
function savedIsWant() {
  const w = (window as unknown as { __qcWant?: string }).__qcWant
  return [...document.querySelectorAll('[role="status"]')].some((s) =>
    s.textContent.startsWith(`Saved: ${w}`),
  )
}

let pence = 100
/** A different amount each sample, so each "Saved" line is new. */
function nextAmount(): { typed: string; shown: string } {
  pence += 1
  const pounds = `${Math.floor(pence / 100)}.${String(pence % 100).padStart(2, '0')}`
  return { typed: pounds, shown: `£${pounds}` }
}

test.describe('record a gift', { annotation: [NEW] }, () => {
  test('home and the Donations menu lead to it', async ({ page, users }) => {
    test.info().annotations.push(HOME)
    await page.goto(`/t/${users.a.slug}/`)
    await page.getByRole('link', { name: 'Record a gift' }).click()
    await expect(page).toHaveURL(/\/gifts\/new$/)
    await expect(donorBox(page)).toBeFocused()
    await page.getByRole('button', { name: /Donations/ }).click()
    await expect(
      page.getByRole('menuitem', { name: 'Record a gift' }),
    ).toHaveAttribute('href', `/t/${users.a.slug}/gifts/new`)
  })

  test('from an existing contact', async ({ page, flow, users }) => {
    const lastName = uniqueName('give')
    await createContact(page, users.a.slug, lastName)
    await page.goto(`/t/${users.a.slug}/gifts/new`)
    await flow(page, 'gift.record', {
      before: async () => {
        await donorBox(page).fill(lastName)
        await page.getByRole('option', { name: new RegExp(lastName) }).click()
        await expect(page.getByTestId('donor')).toContainText(lastName)
        // The first gift fills the contact's code; later ones default to it.
        if (
          !(await page.getByTestId('source-code').textContent())?.includes(
            'Event-Gala-001',
          )
        )
          await pickCode(page, 'Event-Gala-001')
        const amount = nextAmount()
        await page.getByLabel('Amount (£)').fill(amount.typed)
        // Enabled once an existing donor's Gift Aid state has loaded.
        await expect(
          page.getByRole('button', { name: 'Record gift' }),
        ).toBeEnabled()
        await want(page, `${amount.shown} from Qc ${lastName}`)
      },
      action: () => page.getByRole('button', { name: 'Record gift' }).click(),
      until: savedIsWant,
    })
    // The last one opens on its page.
    await page.getByRole('status').getByRole('link', { name: '(open)' }).click()
    await expect(page).toHaveURL(/\/gifts\/(?!new$)[^/]+$/)
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      lastName,
    )
  })

  test('from a new person, with Gift Aid and their address', async ({
    page,
    flow,
    users,
  }) => {
    await page.goto(`/t/${users.a.slug}/gifts/new`)
    await flow(page, 'gift.recordNewContact', {
      before: async () => {
        const lastName = uniqueName('newgive')
        await donorBox(page).fill(`Ann ${lastName}`)
        await page.getByRole('option', { name: /^New person/ }).click()
        await expect(page.getByLabel('Last name')).toHaveValue(lastName)
        await pickCode(page, 'Event-Gala-001')
        const amount = nextAmount()
        await page.getByLabel('Amount (£)').fill(amount.typed)
        await page.getByLabel('Gift Aid declaration').check()
        await expect(page.getByTestId('tick-method-explained')).toContainText(
          'no signed form',
        )
        await page.getByLabel('House number or name, street').fill('12 High St')
        await page.getByLabel('Postcode').fill('AB1 2CD')
        // Enabled once an existing donor's Gift Aid state has loaded.
        await expect(
          page.getByRole('button', { name: 'Record gift' }),
        ).toBeEnabled()
        await want(page, `${amount.shown} from Ann ${lastName}`)
      },
      action: () => page.getByRole('button', { name: 'Record gift' }).click(),
      until: savedIsWant,
    })
    await page.getByRole('status').getByRole('link', { name: '(open)' }).click()
    await expect(page.getByTestId('gift-coverage')).toContainText(
      '✓ Covered by declaration',
    )
  })

  test('a half-typed address under the tick blocks the save', async ({
    page,
    users,
  }) => {
    await page.goto(`/t/${users.a.slug}/gifts/new`)
    await donorBox(page).fill(`Bo ${uniqueName('half')}`)
    await page.getByRole('option', { name: /^New person/ }).click()
    await pickCode(page, 'Event-Gala-001')
    await page.getByLabel('Amount (£)').fill('5')
    await page.getByLabel('Gift Aid declaration').check()
    await page.getByLabel('House number or name, street').fill('12 High St')
    await page.getByRole('button', { name: 'Record gift' }).click()
    await expect(
      page.getByText('Add the postcode, or clear line 1'),
    ).toBeVisible()
    await expect(page.getByRole('status')).toHaveCount(0)
  })

  test('leaving with a gift half entered asks first', async ({
    page,
    users,
  }) => {
    await page.goto(`/t/${users.a.slug}/gifts/new`)
    await page.getByLabel('Amount (£)').fill('5')
    await page.getByRole('link', { name: 'Contacts' }).first().click()
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toContainText('unsaved changes')
    await dialog.getByRole('button', { name: 'Stay' }).click()
    await expect(page).toHaveURL(/\/gifts\/new$/)
  })
})
