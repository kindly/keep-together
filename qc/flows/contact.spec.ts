import { expect, test } from '../fixtures'
import {
  CONTACT_ROUTE,
  LIST_ROUTE,
  buttonIsWant,
  contactForm,
  createContact,
  fieldHoldsWant,
  paneSaved,
  rows,
  saveButton,
  saved,
  secondTab,
  section,
  uniqueName,
  want,
} from './contact.helpers'
import type { Page } from '@playwright/test'

// QC step 8: the contact page (factory/plans/qc-suite.sv). Details and the
// save pane, emails / phones / addresses, advisory warnings (ADR 0015),
// archive, history and restore, and two tabs on one contact.

test.describe('contact page', { annotation: CONTACT_ROUTE }, () => {
  test('details: Save, then autosave on its own', async ({
    page,
    flow,
    users,
  }) => {
    await createContact(page, users.a.slug, uniqueName('save'))
    await expect(contactForm(page).getByText('Up to date')).toBeVisible()

    let n = 0
    await flow(page, 'contact.save', {
      before: async () => {
        await page.getByLabel('Known as').fill(`save ${++n}`)
        await expect(
          contactForm(page).getByText('Unsaved changes'),
        ).toBeVisible()
      },
      action: () => saveButton(page).click(),
      until: paneSaved,
    })

    // Autosave: an edit committed by leaving the field saves with no click.
    await page.getByLabel('Title', { exact: true }).fill('autosaved')
    await expect(contactForm(page).getByText('Unsaved changes')).toBeVisible()
    await page.getByLabel('Title', { exact: true }).press('Tab')
    await expect(saved(page)).toBeVisible()
    await page.reload()
    await expect(page.getByLabel('Title', { exact: true })).toHaveValue(
      'autosaved',
    )
    await expect(page.getByLabel('Known as')).toHaveValue(`save ${n}`)
  })

  test('Deceased toggles from its box and text, not the empty cell', async ({
    page,
    users,
  }) => {
    await createContact(page, users.a.slug, uniqueName('dead'))
    const box = page.getByRole('checkbox', { name: 'Deceased' })
    await expect(box).not.toBeChecked()
    // The empty space to the right of "Deceased", in its grid cell.
    const label = page.locator('label').filter({ has: box })
    const cell = label.locator('xpath=..')
    const l = (await label.boundingBox())!
    const c = (await cell.boundingBox())!
    expect(c.x + c.width - (l.x + l.width)).toBeGreaterThan(40)
    await page.mouse.click(l.x + l.width + 30, l.y + l.height / 2)
    await expect(box).not.toBeChecked()
    // Above it, where the cell lines up with the field labels beside it.
    await page.mouse.click(l.x + 5, c.y + 2)
    await expect(box).not.toBeChecked()
    // The text is still its label.
    await label.getByText('Deceased').click()
    await expect(box).toBeChecked()
    await box.click()
    await expect(box).not.toBeChecked()
  })

  test('emails: add, label, primary, remove', async ({ page, flow, users }) => {
    const last = uniqueName('emails')
    await createContact(page, users.a.slug, last)
    const emails = rows(page, 'Emails')
    const add = section(page, 'Emails').getByRole('button', { name: 'add' })
    // A contact with no way to reach it carries a whole-contact notice.
    await expect(page.getByText('No email, phone or address yet')).toBeVisible()

    let n = 0
    await flow(page, 'contact.addEmail', {
      before: async () => {
        await add.click()
        await emails
          .last()
          .getByPlaceholder('email address')
          .fill(`${last}-${++n}@example.com`.toLowerCase())
        await expect(
          contactForm(page).getByText('Unsaved changes'),
        ).toBeVisible()
      },
      action: () => saveButton(page).click(),
      until: paneSaved,
    })
    await expect(page.getByText('No email, phone or address yet')).toBeHidden()
    expect(await emails.count()).toBe(n)
    // Three at least, whatever QC_REPEATS timed: one goes, and two must
    // be left to tell primary from not.
    while ((await emails.count()) < 3) {
      await add.click()
      await emails
        .last()
        .getByPlaceholder('email address')
        .fill(`${last}-${++n}@example.com`.toLowerCase())
      await saveButton(page).click()
      await expect(saved(page)).toBeVisible()
    }
    const count = await emails.count()

    // Label the second, make it primary, remove the first.
    await emails.nth(1).getByRole('combobox').selectOption('work')
    await emails.nth(1).getByRole('radio').check()
    await emails.nth(0).getByRole('button', { name: 'remove' }).click()
    await saveButton(page).click()
    await expect(saved(page)).toBeVisible()

    await page.reload()
    await expect(emails).toHaveCount(count - 1)
    const first = emails.nth(0)
    await expect(first.getByPlaceholder('email address')).toHaveValue(
      `${last}-2@example.com`.toLowerCase(),
    )
    await expect(first.getByRole('combobox')).toHaveValue('work')
    await expect(first.getByRole('radio')).toBeChecked()
    await expect(emails.nth(1).getByRole('radio')).not.toBeChecked()
  })

  test('phones and addresses: add, label, primary, remove', async ({
    page,
    users,
  }) => {
    await createContact(page, users.a.slug, uniqueName('phones'))
    const phones = rows(page, 'Phones')
    const addPhone = section(page, 'Phones').getByRole('button', {
      name: 'add',
    })
    await addPhone.click()
    await phones.nth(0).getByPlaceholder('phone number').fill('01632 960001')
    await addPhone.click()
    await phones.nth(1).getByPlaceholder('phone number').fill('07700 900002')
    await phones.nth(1).getByRole('combobox').selectOption('work')
    await phones.nth(1).getByRole('radio').check()
    await phones.nth(0).getByRole('button', { name: 'remove' }).click()

    const addresses = rows(page, 'Addresses')
    const addAddress = section(page, 'Addresses').getByRole('button', {
      name: 'add',
    })
    await addAddress.click()
    await addresses.nth(0).getByPlaceholder('Address line 1').fill('1 Old Road')
    await addresses.nth(0).getByPlaceholder('Town').fill('Oldtown')
    await addresses.nth(0).getByPlaceholder('Postcode').fill('SW1A 1AA')
    await addAddress.click()
    const second = addresses.nth(1)
    await second.getByPlaceholder('Address line 1').fill('2 New Street')
    await second.getByPlaceholder('Town').fill('Newtown')
    await second.getByPlaceholder('Postcode').fill('EC1A 1BB')
    await second.getByRole('combobox').selectOption('other')
    await second.getByRole('radio').check()
    await addresses.nth(0).getByRole('button', { name: 'remove' }).click()

    await saveButton(page).click()
    await expect(saved(page)).toBeVisible()

    // Addresses are editable in place: change the kept one, save again.
    await addresses.nth(0).getByPlaceholder('Town').fill('Newer Town')
    await saveButton(page).click()
    await expect(contactForm(page).getByText('Unsaved changes')).toBeHidden()
    await expect(saved(page)).toBeVisible()

    await page.reload()
    await expect(phones).toHaveCount(1)
    await expect(phones.nth(0).getByPlaceholder('phone number')).toHaveValue(
      '07700 900002',
    )
    await expect(phones.nth(0).getByRole('combobox')).toHaveValue('work')
    await expect(phones.nth(0).getByRole('radio')).toBeChecked()
    await expect(addresses).toHaveCount(1)
    const kept = addresses.nth(0)
    await expect(kept.getByPlaceholder('Address line 1')).toHaveValue(
      '2 New Street',
    )
    await expect(kept.getByPlaceholder('Town')).toHaveValue('Newer Town')
    await expect(kept.getByRole('combobox')).toHaveValue('other')
    await expect(kept.getByRole('radio')).toBeChecked()
  })

  test('a malformed email saves and shows "to check"', async ({
    page,
    users,
  }) => {
    await createContact(page, users.a.slug, uniqueName('malformed'))
    await section(page, 'Emails').getByRole('button', { name: 'add' }).click()
    await rows(page, 'Emails')
      .nth(0)
      .getByPlaceholder('email address')
      .fill('not-an-email')
    await saveButton(page).click()
    await expect(saved(page)).toBeVisible()
    await expect(
      page.getByText('“not-an-email” doesn’t look like an email address'),
    ).toBeVisible()
    await expect(contactForm(page).getByText('1 to check')).toBeVisible()

    // Stored, not blocked: it survives a reload.
    await page.reload()
    await expect(
      rows(page, 'Emails').nth(0).getByPlaceholder('email address'),
    ).toHaveValue('not-an-email')
    await expect(contactForm(page).getByText('1 to check')).toBeVisible()
  })

  test('invalid details show "N to fix" and are not saved', async ({
    page,
    users,
  }) => {
    const last = uniqueName('tofix')
    await createContact(page, users.a.slug, last)
    await page.getByLabel('Last name').fill('')
    await saveButton(page).click()
    await expect(contactForm(page).getByText('1 to fix')).toBeVisible()
    await expect(
      page.getByText('An individual needs a last name'),
    ).toBeVisible()

    // Fixing it clears the count and saves.
    await page.getByLabel('Last name').fill(`${last}-fixed`)
    await saveButton(page).click()
    await expect(saved(page)).toBeVisible()
    await expect(contactForm(page).getByText(/to fix/)).toBeHidden()
    await page.reload()
    await expect(page.getByLabel('Last name')).toHaveValue(`${last}-fixed`)
  })

  test('a shared email names the other contacts, archived ones marked', async ({
    page,
    users,
  }) => {
    const sharerLast = uniqueName('sharer')
    const address = `${uniqueName('shared')}@example.com`.toLowerCase()
    const addEmail = async () => {
      await section(page, 'Emails').getByRole('button', { name: 'add' }).click()
      await rows(page, 'Emails')
        .nth(0)
        .getByPlaceholder('email address')
        .fill(address)
      await saveButton(page).click()
      await expect(saved(page)).toBeVisible()
    }
    const sharerUrl = await createContact(page, users.a.slug, sharerLast)
    await addEmail()
    await expect(page.getByText(/Also used by/)).toBeHidden()

    const ownerUrl = await createContact(
      page,
      users.a.slug,
      uniqueName('owner'),
    )
    await addEmail()
    await expect(page.getByText(`Also used by Qc ${sharerLast}`)).toBeVisible()

    await page.goto(sharerUrl)
    await page.getByRole('button', { name: 'Archive', exact: true }).click()
    await expect(
      page.getByRole('button', { name: 'Unarchive', exact: true }),
    ).toBeVisible()
    await page.goto(ownerUrl)
    await expect(
      page.getByText(`Also used by Qc ${sharerLast} (archived)`),
    ).toBeVisible()
  })

  test('a malformed shared email shows both of its warnings', async ({
    page,
    users,
  }) => {
    // No TLD: storable, but doesn't look like an address (S1 review, L2).
    const address = `${uniqueName('l2')}@example`.toLowerCase()
    const addEmail = async () => {
      await section(page, 'Emails').getByRole('button', { name: 'add' }).click()
      await rows(page, 'Emails')
        .nth(0)
        .getByPlaceholder('email address')
        .fill(address)
      await saveButton(page).click()
      await expect(saved(page)).toBeVisible()
    }
    const sharerLast = uniqueName('l2sharer')
    await createContact(page, users.a.slug, sharerLast)
    await addEmail()
    await createContact(page, users.a.slug, uniqueName('l2owner'))
    await addEmail()
    const row = rows(page, 'Emails').nth(0)
    await expect(
      row.getByText(`“${address}” doesn’t look like an email address`),
    ).toBeVisible()
    await expect(row.getByText(`Also used by Qc ${sharerLast}`)).toBeVisible()
  })

  test(
    'archive, and its badge in the list',
    { annotation: [CONTACT_ROUTE, LIST_ROUTE] },
    async ({ page, flow, users }) => {
      const last = uniqueName('archive')
      await createContact(page, users.a.slug, last)
      const toggle = page.getByRole('button', { name: /^(Archive|Unarchive)$/ })
      await flow(page, 'contact.archive', {
        before: async () => {
          await expect(toggle).toBeVisible()
          await want(
            page,
            (await toggle.textContent()) === 'Archive'
              ? 'Unarchive'
              : 'Archive',
          )
        },
        action: () => toggle.click(),
        until: buttonIsWant,
      })
      if ((await toggle.textContent()) === 'Archive') await toggle.click()
      await expect(toggle).toHaveText('Unarchive')

      await page.goto(`/t/${users.a.slug}/contacts`)
      await page.getByRole('searchbox').fill(last)
      // Full-text search: other rows may match, but not the archived one.
      const row = page.getByRole('link', { name: new RegExp(`${last}(?!\\d)`) })
      // Every word must match, so the archived contact may be the only hit:
      // wait for the result (a list or the empty notice) before checking.
      await expect(
        page.getByRole('list').or(page.getByText('No contacts match.')),
      ).toBeVisible()
      await expect(row).toBeHidden()
      await page.getByLabel('show archived').check()
      await expect(row).toBeVisible()
      await expect(row.getByText('archived', { exact: true })).toBeVisible()
    },
  )

  test('history and Restore to here', async ({ page, flow, users }) => {
    await createContact(page, users.a.slug, uniqueName('restore'))
    const moments = page.locator('aside ol > li')
    const known = page.getByLabel('Known as')

    let n = 0
    await flow(page, 'contact.restore', {
      before: async () => {
        // Waits for the save's own moment on top, not for a total: each
        // round adds two moments, and the panel shows the newest page of
        // 10 revisions until "Load older" is pressed.
        await expect(moments.first()).toBeVisible()
        // History is fetched once the root changes, a round trip after the
        // form: wait for the last round's restore to be on top.
        if (n > 0)
          await expect(moments.first().getByText('restored')).toBeVisible()
        const top = await moments.first().getAttribute('data-revision')
        await known.fill(`restore ${++n}`)
        await saveButton(page).click()
        await expect(saved(page)).toBeVisible()
        await expect(moments.first()).not.toHaveAttribute('data-revision', top!)
        await expect(moments.nth(0).getByText('current')).toBeVisible()
        await want(page, '')
      },
      // The moment before this save: the nickname was empty.
      action: () =>
        page.getByRole('button', { name: 'Restore to here' }).first().click(),
      until: fieldHoldsWant,
      arg: 'Known as',
    })
    await expect(moments.nth(0).getByText('restored')).toBeVisible()
    await page.reload()
    await expect(known).toHaveValue('')
  })

  test('history pages: Load older, and no gap while saves arrive', async ({
    page,
    users,
  }) => {
    await createContact(page, users.a.slug, uniqueName('pages'))
    const moments = page.locator('aside ol > li')
    const known = page.getByLabel('Known as')
    // The create's moment first, so the first save has a top to replace.
    await expect(moments).toHaveCount(1)
    // Waits for the save's moment on top: the panel shows the newest
    // page of 10 until "Load older", so a count stops growing at 10.
    const saveKnownAs = async (value: string) => {
      const top = await moments.first().getAttribute('data-revision')
      await known.fill(value)
      await saveButton(page).click()
      await expect(saved(page)).toBeVisible()
      await expect(moments.first()).not.toHaveAttribute('data-revision', top!)
    }
    /** The panel's moments as [revision id, time], top to bottom. */
    const shown = () =>
      moments.evaluateAll((items) =>
        items.map((li) => [
          li.getAttribute('data-revision')!,
          Number(li.getAttribute('data-at')),
        ]),
      )
    // Each save is one details revision, so one moment: well past a page.
    for (let i = 1; i <= 14; i++) await saveKnownAs(`page ${i}`)

    // A fresh load shows the newest page only.
    await page.reload()
    await expect(moments).toHaveCount(10)
    await page.getByRole('button', { name: 'Load older' }).click()
    // Hidden while the older page loads too: wait for the page itself.
    await expect(page.getByRole('button', { name: 'Load older' })).toBeHidden()
    await expect(page.locator('aside').getByText('Loading…')).toBeHidden()
    const all = await shown()
    expect(all.length).toBeGreaterThan(10)

    // Saves land on the newest page, which grows; the older page stays put.
    await saveKnownAs('after 1')
    await saveKnownAs('after 2')
    const after = await shown()
    expect(after).toHaveLength(all.length + 2)
    expect(after.slice(2)).toEqual(all)
    expect(new Set(after.map(([id]) => id)).size).toBe(after.length)
    const times = after.map(([, at]) => at as number)
    expect(times).toEqual([...times].sort((a, b) => b - a))
  })

  test('Restore to here on a moment from an older page', async ({
    page,
    users,
  }) => {
    await createContact(page, users.a.slug, uniqueName('older'))
    const moments = page.locator('aside ol > li')
    const known = page.getByLabel('Known as')
    await expect(moments).toHaveCount(1)
    for (let i = 1; i <= 12; i++) {
      const top = await moments.first().getAttribute('data-revision')
      await known.fill(`old ${i}`)
      await saveButton(page).click()
      await expect(saved(page)).toBeVisible()
      await expect(moments.first()).not.toHaveAttribute('data-revision', top!)
    }
    // Newest first: "old 12" … "old 1", then the create. A fresh load
    // shows the newest 10, so "old 1" (12th) is on the older page.
    await page.reload()
    await expect(moments).toHaveCount(10)
    await page.getByRole('button', { name: 'Load older' }).click()
    await expect(moments).toHaveCount(13)
    const target = moments.nth(11)
    const at = await target.getAttribute('data-at')
    await target.getByRole('button', { name: 'Restore to here' }).click()

    await expect(known).toHaveValue('old 1')
    await expect(moments.nth(0).getByText('restored')).toBeVisible()
    // The older page stays put under the restore's moment.
    await expect(moments.nth(12)).toHaveAttribute('data-at', at!)
    await page.reload()
    await expect(known).toHaveValue('old 1')
  })

  test('a contact from another group: "No such contact"', async ({
    page,
    users,
    world,
  }) => {
    await page.goto(
      `/t/${users.a.slug}/contacts/${world.tenants[1].contactIds[0]}`,
    )
    await expect(page.getByText('No such contact.')).toBeVisible()
  })
})

