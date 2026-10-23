import { expect, test } from '../fixtures'
import {
  CONTACT_ROUTE,
  LIST_ROUTE,
  createContact,
  saved,
  secondTab,
  section,
  uniqueName,
  want,
} from './contact.helpers'
import type { Page } from '@playwright/test'

// Dropdown fields (plan: dropdown fields, step 6): the Settings › Fields
// tab (create, add options, archive / reactivate, the staff switch), a
// value on the contact form (set, clear), the list's field filter and
// bulk "set field". Tenant A is seeded with one field, "Volunteer status",
// that no contact carries. A tenant has 5 slots and the world is shared
// by the worker's tests, so a test that makes a field gets rid of it
// again (deleted while unused, retired once used), and values set on the
// seeded field go only on contacts the test made.

const FIELDS_ROUTE = { type: 'route', description: '/t/$slug/settings/fields' }
const SETTINGS_ROUTE = { type: 'route', description: '/t/$slug/settings' }

const fieldsPath = (slug: string) => `/t/${slug}/settings/fields`

/** The Fields tab's card for a field. */
const fieldCard = (page: Page, label: string) =>
  page
    .getByTestId('field')
    .filter({ has: page.getByText(label, { exact: true }) })

/** A card's own row: its label and the field's buttons, not its options'. */
const fieldHead = (page: Page, label: string) =>
  fieldCard(page, label).locator(':scope > div').first()

/** On the Fields tab: add a field and its options, untimed. */
async function addField(
  page: Page,
  label: string,
  options: Array<string>,
  { individualsOnly = false } = {},
) {
  await page.getByLabel('New field').fill(label)
  if (individualsOnly) {
    const kinds = page.getByRole('group', { name: 'Applies to (new field)' })
    await kinds.getByLabel('Organisations').uncheck()
    await kinds.getByLabel('Households').uncheck()
  }
  await page.getByRole('button', { name: 'Add field' }).click()
  const card = fieldCard(page, label)
  await expect(card).toBeVisible()
  for (const o of options) {
    await card.getByLabel(`New option for ${label}`).fill(o)
    await card.getByRole('button', { name: 'Add option' }).click()
    await expect(
      card.getByRole('list', { name: `Options of ${label}` }).getByText(o, {
        exact: true,
      }),
    ).toBeVisible()
  }
}

/** Open the Fields tab and add a field there (see addField). */
async function createField(
  page: Page,
  slug: string,
  label: string,
  options: Array<string>,
  opts?: { individualsOnly?: boolean },
) {
  await page.goto(fieldsPath(slug))
  await expect(
    page.getByRole('heading', { name: 'Fields', level: 2 }),
  ).toBeVisible()
  await addField(page, label, options, opts)
}

/**
 * Free a field's slot: delete it while none of its options was used,
 * else retire it (clearing its values). Leaves the Fields tab open.
 */
async function dropField(page: Page, slug: string, label: string) {
  if (!page.url().endsWith(fieldsPath(slug))) await page.goto(fieldsPath(slug))
  const showArchived = page.getByLabel(/^Show archived/)
  await showArchived.check()
  const card = fieldCard(page, label)
  await expect(card).toBeVisible()
  const head = fieldHead(page, label)
  const remove = head.getByRole('button', { name: 'delete', exact: true })
  const dialog = page.getByRole('alertdialog')
  if (await remove.isEnabled()) {
    await remove.click()
    await dialog.getByRole('button', { name: 'Delete' }).click()
  } else {
    await head.getByRole('button', { name: 'retire', exact: true }).click()
    await dialog.getByRole('button', { name: 'Retire field' }).click()
  }
  await expect(card).toHaveCount(0)
  await showArchived.uncheck()
}

/** The contact form's select for a field. */
const valueSelect = (page: Page, label: string) =>
  section(page, 'Fields').getByLabel(label)

// ── in-page predicates (serialised: no closures, no imports) ──────────────

