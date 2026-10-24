import { apiPost, expect, test } from '../fixtures'
import type { Instance, QcUser } from '../fixtures'
import {
  CONTACT_ROUTE,
  contactForm,
  createContact,
  saveButton,
  saved,
  secondTab,
  section,
  uniqueName,
  want,
} from './contact.helpers'
import type { Page } from '@playwright/test'

// External identifiers on the contact form (external-ids X4b): add and
// remove, a duplicate value "to fix" naming the contact that holds it, and
// the section hidden in a group with no active type. Types are made
// through the api here: the settings page that makes them (X4a) is timed
// in settings.spec.ts, which waits for A3's Settings layout. Tenant B's
// only type is archived (the QC seed).

const identifiers = (page: Page) => section(page, 'Identifiers')
const idRows = (page: Page) => identifiers(page).locator('ul > li')

/** Create an identifier type as `user` (an admin): its id. */
async function createType(inst: Instance, user: QcUser, name: string) {
  const made = await apiPost<{ id: string }>(
    inst,
    user,
    `/api/t/${user.slug}/identifier-types`,
    { name, isActive: true },
  )
  return made.id
}

/** Archive a type made by `createType` (still at version 0). */
async function archiveType(
  inst: Instance,
  user: QcUser,
  id: string,
  name: string,
) {
  await apiPost(inst, user, `/api/t/${user.slug}/identifier-types`, {
    id,
    expected: 0,
    name,
    isActive: false,
  })
}

/** Fill a new identifier row: type, then value. Doesn't leave the field. */
async function fillRow(page: Page, type: string, value: string) {
  await identifiers(page).getByRole('button', { name: 'add' }).click()
  const row = idRows(page).last()
  await row.getByLabel('Identifier type').selectOption({ label: type })
  await row.getByLabel('Identifier value').fill(value)
  return row
}

/** Add an identifier and wait until it is saved (shown read-only). */
async function addIdentifier(page: Page, type: string, value: string) {
  const row = await fillRow(page, type, value)
  await row.getByLabel('Identifier value').press('Tab')
  await expect(
    identifiers(page).getByText(value, { exact: true }),
  ).toBeVisible()
  await expect(saved(page)).toBeVisible()
}

// ── in-page predicates (serialised: no closures, no imports) ──────────────

/** The form shows (or not) saved identifier window.__qcWant, and has saved. */
function identifierSaved(present: boolean) {
  const w = (window as unknown as { __qcWant?: string }).__qcWant
  const sec = [...document.querySelectorAll('section')].find(
    (s) => s.querySelector('h2')?.textContent === 'Identifiers',
  )
  const has = [...(sec?.querySelectorAll('li span') ?? [])].some(
    (s) => s.textContent === w,
  )
  const isSaved = [...document.querySelectorAll('span')].some((s) =>
    s.textContent.startsWith('All changes saved'),
  )
  return has === present && isSaved
}

// ── specs ──────────────────────────────────────────────────────────────────