test.describe('two tabs on one contact', { annotation: CONTACT_ROUTE }, () => {
  let other: Page

  test.beforeEach(async ({ page, browser, baseURL, users, session }) => {
    const url = await createContact(page, users.a.slug, uniqueName('tabs'))
    other = await secondTab(browser, baseURL!, await session())
    await other.goto(url)
    await expect(other.getByLabel('Known as')).toBeVisible()
  })

  test.afterEach(async () => {
    await other.context().close()
  })

  test('a save in one tab reaches the other', async ({ page, flow }) => {
    let n = 0
    await flow(other, 'contact.livePropagation', {
      inputPage: page,
      before: async () => {
        const value = `live ${++n}`
        await page.getByLabel('Known as').fill(value)
        await expect(
          contactForm(page).getByText('Unsaved changes'),
        ).toBeVisible()
        await want(other, value)
      },
      action: () => saveButton(page).click(),
      until: fieldHoldsWant,
      arg: 'Known as',
    })
  })

  test('a remote edit lands under in-progress typing', async ({ page }) => {
    await other.getByLabel('Title', { exact: true }).fill('typing in b')
    await page.getByLabel('Known as').fill('from a')
    await saveButton(page).click()
    await expect(saved(page)).toBeVisible()

    await expect(other.getByLabel('Known as')).toHaveValue('from a')
    await expect(other.getByLabel('Title', { exact: true })).toHaveValue(
      'typing in b',
    )
    await expect(other.getByLabel('Title', { exact: true })).toBeFocused()
    await expect(other.getByText('changed by someone else too')).toBeHidden()
  })

  test('the same field edited in both shows the conflict badge', async ({
    page,
  }) => {
    await other.getByLabel('Known as').fill('mine in b')
    await page.getByLabel('Known as').fill('theirs in a')
    await saveButton(page).click()
    await expect(saved(page)).toBeVisible()

    await expect(other.getByText('changed by someone else too')).toBeVisible()
    await expect(
      other.getByText('Changed by both of you: details.nickname'),
    ).toBeVisible()
    await expect(other.getByLabel('Known as')).toHaveValue('mine in b')

    // B's value is kept and wins on save; the badge clears.
    await saveButton(other).click()
    await expect(saved(other)).toBeVisible()
    await expect(other.getByText('changed by someone else too')).toBeHidden()
    await expect(page.getByLabel('Known as')).toHaveValue('mine in b')
  })
})