/** The Fields tab has a card labelled window.__qcWant. */
function fieldListed() {
  const w = (window as unknown as { __qcWant?: string }).__qcWant
  return [...document.querySelectorAll('[data-testid="field"] span')].some(
    (s) => s.classList.contains('font-medium') && s.textContent === w,
  )
}

/** The field `label`'s options include window.__qcWant. */
function optionListed(label: string) {
  const w = (window as unknown as { __qcWant?: string }).__qcWant
  const list = document.querySelector(`ol[aria-label="Options of ${label}"]`)
  return [...(list?.querySelectorAll('li span') ?? [])].some(
    (s) => s.textContent === w,
  )
}

/** The card for `label` has a button reading window.__qcWant. */
function fieldButtonIsWant(label: string) {
  const w = (window as unknown as { __qcWant?: string }).__qcWant
  return [...document.querySelectorAll('[data-testid="field"]')].some(
    (card) =>
      [...card.querySelectorAll('span')].some(
        (s) => s.classList.contains('font-medium') && s.textContent === label,
      ) &&
      [...(card.firstElementChild?.querySelectorAll('button') ?? [])].some(
        (b) => b.textContent === w,
      ),
  )
}

/** The form's select for `label` shows window.__qcWant, and has saved. */
function valueSaved(label: string) {
  const w = (window as unknown as { __qcWant?: string }).__qcWant
  let shown: string | undefined
  for (const l of document.querySelectorAll('label')) {
    if (l.querySelector('span')?.childNodes[0]?.textContent === label) {
      shown = l.querySelector('select')?.selectedOptions[0]?.textContent
      break
    }
  }
  const isSaved = [...document.querySelectorAll('span')].some((s) =>
    s.textContent.startsWith('All changes saved'),
  )
  return shown === w && isSaved
}

/** The list shows exactly one row, and it names window.__qcWant. */
function onlyRowIsWant() {
  const w = (window as unknown as { __qcWant?: string }).__qcWant ?? ''
  const links = [...document.querySelectorAll('main ul li a')]
  return links.length === 1 && links[0].textContent.includes(w)
}

/** A status line starts with window.__qcWant. */
function statusIsWant() {
  const w = (window as unknown as { __qcWant?: string }).__qcWant ?? '?'
  return [...document.querySelectorAll('[role="status"]')].some((s) =>
    s.textContent.startsWith(w),
  )
}

/** The switch labelled `label` is on when window.__qcWant is 'on'. */
function switchIsWant(label: string) {
  const w = (window as unknown as { __qcWant?: string }).__qcWant
  const s = [...document.querySelectorAll('label')]
    .find((l) => l.textContent === label)
    ?.querySelector<HTMLInputElement>('input[role="switch"]')
  return s != null && s.checked === (w === 'on')
}

// ── specs ──────────────────────────────────────────────────────────────────