test.describe('identifiers on a contact', { annotation: CONTACT_ROUTE }, () => {
  test(
    'add and remove an identifier',
    async ({ page, flow, users, instance }) => {
      const type = uniqueName('idtype')
      await createType(instance, users.a, type)
      const last = uniqueName('identified')
      await createContact(page, users.a.slug, last)
      await expect(identifiers(page).getByText('No identifiers.')).toBeVisible()

      let n = 0
      let value = ''
      await flow(page, 'contact.identifier.add', {
        before: async () => {
          value = `${last}-${++n}`
          await fillRow(page, type, value)
          await want(page, value)
        },
        // Leaving the value field finishes the row: it saves straight away.
        action: () =>
          idRows(page).last().getByLabel('Identifier value').press('Tab'),
        until: identifierSaved,
        arg: true,
      })
      // A saved row is read-only: change is remove + add.
      await expect(idRows(page).getByLabel('Identifier value')).toHaveCount(0)
      await expect(idRows(page)).toHaveCount(n)

      await flow(page, 'contact.identifier.remove', {
        before: async () => {
          if ((await idRows(page).count()) === 0)
            await addIdentifier(page, type, `${last}-${++n}`)
          value =
            (await idRows(page).first().locator('span').nth(1).textContent()) ??
            ''
          await want(page, value)
        },
        action: () =>
          identifiers(page)
            .getByRole('button', {
              name: `remove identifier ${value}`,
              exact: true,
            })
            .click(),
        until: identifierSaved,
        arg: false,
      })

      const left = await idRows(page).count()
      await page.reload()
      await expect(idRows(page)).toHaveCount(left)
      await expect(
        identifiers(page).getByText(value, { exact: true }),
      ).toBeHidden()
    },
  )

  test(
    'a duplicate is "to fix", naming the other contact, while other sections save',
    async ({ page, users, instance }) => {
      const type = uniqueName('idtype')
      await createType(instance, users.a, type)
      const holder = uniqueName('holder')
      const holderUrl = await createContact(page, users.a.slug, holder)
      const value = `${holder}-ID`
      await addIdentifier(page, type, value)

      await createContact(page, users.a.slug, uniqueName('second'))
      await page.getByLabel('Known as').fill('saved anyway')
      // Matching is trimmed and case-insensitive.
      await fillRow(page, type, ` ${value.toLowerCase()} `)
      await saveButton(page).click()
      await expect(contactForm(page).getByText('1 to fix')).toBeVisible()
      const link = idRows(page).getByRole('link', {
        name: `${value.toLowerCase()} is already used by Qc ${holder}`,
      })
      await expect(link).toBeVisible()
      await expect(link).toHaveAttribute('href', new URL(holderUrl).pathname)

      // Removing the row clears it; the details saved with the same click.
      await idRows(page)
        .last()
        .getByRole('button', { name: /^remove identifier/ })
        .click()
      await expect(contactForm(page).getByText('1 to fix')).toBeHidden()
      await page.reload()
      await expect(page.getByLabel('Known as')).toHaveValue('saved anyway')
      await expect(identifiers(page).getByText('No identifiers.')).toBeVisible()

      await page.goto(holderUrl)
      await expect(
        identifiers(page).getByText(value, { exact: true }),
      ).toBeVisible()
    },
  )

  test(
    'an archived type stays on its rows, marked, and is not offered',
    async ({ page, users, instance }) => {
      const type = uniqueName('idretired')
      const typeId = await createType(instance, users.a, type)
      // So "add" stays offered whatever else this worker's tenant holds.
      await createType(instance, users.a, uniqueName('idactive'))
      const url = await createContact(page, users.a.slug, uniqueName('kept'))
      const value = `${type}-1`
      await addIdentifier(page, type, value)

      // A value typed before its type is shown as not saved yet.
      await identifiers(page).getByRole('button', { name: 'add' }).click()
      await idRows(page).last().getByLabel('Identifier value').fill('later')
      await idRows(page).last().getByLabel('Identifier value').press('Tab')
      await expect(
        idRows(page).last().getByText('Choose a type to save this'),
      ).toBeVisible()
      await idRows(page)
        .last()
        .getByRole('button', { name: 'remove identifier later' })
        .click()

      await archiveType(instance, users.a, typeId, type)
      await page.goto(url)
      const row = idRows(page).filter({ hasText: value })
      await expect(row).toContainText('(archived type)')
      await identifiers(page).getByRole('button', { name: 'add' }).click()
      await expect(
        idRows(page)
          .last()
          .getByLabel('Identifier type')
          .locator('option', { hasText: type }),
      ).toHaveCount(0)
    },
  )

  test('hidden in a group with no active type', async ({
    browser,
    baseURL,
    session,
    users,
  }) => {
    const other = await secondTab(browser, baseURL!, await session(users.b))
    await createContact(other, users.b.slug, uniqueName('untyped'))
    await expect(
      other.getByRole('heading', { name: 'Addresses', exact: true }),
    ).toBeVisible()
    await expect(
      other.getByRole('heading', { name: 'Identifiers', exact: true }),
    ).toHaveCount(0)
    await other.context().close()
  })
})

test.describe('as a viewer', { annotation: CONTACT_ROUTE }, () => {
  test('identifiers show read-only', async ({
    browser,
    baseURL,
    session,
    users,
    world,
  }) => {
    const viewer = await secondTab(
      browser,
      baseURL!,
      await session(users.viewer),
    )
    const { shared } = world.identifiers
    await viewer.goto(
      `/t/${users.viewer.slug}/contacts/${world.tenants[0].contactIds[0]}`,
    )
    await expect(
      identifiers(viewer).getByText(shared, { exact: true }),
    ).toBeVisible()
    await expect(identifiers(viewer)).toContainText(world.identifierType)
    await expect(
      identifiers(viewer).getByRole('button', {
        name: `remove identifier ${shared}`,
      }),
    ).toBeDisabled()
    await expect(
      identifiers(viewer).getByRole('button', { name: 'add' }),
    ).toBeDisabled()

    await expect(saveButton(viewer)).toHaveCount(0)
    await expect(
      viewer.getByRole('link', { name: 'Contacts', exact: true }),
    ).toBeVisible()
    await viewer.context().close()
  })
})