test.describe(
  'a save against an unseen change',
  { annotation: CONTACT_ROUTE },
  () => {
    test('merges the change and retries at once: both edits saved', async ({
      page,
      browser,
      baseURL,
      flow,
      users,
      session,
    }) => {
      const url = await createContact(page, users.a.slug, uniqueName('stale'))
      // Tab B gets no change events (its stream is refused), so it saves
      // against a counter it hasn't seen move: the save answers the stale
      // slice's state now, B merges it and sends the retry straight away.
      const other = await secondTab(browser, baseURL!, await session())
      await other.context().route('**/api/t/*/events', (r) => r.abort())
      try {
        await other.goto(url)
        await expect(other.getByLabel('Known as')).toBeVisible()
        let n = 0
        await flow(other, 'contact.staleMerge', {
          before: async () => {
            n += 1
            await page.getByLabel('Known as').fill(`from a ${n}`)
            await saveButton(page).click()
            await expect(saved(page)).toBeVisible()
            await want(other, `from a ${n}`)
            // Last, and saved by the action: typed any earlier, B's 700 ms
            // autosave could send it (and merge) inside `before` under load.
            await other.getByLabel('Title', { exact: true }).fill(`from b ${n}`)
          },
          action: () => saveButton(other).click(),
          // Saved, with A's change merged in under B's own.
          until: (label) => {
            const w = (window as unknown as { __qcWant?: string }).__qcWant
            const holds = [...document.querySelectorAll('label')].some(
              (l) =>
                l.querySelector('span')?.childNodes[0]?.textContent === label &&
                l.querySelector('input')?.value === w,
            )
            return (
              holds &&
              [...document.querySelectorAll('span')].some((x) =>
                x.textContent.startsWith('All changes saved'),
              )
            )
          },
          arg: 'Known as',
          server: true,
        })
        // Both edits are on the server: A sees B's, live.
        await expect(page.getByLabel('Title', { exact: true })).toHaveValue(
          `from b ${n}`,
        )
        await expect(other.getByLabel('Known as')).toHaveValue(`from a ${n}`)
        await other.reload()
        await expect(other.getByLabel('Title', { exact: true })).toHaveValue(
          `from b ${n}`,
        )
      } finally {
        await other.context().close()
      }
    })
  },
)
