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
// note archived in one tab while another edits it. Then saving on blur
// and the unsaved-changes guard: discard confirm, leaving the page, and
// closing the tab.

const notes = (page: Page) => section(page, 'Notes')
const items = (page: Page) => notes(page).locator('li')
const composer = (page: Page) => notes(page).getByPlaceholder('Add a note…')
/** Somewhere outside every editor to click: blurs whatever has focus. */
const away = (page: Page) =>
  notes(page).getByRole('heading', { name: 'Notes', exact: true })
const dialog = (page: Page, name: string | RegExp) =>
  page.getByRole('alertdialog', { name })

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
    // Timed as the edit is normally saved: by clicking away.
    await flow(page, 'contact.note.save', {
      before: async () => {
        await top.getByRole('button', { name: 'edit' }).click()
        const body = `edited ${++e}`
        await top.getByRole('textbox').fill(body)
        await want(page, body)
      },
      action: () => away(page).click(),
      until: noteShowsWant,
    })
    await expect(top.getByText(/· edited /)).toBeVisible()
    await page.reload()
    await expect(items(page).nth(0).locator('p')).toHaveText(`edited ${e}`)

    // The Save button still saves.
    await top.getByRole('button', { name: 'edit' }).click()
    await top.getByRole('textbox').fill('saved by the button')
    await top.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(top.locator('p')).toHaveText('saved by the button')
  })

  test('cancel and Escape ask before discarding an edit', async ({
    page,
    users,
  }) => {
    await createContact(page, users.a.slug, uniqueName('discard'))
    await addNote(page, 'kept body')
    const top = items(page).nth(0)
    const box = top.getByRole('textbox')
    const discard = dialog(page, 'Discard your changes?')

    // Nothing changed: cancel just closes.
    await top.getByRole('button', { name: 'edit' }).click()
    await top.getByRole('button', { name: 'cancel' }).click()
    await expect(discard).toBeHidden()
    await expect(box).toBeHidden()

    // Changed: cancel asks; keeping on goes back to the text, unsaved.
    await top.getByRole('button', { name: 'edit' }).click()
    await box.fill('never saved')
    await top.getByRole('button', { name: 'cancel' }).click()
    await expect(discard).toBeVisible()
    await discard.getByRole('button', { name: 'Keep editing' }).click()
    await expect(discard).toBeHidden()
    await expect(box).toHaveValue('never saved')

    // Escape asks too; discarding leaves the note as it was.
    await box.press('Escape')
    await expect(discard).toBeVisible()
    await discard.getByRole('button', { name: 'Discard' }).click()
    await expect(box).toBeHidden()
    await expect(top.locator('p')).toHaveText('kept body')
    await page.reload()
    await expect(items(page).nth(0).locator('p')).toHaveText('kept body')
  })

  test('the composer adds a note when focus leaves it', async ({
    page,
    users,
  }) => {
    await createContact(page, users.a.slug, uniqueName('compblur'))

    // Empty: leaving adds nothing.
    await composer(page).click()
    await away(page).click()
    await expect(notes(page).getByText('No notes yet.')).toBeVisible()

    // Ticking "pin" is not leaving: the note waits, then is added pinned.
    await composer(page).fill('added on blur')
    await notes(page).getByLabel('pin', { exact: true }).check()
    await expect(notes(page).getByText('No notes yet.')).toBeVisible()
    await away(page).click()
    const added = items(page).filter({ hasText: 'added on blur' })
    await expect(added.getByText('pinned', { exact: true })).toBeVisible()
    await expect(composer(page)).toHaveValue('')
    await expect(
      notes(page).getByLabel('pin', { exact: true }),
    ).not.toBeChecked()

    // "Add note" takes the click; the blur on the way adds nothing extra.
    await addNote(page, 'added by the button')
    await expect(items(page)).toHaveCount(2)
    await page.reload()
    await expect(items(page)).toHaveCount(2)
  })

  test('leaving the page: a blur-saved edit just leaves, unsaved work asks', async ({
    page,
    users,
  }) => {
    test.info().annotations.push({
      type: 'route',
      description: '/t/$slug/tags',
    })
    const url = await createContact(page, users.a.slug, uniqueName('leave'))
    await addNote(page, 'before')
    const top = items(page).nth(0)
    const leave = dialog(page, /You have unsaved changes/)

    // Clicking a link blurs the editor: it saves on the way, no question.
    await top.getByRole('button', { name: 'edit' }).click()
    await top.getByRole('textbox').fill('saved on the way out')
    await page.getByRole('link', { name: 'Tags', exact: true }).click()
    await page.waitForURL(/\/tags$/)
    await expect(leave).toBeHidden()
    // Back inside the app (same document, so the router sees it).
    await page.goBack()
    await page.waitForURL(url)
    await expect(items(page).nth(0).locator('p')).toHaveText(
      'saved on the way out',
    )

    // Text a blur can't save (over the cap) asks, on Back as on a link;
    // staying keeps the text.
    const over = 'x'.repeat(20_001)
    await top.getByRole('button', { name: 'edit' }).click()
    await top.getByRole('textbox').fill(over)
    await page.goBack()
    await expect(leave).toBeVisible()
    await leave.getByRole('button', { name: 'Stay' }).click()
    await expect(leave).toBeHidden()
    expect(page.url()).toBe(url)
    await expect(top.getByRole('textbox')).toHaveValue(over)

    await page.getByRole('link', { name: 'Tags', exact: true }).click()
    await expect(leave).toBeVisible()
    await leave.getByRole('button', { name: 'Leave anyway' }).click()
    await page.waitForURL(/\/tags$/)
    await page.goBack()
    await page.waitForURL(url)
    await expect(items(page).nth(0).locator('p')).toHaveText(
      'saved on the way out',
    )

    // Back with a plain edit open saves it on the way, as a link does.
    await top.getByRole('button', { name: 'edit' }).click()
    await top.getByRole('textbox').fill('saved going back')
    await page.goBack()
    await page.waitForURL(/\/contacts\/new$/)
    await expect(leave).toBeHidden()
    await page.goForward()
    await page.waitForURL(url)
    await expect(items(page).nth(0).locator('p')).toHaveText('saved going back')
  })

  test('leaving waits for a slow save, and says so', async ({
    page,
    browser,
    baseURL,
    users,
    session,
  }) => {
    test.info().annotations.push({
      type: 'route',
      description: '/t/$slug/tags',
    })
    const url = await createContact(page, users.a.slug, uniqueName('slow'))
    await addNote(page, 'before')
    // The other tab's mutations are held 1.5 s on the way out while
    // `slow` is set: a slow link, as far as the page can tell.
    const other = await secondTab(browser, baseURL!, await session())
    let slow = false
    await other.context().routeWebSocket(/.*/, (ws) => {
      const server = ws.connectToServer()
      ws.onMessage((m) => {
        if (slow && typeof m === 'string' && m.includes('"Mutation"'))
          setTimeout(() => server.send(m), 1500)
        else server.send(m)
      })
      server.onMessage((m) => ws.send(m))
    })
    try {
      await other.goto(url)
      const top = items(other).nth(0)
      await top.getByRole('button', { name: 'edit' }).click()
      await top.getByRole('textbox').fill('saved before leaving')
      slow = true
      await other.getByRole('link', { name: 'Tags', exact: true }).click()
      const status = other.getByRole('status').filter({
        hasText: 'Saving before you leave…',
      })
      await expect(status).toBeVisible()
      expect(other.url()).toBe(url)
      // The save lands: the page leaves with no question.
      await other.waitForURL(/\/tags$/)
      await expect(status).toBeHidden()
      await expect(
        other.getByRole('alertdialog', { name: /You have unsaved changes/ }),
      ).toBeHidden()
      await expect(items(page).nth(0).locator('p')).toHaveText(
        'saved before leaving',
      )
    } finally {
      await other.context().close()
    }
  })

  test('closing the tab with unsaved work gets the browser prompt', async ({
    browser,
    baseURL,
    page,
    users,
    session,
  }) => {
    const url = await createContact(page, users.a.slug, uniqueName('unload'))
    const other = await secondTab(browser, baseURL!, await session())
    try {
      await other.goto(url)
      await composer(other).click()
      await composer(other).pressSequentially('not yet a note')
      const prompt = other.waitForEvent('dialog')
      await other.close({ runBeforeUnload: true })
      const d = await prompt
      expect(d.type()).toBe('beforeunload')
      await d.dismiss()
      await expect(composer(other)).toHaveValue('not yet a note')
    } finally {
      await other.context().close()
    }
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