test.describe(
  'fields tab',
  { annotation: [SETTINGS_ROUTE, FIELDS_ROUTE] },
  () => {
    test('create, add options, archive and reactivate', async ({
      page,
      flow,
      users,
      world,
    }) => {
      await page.goto(fieldsPath(users.a.slug))
      await expect(
        page
          .getByRole('navigation', { name: 'Settings sections' })
          .getByRole('link', { name: 'Fields' }),
      ).toHaveAttribute('aria-current', 'page')
      // Seeded, with its options in order.
      await expect(
        fieldCard(page, world.field.label)
          .getByRole('list', { name: `Options of ${world.field.label}` })
          .getByRole('listitem'),
      ).toHaveText(world.field.options.map((o) => new RegExp(`^${o}`)))
      // The tab opens with its own admin switch, and no other.
      await expect(
        page.getByRole('switch', { name: 'Staff can manage fields' }),
      ).toHaveCount(1)
      await expect(page.getByRole('switch')).toHaveCount(1)
      const label = page.getByLabel('New field')
      const add = page.getByRole('button', { name: 'Add field' })
      await expect(add).toBeDisabled()

      // Each sample makes a field and the next one deletes it again, so the
      // samples take one slot between them.
      const base = uniqueName('field')
      let n = 0
      let last: string | undefined
      try {
        await flow(page, 'fields.create', {
          before: async () => {
            if (last) await dropField(page, users.a.slug, last)
            last = `${base}-${++n}`
            await label.fill(last)
            await want(page, last)
          },
          action: () => add.click(),
          until: fieldListed,
        })
        await expect(label).toHaveValue('')
        const current = last!

        // Labels are unique among the live fields, case-insensitively.
        await label.fill(`  ${world.field.label.toUpperCase()} `)
        await add.click()
        await expect(page.getByRole('alert')).toContainText(
          `${world.field.label} already exists`,
        )
        await label.fill('')

        const card = fieldCard(page, current)
        const option = card.getByLabel(`New option for ${current}`)
        let o = 0
        await flow(page, 'fields.option.add', {
          before: async () => {
            const next = `option ${++o}`
            await option.fill(next)
            await want(page, next)
          },
          action: () =>
            card.getByRole('button', { name: 'Add option' }).click(),
          until: optionListed,
          arg: current,
        })
        await expect(option).toHaveValue('')

        // Archived fields hide unless shown; show them, so the card stays.
        await page.getByLabel(/^Show archived/).check()
        const toggle = () =>
          fieldHead(page, current).getByRole('button', {
            name: /^(archive|reactivate)$/,
          })
        const confirm = page
          .getByRole('alertdialog')
          .getByRole('button', { name: 'Archive' })
        let archiving = false
        await flow(page, 'fields.archive', {
          before: async () => {
            archiving = (await toggle().textContent()) === 'archive'
            // Archiving asks first: the timed click is the confirm.
            if (archiving) await toggle().click()
            await want(page, archiving ? 'reactivate' : 'archive')
          },
          action: () => (archiving ? confirm.click() : toggle().click()),
          until: fieldButtonIsWant,
          arg: current,
        })

        // Archived: marked, and hidden once archived ones aren't shown.
        if ((await toggle().textContent()) === 'archive') {
          await toggle().click()
          await confirm.click()
        }
        await expect(card.getByText('archived', { exact: true })).toBeVisible()
        await page.getByLabel(/^Show archived/).uncheck()
        await expect(card).toHaveCount(0)
        await page.getByLabel(/^Show archived/).check()
        await toggle().click()
        await expect(toggle()).toHaveText('archive')
        await page.getByLabel(/^Show archived/).uncheck()
        await expect(card).toBeVisible()
      } finally {
        if (last) await dropField(page, users.a.slug, last)
      }
    })

    test('the staff switch opens fields to staff, live', async ({
      page,
      browser,
      baseURL,
      flow,
      session,
      users,
      world,
    }) => {
      const label = 'Staff can manage fields'
      await page.goto(fieldsPath(users.a.slug))
      const sw = page.getByRole('switch', { name: label })
      // The tenant is shared by the worker's tests: it starts, and is left, off.
      await expect(sw).not.toBeChecked()
      // The input is visually hidden; its label takes the (trusted) click.
      const toggle = page.getByText(label, { exact: true })
      const staff = await secondTab(
        browser,
        baseURL!,
        await session(users.staff),
      )
      try {
        await staff.goto(fieldsPath(users.staff.slug))
        await expect(fieldCard(staff, world.field.label)).toBeVisible()
        // Read-only: no new field, no buttons on a card, no switch.
        await expect(staff.getByLabel('New field')).toHaveCount(0)
        await expect(
          fieldCard(staff, world.field.label).getByRole('button'),
        ).toHaveCount(0)
        await expect(staff.getByRole('switch')).toHaveCount(0)

        await flow(page, 'settings.staffFields.toggle', {
          before: async () => want(page, (await sw.isChecked()) ? 'off' : 'on'),
          action: () => toggle.click(),
          until: switchIsWant,
          arg: label,
        })
        if (!(await sw.isChecked())) await toggle.click()
        await expect(sw).toBeChecked()
        // Staff's open page follows: fields become theirs to manage.
        await expect(staff.getByLabel('New field')).toBeVisible()
        await expect(
          fieldCard(staff, world.field.label).getByRole('button', {
            name: 'edit',
          }),
        ).toBeVisible()

        // Off again: the open page goes read-only.
        await toggle.click()
        await expect(sw).not.toBeChecked()
        await expect(staff.getByLabel('New field')).toHaveCount(0)
      } finally {
        if (await sw.isChecked()) {
          await toggle.click()
          await expect(sw).not.toBeChecked()
        }
        await staff.context().close()
      }
    })

    test('a viewer sees the fields, read-only', async ({
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
      await viewer.goto(fieldsPath(users.viewer.slug))
      await expect(fieldCard(viewer, world.field.label)).toBeVisible()
      await expect(viewer.getByLabel('New field')).toHaveCount(0)
      await expect(
        viewer.locator('main [data-testid="field"] button'),
      ).toHaveCount(0)
      await expect(viewer.getByRole('switch')).toHaveCount(0)
      await viewer.context().close()
    })
  },
)

test.describe('a field on a contact', { annotation: CONTACT_ROUTE }, () => {
  test('set and clear a value', async ({ page, flow, users, world }) => {
    const { label, options } = world.field
    await createContact(page, users.a.slug, uniqueName('valued'))
    const select = valueSelect(page, label)
    await expect(select).toHaveValue('')
    // Its options in the admin's order, after "not set".
    await expect(select.locator('option')).toHaveText(['not set', ...options])

    /** Choose `option` (or '' for not set), untimed, and wait for the save. */
    const choose = async (option: string) => {
      await (option
        ? select.selectOption({ label: option })
        : select.selectOption(''))
      await expect(saved(page)).toBeVisible()
    }

    await flow(page, 'contact.field.set', {
      before: async () => {
        if ((await select.inputValue()) !== '') await choose('')
        await want(page, options[0])
        await select.focus()
      },
      // A trusted keypress (selectOption's events are synthetic, so they
      // start no timer): from "not set" to the first option.
      action: () => select.press('ArrowDown'),
      until: valueSaved,
      arg: label,
    })

    await flow(page, 'contact.field.clear', {
      before: async () => {
        if ((await select.inputValue()) === '') await choose(options[0])
        await want(page, 'not set')
        await select.focus()
      },
      action: () => select.press('ArrowUp'),
      until: valueSaved,
      arg: label,
    })

    // Saved, not just shown.
    await choose(options[1])
    await page.reload()
    await expect(valueSelect(page, label).locator('option:checked')).toHaveText(
      options[1],
    )
  })
})

test.describe('fields on the contacts list', { annotation: LIST_ROUTE }, () => {
  test(
    'filter the list by a field',
    { annotation: [LIST_ROUTE, CONTACT_ROUTE, FIELDS_ROUTE] },
    async ({ page, flow, users }) => {
      const label = uniqueName('filter')
      const last = uniqueName('filtered')
      await createField(page, users.a.slug, label, ['One', 'Two'])
      try {
        await createContact(page, users.a.slug, last)
        await valueSelect(page, label).selectOption({ label: 'One' })
        await expect(saved(page)).toBeVisible()
        await page.getByRole('link', { name: 'Contacts', exact: true }).click()
        const filter = page.getByLabel(`Filter by ${label}`)
        const links = page.locator('main ul li a')
        await want(page, last)

        // From "not set", just above One, so a trusted ArrowDown
        // (selectOption's events are synthetic and start no timer) lands
        // on it.
        await expect(filter.locator('option')).toHaveText([
          `any ${label}`,
          `${label} not set`,
          'One',
          'Two',
        ])
        // Each sample starts on a freshly loaded list: the list keeps the
        // rows it last showed for a filter while it stays mounted
        // (src/lib/paged-list.ts), so going back to One would draw from
        // memory with nothing from the server.
        await flow(page, 'fields.filter', {
          before: async () => {
            await page.goto(`/t/${users.a.slug}/contacts`)
            await want(page, last)
            await filter.selectOption({ label: `${label} not set` })
            await expect(page.getByText('Loading…')).toBeHidden()
            await expect(links.filter({ hasText: last })).toBeHidden()
            await filter.focus()
          },
          action: () => filter.press('ArrowDown'),
          until: onlyRowIsWant,
          server: true,
        })
        // The row shows its value as a labelled chip.
        await expect(links.first()).toContainText(`${label}: One`)

        // With search text too, and an option nobody holds.
        await page.getByLabel('Search contacts').fill(last)
        await expect(links).toHaveCount(1)
        await filter.selectOption({ label: 'Two' })
        await expect(page.getByText('No contacts match.')).toBeVisible()
        await page.getByLabel('Search contacts').fill('')
        await expect(
          page.getByText('No contacts with these field values.'),
        ).toBeVisible()
      } finally {
        await dropField(page, users.a.slug, label)
      }
    },
  )

  test(
    'select rows, then set and clear a field in bulk',
    { annotation: [LIST_ROUTE, FIELDS_ROUTE] },
    async ({ page, flow, users }) => {
      const label = uniqueName('bulk')
      // People only: the seeded Trust is skipped, and counted.
      await createField(page, users.a.slug, label, ['On'], {
        individualsOnly: true,
      })
      try {
        await page.goto(`/t/${users.a.slug}/contacts`)
        const links = page.locator('main ul li a')
        await expect(links.nth(1)).toBeVisible()

        // Every contact in the worker's tenant, up to the list's 100.
        await page.getByLabel(/^select all \d+ shown/).check()
        const shown = await links.count()
        await expect(page.getByText(`${shown} selected`)).toBeVisible()
        await page.getByLabel('Field to set').selectOption({ label })
        const value = page.getByLabel(`Value for ${label}`)

        let setting = false
        await flow(page, 'contacts.bulkSetField', {
          before: async () => {
            setting = !setting
            await value.selectOption(
              setting ? { label: 'On' } : { label: 'clear (not set)' },
            )
            await want(
              page,
              setting ? `Set “${label}” to “On” on` : `Cleared “${label}” on`,
            )
          },
          action: () => page.getByRole('button', { name: 'Set field' }).click(),
          until: statusIsWant,
        })

        // Leave it set; then the filter shows exactly the people chosen.
        const status = page.getByRole('status').filter({ hasText: label })
        if ((await status.textContent())?.startsWith('Cleared')) {
          await value.selectOption({ label: 'On' })
          await page.getByRole('button', { name: 'Set field' }).click()
        }
        await expect(status).toContainText(
          /on \d+ contacts?; skipped \d+ of a kind it doesn’t apply to/,
        )
        const [, changed, skipped] = (await status.textContent())!.match(
          /on (\d+) contacts?; skipped (\d+)/,
        )!
        expect(Number(changed) + Number(skipped)).toBe(shown)
        await page
          .getByLabel(`Filter by ${label}`)
          .selectOption({ label: 'On' })
        await expect(links).toHaveCount(Number(changed))

        // Setting again changes nothing: one revision per contact that changes.
        await page.getByLabel(/^select all \d+ shown/).check()
        await page.getByLabel('Field to set').selectOption({ label })
        await page
          .getByLabel(`Value for ${label}`)
          .selectOption({ label: 'On' })
        await page.getByRole('button', { name: 'Set field' }).click()
        await expect(status).toHaveText(
          new RegExp(`^Set “${label}” to “On” on 0 contacts`),
        )
      } finally {
        await dropField(page, users.a.slug, label)
      }
    },
  )
})
