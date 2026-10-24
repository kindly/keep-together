import { expect, qcHold, test } from '../fixtures'
import type { Instance } from '../fixtures'
import {
  CONTACT_ROUTE,
  createContact,
  rows,
  saveButton,
  saved,
  secondTab,
  section,
  uniqueName,
} from './contact.helpers'
import type { Page } from '@playwright/test'

// Email holds on the contact page (E2a, ADR 0021): a bounced address shows
// "On hold" on every contact using it, an admin can release it, staff and
// viewers only see it, and another group's hold of the same address never
// shows. Holds are seeded through the api's dev `qc-hold`, as a bounce
// would make them.

/** Hold `address` in a tenant (its slug), as a hard bounce does. */
async function hold(inst: Instance, slug: string, address: string) {
  await qcHold(inst, { slug, address })
}

/** Add an email row to the open contact and wait until it is saved. */
async function addEmail(page: Page, address: string) {
  await section(page, 'Emails').getByRole('button', { name: 'add' }).click()
  await rows(page, 'Emails')
    .last()
    .getByPlaceholder('email address')
    .fill(address)
  await saveButton(page).click()
  await expect(saved(page)).toBeVisible()
}

/** The open contact's email row `i`, in the order they were added. */
const emailRow = (page: Page, i = 0) => rows(page, 'Emails').nth(i)

const badge = (page: Page, i = 0) =>
  emailRow(page, i).getByText('On hold', { exact: true })

// ── in-page predicates (serialised: no closures, no imports) ──────────────

/** No email row shows an "On hold" badge. */
function noHoldBadge() {
  return ![...document.querySelectorAll('li span')].some(
    (s) => s.textContent === 'On hold',
  )
}

// ── specs ──────────────────────────────────────────────────────────────────

test.describe('email holds on a contact', { annotation: CONTACT_ROUTE }, () => {
  test('a held address shows on hold, on every contact using it', async ({
    page,
    instance,
    world,
    users,
  }) => {
    const last = uniqueName('held')
    const address = `${last}@example.com`.toLowerCase()
    await createContact(page, users.a.slug, last)
    await addEmail(page, address)
    await expect(badge(page)).toBeHidden()

    await hold(instance, world.tenants[0].tenantId, address)
    await expect(badge(page)).toBeVisible()
    await expect(
      emailRow(page).getByText(
        /^Bounced on .+: we won't send to this address$/,
      ),
    ).toBeVisible()

    // The hold follows the address: another contact, same address, held.
    await createContact(page, users.a.slug, uniqueName('sharer'))
    await addEmail(page, address.toUpperCase())
    await expect(badge(page)).toBeVisible()

    // Removed and added again, it is still held.
    await emailRow(page).getByRole('button', { name: 'remove' }).click()
    await saveButton(page).click()
    await expect(saved(page)).toBeVisible()
    await expect(rows(page, 'Emails')).toHaveCount(0)
    await addEmail(page, address)
    await expect(badge(page)).toBeVisible()
  })

  test('an admin releases a hold and the badge goes', async ({
    page,
    flow,
    instance,
    world,
    users,
  }) => {
    const last = uniqueName('release')
    const address = `${last}@example.com`.toLowerCase()
    await createContact(page, users.a.slug, last)
    await addEmail(page, address)
    const dialog = page.getByRole('alertdialog')

    await flow(page, 'contact.hold.release', {
      before: async () => {
        await hold(instance, world.tenants[0].tenantId, address)
        await expect(badge(page)).toBeVisible()
        await emailRow(page).getByRole('button', { name: 'Release' }).click()
        await dialog
          .getByLabel('Note (optional)')
          .fill("They've fixed their mailbox")
      },
      action: () => dialog.getByRole('button', { name: 'Release' }).click(),
      until: noHoldBadge,
    })
    await expect(badge(page)).toBeHidden()
    await expect(dialog).toBeHidden()
    await expect(emailRow(page).getByRole('alert')).toBeHidden()
  })

  test('staff and viewers see the badge but no Release', async ({
    page,
    browser,
    baseURL,
    session,
    instance,
    world,
    users,
  }) => {
    const last = uniqueName('staffhold')
    const address = `${last}@example.com`.toLowerCase()
    const url = await createContact(page, users.a.slug, last)
    await addEmail(page, address)
    await hold(instance, world.tenants[0].tenantId, address)
    await expect(badge(page)).toBeVisible()
    await expect(
      emailRow(page).getByRole('button', { name: 'Release' }),
    ).toBeVisible()

    for (const user of [users.staff, users.viewer]) {
      const other = await secondTab(browser, baseURL!, await session(user))
      await other.goto(url)
      await expect(badge(other)).toBeVisible()
      await expect(
        emailRow(other).getByRole('button', { name: 'Release' }),
      ).toHaveCount(0)
      await other.context().close()
    }
  })

  test("another group's hold of the same address doesn't show", async ({
    page,
    instance,
    world,
    users,
  }) => {
    const last = uniqueName('bhold')
    const inB = `${last}-b@example.com`.toLowerCase()
    const inA = `${last}-a@example.com`.toLowerCase()
    await createContact(page, users.a.slug, last)
    await addEmail(page, inB)
    await addEmail(page, inA)

    await hold(instance, world.tenants[1].tenantId, inB)
    await hold(instance, world.tenants[0].tenantId, inA)
    // A's own hold arrives after B's was written: by then B's would show.
    await expect(badge(page, 1)).toBeVisible()
    await expect(badge(page, 0)).toBeHidden()
  })
})
