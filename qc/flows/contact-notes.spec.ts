import { expect, test } from '../fixtures'
import {
  CONTACT_ROUTE,
  buttonIsWant,
  createContact,
  secondTab,
  section,
  uniqueName,
  want,
} from './contact.helpers'
import type { Page } from '@playwright/test'

// QC step 8, the notes panel on the contact page (S7): add, edit,
// pin / unpin, archive / restore, "show archived", the byte budget, and a
// note archived in one tab while another edits it.

const notes = (page: Page) => section(page, 'Notes')
const items = (page: Page) => notes(page).locator('li')
const composer = (page: Page) => notes(page).getByPlaceholder('Add a note…')

/** The note whose body is `body` has a button reading window.__qcWant. */
function noteButtonIsWant(body: string) {
  const w = (window as unknown as { __qcWant?: string }).__qcWant
  return [...document.querySelectorAll('li')].some(
    (li) =>
      li.querySelector(':scope > p')?.textContent === body &&
      [...li.querySelectorAll('button')].some((b) => b.textContent === w),
  )
}

/** A note body shown in the list equals window.__qcWant. */
function noteShowsWant() {
  const w = (window as unknown as { __qcWant?: string }).__qcWant
  return [...document.querySelectorAll('li > p')].some(
    (p) => p.textContent === w,
  )
}

async function addNote(page: Page, body: string) {
  await composer(page).fill(body)
  await notes(page).getByRole('button', { name: 'Add note' }).click()
  await expect(items(page).getByText(body, { exact: true })).toBeVisible()
}

