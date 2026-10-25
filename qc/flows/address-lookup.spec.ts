import { expect, test } from '../fixtures'
import {
  CONTACT_ROUTE,
  QC_POSTCODE,
  contactForm,
  createContact,
  rows,
  saved,
  section,
  uniqueName,
} from './contact.helpers'

// The contact form's "Find address" (factory/plans/address-lookup.sv):
// a postcode, a pick, the row filled and autosaved like a typed edit.
// Functional, not a timed flow: on staging the lookup goes to Ideal
// Postcodes, whose round trip is outside the 100 ms server rule, and each
// sample would be a lookup. One lookup per run, of QC_POSTCODE only.

test.describe('address lookup', { annotation: CONTACT_ROUTE }, () => {
  test('find address fills the row and autosaves', async ({ page, users }) => {
    await createContact(page, users.a.slug, uniqueName('lookup'))
    await section(page, 'Addresses')
      .getByRole('button', { name: 'add', exact: true })
      .click()
    const row = rows(page, 'Addresses').nth(0)
    await row.getByRole('button', { name: 'Find address' }).click()
    await row.getByLabel('Postcode to look up').fill(QC_POSTCODE.toLowerCase())
    await row.getByRole('button', { name: 'Find', exact: true }).click()
    const found = row.getByRole('group', { name: 'Addresses found' })
    const first = found.getByRole('button').first()
    await expect(first).toBeVisible()
    const line = (await first.textContent())!
    await first.click()
    await expect(found).toBeHidden()

    const line1 = row.getByPlaceholder('Address line 1')
    await expect(line1).toHaveValue(line.split(', ')[0])
    await expect(row.getByPlaceholder('Postcode')).toHaveValue(QC_POSTCODE)
    await expect(row.getByPlaceholder('GB')).toHaveValue('GB')
    // Saved with no click, as a typed edit is.
    await expect(saved(page)).toBeVisible()
    await page.reload()
    await expect(
      rows(page, 'Addresses').nth(0).getByPlaceholder('Postcode'),
    ).toHaveValue(QC_POSTCODE)
    await expect(
      rows(page, 'Addresses').nth(0).getByPlaceholder('Address line 1'),
    ).toHaveValue(line.split(', ')[0])
    await expect(contactForm(page).getByText('Unsaved changes')).toBeHidden()
  })

  test('a postcode with no addresses says so and fills nothing', async ({
    page,
    users,
  }) => {
    await createContact(page, users.a.slug, uniqueName('lookup-none'))
    await section(page, 'Addresses')
      .getByRole('button', { name: 'add', exact: true })
      .click()
    const row = rows(page, 'Addresses').nth(0)
    await row.getByRole('button', { name: 'Find address' }).click()
    // A well-formed postcode with no delivery points; not found costs no
    // credit with Ideal Postcodes.
    await row.getByLabel('Postcode to look up').fill('ZZ1 1ZZ')
    await row.getByRole('button', { name: 'Find', exact: true }).click()
    await expect(row.getByRole('status')).toHaveText(
      'No addresses for that postcode',
    )
    await expect(row.getByPlaceholder('Address line 1')).toHaveValue('')
  })
})
