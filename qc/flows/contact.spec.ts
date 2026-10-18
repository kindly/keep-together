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
import type { Page, WebSocketRoute } from '@playwright/test'

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
    const count = await emails.count()
    expect(count).toBe(n)

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
      await page.getByPlaceholder('Search by name').fill(last)
      // Full-text search: other rows may match, but not the archived one.
      const row = page.getByRole('link', { name: new RegExp(`${last}(?!\\d)`) })
      await expect(page.getByRole('list')).toBeVisible()
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
        await expect(moments.first()).toBeVisible()
        const before = await moments.count()
        await known.fill(`restore ${++n}`)
        await saveButton(page).click()
        await expect(saved(page)).toBeVisible()
        await expect(moments).toHaveCount(before + 1)
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
    test('shows the stale notice, then merges and saves', async ({
      page,
      browser,
      baseURL,
      users,
      session,
    }) => {
      const url = await createContact(page, users.a.slug, uniqueName('stale'))
      // Tab B's socket goes through a gate: while held, nothing the server
      // sends reaches B, so B saves against a counter it hasn't seen move.
      const other = await secondTab(browser, baseURL!, await session())
      let held: Array<string | Buffer> | null = null
      let route: WebSocketRoute | undefined
      await other.context().routeWebSocket(/.*/, (ws) => {
        route = ws
        const server = ws.connectToServer()
        ws.onMessage((m) => server.send(m))
        server.onMessage((m) => (held ? held.push(m) : ws.send(m)))
      })
      try {
        await other.goto(url)
        await expect(other.getByLabel('Known as')).toBeVisible()
        await other.getByLabel('Title', { exact: true }).fill('from b')

        held = []
        await page.getByLabel('Known as').fill('from a')
        await saveButton(page).click()
        await expect(saved(page)).toBeVisible()
        await saveButton(other).click()
        // Let B's save reach the server and be answered (and held).
        await page.waitForTimeout(1000)
        // Deliver A's change first and let B render it, then B's save
        // result: the order a slower link gives. Released together, React
        // may apply the result first and clear the notice in the same
        // render.
        const release = held
        const answer = release.findIndex(
          (m) => typeof m === 'string' && m.includes('"MutationResponse"'),
        )
        expect(answer).toBeGreaterThan(0)
        for (const m of release.slice(0, answer)) route!.send(m)
        await expect(other.getByLabel('Known as')).toHaveValue('from a')
        held = null
        for (const m of release.slice(answer)) route!.send(m)

        await expect(
          other.getByText(/details changed by .* while you were editing/),
        ).toBeVisible()
        // B retries against the newer state: both edits end up saved.
        await expect(other.getByText(/while you were editing/)).toBeHidden()
        await expect(saved(other)).toBeVisible()
        await expect(other.getByLabel('Known as')).toHaveValue('from a')
        await expect(page.getByLabel('Title', { exact: true })).toHaveValue(
          'from b',
        )
      } finally {
        await other.context().close()
      }
    })
  },
)