test.describe('contact notes', { annotation: CONTACT_ROUTE }, () => {
  test('add and edit', async ({ page, flow, users }) => {
    await createContact(page, users.a.slug, uniqueName('notes'))
    await expect(notes(page).getByText('No notes yet.')).toBeVisible()

    let n = 0
    await flow(page, 'contact.note.add', {
      before: async () => {
        const body = `note ${++n}`
        await composer(page).fill(body)
        await want(page, body)
      },
      action: () =>
        notes(page).getByRole('button', { name: 'Add note' }).click(),
      until: noteShowsWant,
    })
    await expect(items(page)).toHaveCount(n)
    // Newest first, and the composer is cleared.
    await expect(items(page).nth(0).locator('p')).toHaveText(`note ${n}`)
    await expect(composer(page)).toHaveValue('')

    const top = items(page).nth(0)
    let e = 0
    await flow(page, 'contact.note.save', {
      before: async () => {
        await top.getByRole('button', { name: 'edit' }).click()
        const body = `edited ${++e}`
        await top.getByRole('textbox').fill(body)
        await want(page, body)
      },
      action: () =>
        top.getByRole('button', { name: 'Save', exact: true }).click(),
      until: noteShowsWant,
    })
    await expect(top.getByText(/· edited /)).toBeVisible()

    // Cancel leaves the body alone.
    await top.getByRole('button', { name: 'edit' }).click()
    await top.getByRole('textbox').fill('never saved')
    await top.getByRole('button', { name: 'cancel' }).click()
    await expect(top.locator('p')).toHaveText(`edited ${e}`)
    await page.reload()
    await expect(items(page).nth(0).locator('p')).toHaveText(`edited ${e}`)
  })

  test('pin and unpin', async ({ page, flow, users }) => {
    await createContact(page, users.a.slug, uniqueName('pin'))
    await addNote(page, 'older')
    await addNote(page, 'newer')
    await expect(items(page).nth(0).locator('p')).toHaveText('newer')

    const older = items(page).filter({ hasText: 'older' })
    await flow(page, 'contact.note.pin', {
      before: async () => {
        const label = await older
          .getByRole('button', { name: /^(pin|unpin)$/ })
          .textContent()
        await want(page, label === 'pin' ? 'unpin' : 'pin')
      },
      action: () =>
        older.getByRole('button', { name: /^(pin|unpin)$/ }).click(),
      until: noteButtonIsWant,
      arg: 'older',
    })

    // Pinned goes first, with its badge; unpinned returns to newest first.
    const pin = older.getByRole('button', { name: /^(pin|unpin)$/ })
    if ((await pin.textContent()) === 'pin') await pin.click()
    await expect(older.getByText('pinned', { exact: true })).toBeVisible()
    await expect(items(page).nth(0).locator('p')).toHaveText('older')
    await older.getByRole('button', { name: 'unpin' }).click()
    await expect(older.getByText('pinned', { exact: true })).toBeHidden()
    await expect(items(page).nth(0).locator('p')).toHaveText('newer')
  })

  test('archive, restore and "show archived"', async ({
    page,
    flow,
    users,
  }) => {
    await createContact(page, users.a.slug, uniqueName('archnote'))
    await addNote(page, 'to archive')
    const showArchived = notes(page).getByLabel('show archived')

    await items(page).getByRole('button', { name: 'archive' }).click()
    await expect(notes(page).getByText('No notes yet.')).toBeVisible()
    await expect(notes(page).getByText('to archive')).toBeHidden()
    await showArchived.check()
    await expect(
      notes(page).getByText('Archived', { exact: true }),
    ).toBeVisible()
    const archived = items(page).filter({ hasText: 'to archive' })
    await expect(
      archived.getByRole('button', { name: 'restore' }),
    ).toBeVisible()
    // An archived note can't be edited or pinned, only restored.
    await expect(archived.getByRole('button', { name: 'edit' })).toBeHidden()

    // Timed both ways with the archived list showing.
    const toggle = archived.getByRole('button', { name: /^(archive|restore)$/ })
    await flow(page, 'contact.note.archive', {
      before: async () => {
        await want(
          page,
          (await toggle.textContent()) === 'archive' ? 'restore' : 'archive',
        )
      },
      action: () => toggle.click(),
      until: buttonIsWant,
    })

    if ((await toggle.textContent()) === 'restore') await toggle.click()
    await expect(notes(page).getByText('No archived notes.')).toBeVisible()
    await showArchived.uncheck()
    await expect(
      notes(page).getByText('Archived', { exact: true }),
    ).toBeHidden()
    await expect(items(page).locator('p')).toHaveText('to archive')
  })

  test('the byte budget warns near 20,000 bytes and blocks over it', async ({
    page,
    users,
  }) => {
    await createContact(page, users.a.slug, uniqueName('budget'))
    const add = notes(page).getByRole('button', { name: 'Add note' })

    await composer(page).fill('x'.repeat(17_999))
    await expect(notes(page).getByText(/Nearly full/)).toBeHidden()
    await composer(page).fill('x'.repeat(18_500))
    await expect(
      notes(page).getByText(/^Nearly full: 1,500 bytes left\./),
    ).toBeVisible()
    await expect(add).toBeEnabled()

    // Bytes, not characters: 6,667 × "é" is 13,334 bytes, still fine;
    // 10,001 is 20,002 bytes.
    await composer(page).fill('é'.repeat(6_667))
    await expect(notes(page).getByText(/Nearly full/)).toBeHidden()
    await composer(page).fill('é'.repeat(10_001))
    await expect(
      notes(page).getByText(/^2 bytes over the limit\./),
    ).toBeVisible()
    await expect(add).toBeDisabled()

    // Exactly at the cap saves.
    await composer(page).fill('y'.repeat(20_000))
    await expect(
      notes(page).getByText(/^Nearly full: 0 bytes left\./),
    ).toBeVisible()
    await add.click()
    await expect(items(page)).toHaveCount(1)
    await expect(composer(page)).toHaveValue('')
  })

  test('a note archived in another tab keeps the draft: Restore and save', async ({
    page,
    browser,
    baseURL,
    users,
    session,
  }) => {
    const url = await createContact(page, users.a.slug, uniqueName('draft'))
    await addNote(page, 'original text')

    const other = await secondTab(browser, baseURL!, await session())
    try {
      await other.goto(url)
      const editing = items(other).filter({ hasText: 'original text' })
      await editing.getByRole('button', { name: 'edit' }).click()
      await items(other).getByRole('textbox').fill('draft from the other tab')

      await items(page).getByRole('button', { name: 'archive' }).click()
      await expect(notes(page).getByText('No notes yet.')).toBeVisible()

      await expect(
        notes(other).getByText(
          /Someone archived this note while you were editing/,
        ),
      ).toBeVisible()
      await expect(items(other).getByRole('textbox')).toHaveValue(
        'draft from the other tab',
      )
      await notes(other)
        .getByRole('button', { name: 'Restore and save' })
        .click()

      await expect(
        items(page).getByText('draft from the other tab', { exact: true }),
      ).toBeVisible()
      await expect(
        items(other).getByText('draft from the other tab', { exact: true }),
      ).toBeVisible()
      await expect(items(other).getByRole('textbox')).toBeHidden()
    } finally {
      await other.context().close()
    }
  })
})
