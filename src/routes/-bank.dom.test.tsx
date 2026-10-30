// @vitest-environment happy-dom
import { act } from 'react'
import type { ComponentType, ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type {
  BankAccountRow,
  BankImportedOutcome,
  BankPresets,
  BankPreviewOutcome,
} from '../lib/data'
import { RustApiError } from '../lib/data/rust/client'

// Bank transfers 6a's pages: Settings › Bank accounts (admins), the
// statements list, importing a statement (the account's layout, a preset
// or mapped columns; a preview first; only what the server committed
// shown; row errors by line) and an import's lines.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let role: 'admin' | 'staff' | 'viewer' = 'staff'
let accounts: Array<BankAccountRow> = []
// What a refetch of the accounts answers (another admin's save).
let accountsAfterRefetch: Array<BankAccountRow> | undefined
let importsRead: {
  data?: Array<unknown>
  error?: unknown
  refetch: () => Promise<unknown>
} = { data: [], refetch: () => Promise.resolve() }
const create = vi.fn()
const save = vi.fn()
const preview = vi.fn()
const importStatement = vi.fn()
const peek = vi.fn()
const PRESETS: BankPresets = {
  presets: [
    {
      id: 'lloyds',
      bank: 'Lloyds',
      export: 'CSV',
      verified: false,
      source: 'write-up',
      mapping: {
        header: { kind: 'find' },
        date: { name: 'Transaction Date' },
        amount: {
          kind: 'paidInOut',
          paidIn: { name: 'Credit Amount' },
          paidOut: { name: 'Debit Amount' },
        },
        narrative: [],
      },
    },
  ],
  awaitingSamples: ['CAF Bank'],
}
vi.mock('../lib/data', () => ({
  useBankAccounts: () => ({
    data: accounts,
    error: null,
    refetch: () => Promise.resolve({ data: accountsAfterRefetch ?? accounts }),
  }),
  useBankPresets: () => ({ data: PRESETS }),
  useBankImports: () => importsRead,
  useCreateBankAccount: () => create,
  useSaveBankAccount: () => save,
  usePreviewImport: () => preview,
  useImportStatement: () => importStatement,
  usePeekStatement: () => peek,
  kindOfFile: (name: string) =>
    name.endsWith('.ofx') ? 'ofx' : name.endsWith('.qif') ? 'qif' : 'csv',
  useAuthState: () => ({ method: 'password' }),
}))
vi.mock('../lib/tenant', () => ({
  useTenant: () => ({ _id: 'tenantA', slug: 'alpha', role }),
  useIsAdmin: () => role === 'admin',
  useCanWrite: () => role !== 'viewer',
}))
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: object) => ({
    options,
    useParams: () => ({ slug: 'alpha' }),
    useSearch: () => ({}),
  }),
  Link: ({
    to,
    params,
    children,
  }: {
    to: string
    params: Record<string, string>
    children: ReactNode
  }) => (
    <a href={to.replace(/\$(\w+)/g, (_, k: string) => params[k])}>{children}</a>
  ),
}))
vi.mock('../components/source-code-picker', () => ({
  SourceCodePicker: ({
    value,
    onPick,
  }: {
    value: { code: string } | null
    onPick: (e: { versionId: string; code: string }) => void
  }) => (
    <button
      type="button"
      onClick={() => onPick({ versionId: 'v1', code: 'UNSOLICITED-001' })}
    >
      {value ? value.code : 'Pick a code'}
    </button>
  ),
}))

const account = (over: Partial<BankAccountRow> = {}): BankAccountRow => ({
  id: 'acc1',
  version: 0,
  name: 'Lloyds current',
  sortCode: '300000',
  accountLast4: '5678',
  active: true,
  createdBy: 1,
  createdAt: 0,
  ...over,
})

const outcome = (
  over: Partial<BankPreviewOutcome> = {},
): BankPreviewOutcome => ({
  newLines: 4,
  duplicateLines: 12,
  debitsDropped: 1,
  firstDate: '2026-11-02',
  lastDate: '2026-11-04',
  undated: [],
  undatedCount: 0,
  lines: [
    {
      id: undefined,
      postedOn: '2026-11-02',
      amount: 2500n,
      payer: 'J SMITH',
      reference: '100016',
      narrative: 'J SMITH 100016',
      dedupeKey: 'k',
      occurrence: 1,
    },
  ],
  ...over,
})

let root: Root
let el: HTMLDivElement
beforeEach(() => {
  for (const f of [create, save, preview, importStatement, peek]) f.mockReset()
  role = 'staff'
  accounts = [account({ csvLayout: { kind: 'preset', id: 'lloyds' } })]
  accountsAfterRefetch = undefined
  importsRead = { data: [], refetch: () => Promise.resolve() }
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
  document.body.innerHTML = ''
})

async function page(module: Promise<{ Route: unknown }>) {
  const { Route } = await module
  const Page = (Route as { options: { component: ComponentType } }).options
    .component
  await act(async () => root.render(<Page />))
}
const importPage = () => page(import('./t.$slug.bank.import'))
const button = (name: string | RegExp) =>
  [...el.querySelectorAll('button')].find((b) =>
    typeof name === 'string'
      ? b.textContent === name
      : name.test(b.textContent),
  )
const click = (b: HTMLElement | undefined) =>
  act(async () => {
    if (!b) throw new Error('no such button')
    b.click()
  })
const byTestId = (id: string) =>
  el.querySelector(`[data-testid="${id}"]`)?.textContent

async function chooseFile(name: string) {
  const input = el.querySelector<HTMLInputElement>('input[type="file"]')!
  const file = new File(['x'], name, { type: 'text/csv' })
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  return file
}

test('viewers never see statements; only admins set accounts up', async () => {
  role = 'viewer'
  await page(import('./t.$slug.bank.index'))
  expect(el.textContent).toBe('Bank statements are for staff and admins.')
  act(() => root.unmount())
  root = createRoot(el)
  await importPage()
  expect(el.textContent).toBe('Bank statements are for staff and admins.')
  act(() => root.unmount())
  root = createRoot(el)
  role = 'staff'
  await page(import('./t.$slug.settings.bank'))
  expect(el.textContent).toBe(
    'The group’s bank accounts are set up by its admins.',
  )
})

test('a saved layout: preview, then import shows only what was committed', async () => {
  preview.mockResolvedValue(outcome())
  let commit!: (o: BankImportedOutcome) => void
  importStatement.mockReturnValue(
    new Promise<BankImportedOutcome>((r) => (commit = r)),
  )
  await importPage()
  const file = await chooseFile('statement.csv')
  await click(button('Next'))
  expect(preview).toHaveBeenCalledWith('acc1', file, null)
  expect(byTestId('bank-summary')).toBe('4 new, 12 already imported')
  expect(el.textContent).toContain('1 payments out would be skipped')
  expect(el.textContent).toContain('£25.00')
  await click(button('Import 4 new lines'))
  expect(importStatement).toHaveBeenCalledWith('acc1', file, null, false)
  // In flight: the button is disabled and nothing claims success yet.
  expect(button('Importing…')?.disabled).toBe(true)
  expect(el.textContent).not.toContain('Imported')
  await act(async () =>
    commit({ ...outcome({ newLines: 3, duplicateLines: 13 }), id: 'imp1' }),
  )
  expect(el.querySelector('h2')?.textContent).toBe('Imported')
  // Focus moved to the step's heading.
  expect(document.activeElement?.textContent).toBe('Imported')
  expect(byTestId('bank-summary')).toBe('3 new, 13 already imported')
  expect(
    el.querySelector('a[href="/t/alpha/bank/imports/imp1"]'),
  ).not.toBeNull()
})

test('no layout yet: a preset, kept on the account with the import', async () => {
  accounts = [account()]
  preview.mockResolvedValue(outcome())
  importStatement.mockResolvedValue({ ...outcome(), id: 'imp1' })
  await importPage()
  const file = await chooseFile('statement.csv')
  await click(button('Next'))
  expect(preview).not.toHaveBeenCalled()
  expect(el.textContent).toContain('Lloyds: CSV (unverified)')
  await click(button('Preview with it'))
  const layout = { kind: 'preset', id: 'lloyds' }
  expect(preview).toHaveBeenCalledWith('acc1', file, layout)
  const keep = [...el.querySelectorAll('label')].find((l) =>
    l.textContent.startsWith('Keep this layout'),
  )
  expect(keep?.querySelector('input')?.checked).toBe(true)
  await click(button('Import 4 new lines'))
  expect(importStatement).toHaveBeenCalledWith('acc1', file, layout, true)
})

test('staff can’t replace a saved layout; OFX needs none', async () => {
  preview.mockResolvedValue(outcome())
  await importPage()
  const file = await chooseFile('statement.ofx')
  await click(button('Next'))
  expect(preview).toHaveBeenCalledWith('acc1', file, { kind: 'ofx' })
  expect(el.textContent).not.toContain('Keep this layout')
  expect(button('Read it another way')).toBeUndefined()
})

test('a file that can’t be read lists its rows by line and imports nothing', async () => {
  preview.mockRejectedValue(
    new RustApiError(422, {
      kind: 'file_rows',
      rows: [
        { line: 5, message: 'Not a date: "31/02/2026"' },
        { line: 0, message: '…and 3 more rows' },
      ],
    }),
  )
  await importPage()
  await chooseFile('statement.csv')
  await click(button('Next'))
  expect(byTestId('bank-row-errors')).toBe(
    'Line 5: Not a date: "31/02/2026"…and 3 more rows',
  )
  expect(el.querySelector('[role="alert"]')?.textContent).toContain(
    'nothing was imported',
  )
  expect(importStatement).not.toHaveBeenCalled()
})

test('rows with money in but no date are a warning', async () => {
  preview.mockResolvedValue(
    outcome({
      undated: [
        { line: 14, amount: 5000n },
        { line: 30, amount: 1500n },
      ],
      undatedCount: 2,
    }),
  )
  await importPage()
  await chooseFile('statement.csv')
  await click(button('Next'))
  expect(byTestId('bank-undated')).toContain(
    '2 rows with an amount but no date were skipped: line 14 (£50.00), 30 (£15.00)',
  )
})

test('mapping columns by hand from the file’s first rows', async () => {
  accounts = [account()]
  peek.mockResolvedValue([
    { line: 1, cells: ['Date', 'Who', 'In', 'Out'] },
    { line: 2, cells: ['02/11/2026', 'J SMITH', '25.00', ''] },
  ])
  preview.mockResolvedValue(outcome())
  await importPage()
  const file = await chooseFile('statement.csv')
  await click(button('Next'))
  await click(button('Map the columns by hand'))
  expect(peek).toHaveBeenCalledWith(file)
  expect(button('Preview with these columns')?.disabled).toBe(true)
  const select = (label: string, value: string) =>
    act(async () => {
      const l = [...el.querySelectorAll('label')].find(
        (x) => x.querySelector('select') && x.textContent.startsWith(label),
      )!
      const s = l.querySelector('select')!
      s.value = value
      s.dispatchEvent(new Event('change', { bubbles: true }))
    })
  await select('Date', '0')
  await act(async () => {
    const radio = [...el.querySelectorAll('label')]
      .find((l) => l.textContent === 'Money in and money out columns')!
      .querySelector('input')!
    radio.click()
  })
  await select('Money in', '2')
  await select('Money out', '3')
  await click(button('Preview with these columns'))
  expect(preview).toHaveBeenCalledWith('acc1', file, {
    kind: 'mapping',
    mapping: {
      header: { kind: 'find' },
      date: { name: 'Date' },
      amount: {
        kind: 'paidInOut',
        paidIn: { name: 'In' },
        paidOut: { name: 'Out' },
      },
      narrative: [],
    },
  })
})

test('settings: an admin adds an account, and a stale save says so', async () => {
  role = 'admin'
  accounts = [account({ version: 3 })]
  create.mockResolvedValue(account({ id: 'acc2' }))
  save.mockRejectedValue(
    new RustApiError(409, {
      kind: 'stale',
      contract: 'banking.account',
      counter: 4,
      current: {},
    }),
  )
  await page(import('./t.$slug.settings.bank'))
  expect(el.textContent).toContain('Sort code 30-00-00, ending 5678')
  expect(el.textContent).toContain('Statement layout: Not set')
  await click(button('Add a bank account'))
  const form = el.querySelector('form[aria-label="New bank account"]')!
  const name = form.querySelector('input')!
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!
    set.call(name, 'CAF current')
    name.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await click(button('Pick a code'))
  await click(button('Add account'))
  expect(create).toHaveBeenCalledWith({
    name: 'CAF current',
    sortCode: '',
    accountLast4: '',
    defaultSourceCodeId: 'v1',
    csvLayout: undefined,
    active: true,
  })
  await click(button(/^Edit/))
  // Admin B archived it meanwhile; this admin renames it.
  accountsAfterRefetch = [
    account({ version: 4, name: 'Lloyds current', active: false }),
  ]
  const edit = el.querySelector('form[aria-label="Edit Lloyds current"]')!
  await act(async () => {
    const input = edit.querySelector('input')!
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, 'Lloyds main')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await click(button('Save'))
  expect(save).toHaveBeenCalledWith(
    'acc1',
    3,
    expect.objectContaining({ name: 'Lloyds main' }),
  )
  expect(el.querySelector('[role="alert"]')?.textContent).toContain(
    'The form now shows their version: make your change again',
  )
  // Their version is in the form: archived, the old name. Nothing of
  // ours survives to overwrite it unseen.
  expect(edit.querySelector('input')?.value).toBe('Lloyds current')
  const archived = [...edit.querySelectorAll('label')]
    .find((l) => l.textContent.startsWith('Archived'))!
    .querySelector('input')!
  expect(archived.checked).toBe(true)
  save.mockResolvedValue({ id: 'acc1', counter: 5 })
  await click(button('Save'))
  expect(save).toHaveBeenLastCalledWith(
    'acc1',
    4,
    expect.objectContaining({ name: 'Lloyds current', active: false }),
  )
})

test('settings: a refused field is marked and described beside it', async () => {
  role = 'admin'
  save.mockRejectedValue(
    new RustApiError(422, {
      kind: 'invalid',
      problems: [{ field: 'sortCode', message: '6 digits, or leave it empty' }],
    }),
  )
  await page(import('./t.$slug.settings.bank'))
  await click(button(/^Edit/))
  await click(button('Save'))
  const input = [...el.querySelectorAll('label')]
    .find((l) => l.textContent.startsWith('Sort code'))!
    .querySelector('input')!
  expect(input.getAttribute('aria-invalid')).toBe('true')
  const described = document.getElementById(
    input.getAttribute('aria-describedby')!,
  )
  expect(described?.textContent).toBe('6 digits, or leave it empty')
})

test('no header row: the data starts on line 1, by position', async () => {
  accounts = [account()]
  peek.mockResolvedValue([
    { line: 1, cells: ['02/11/2026', 'J SMITH', '25.00'] },
    { line: 2, cells: ['03/11/2026', 'A JONES', '10.00'] },
  ])
  preview.mockResolvedValue(outcome())
  await importPage()
  const file = await chooseFile('statement.csv')
  await click(button('Next'))
  await click(button('Map the columns by hand'))
  expect(document.activeElement?.textContent).toBe('Match the columns')
  const select = (label: string, value: string) =>
    act(async () => {
      const l = [...el.querySelectorAll('label')].find(
        (x) => x.querySelector('select') && x.textContent.startsWith(label),
      )!
      const s = l.querySelector('select')!
      s.value = value
      s.dispatchEvent(new Event('change', { bubbles: true }))
    })
  await select('Which line', 'none')
  await select('Date', '0')
  await select('Amount column', '2')
  await click(button('Preview with these columns'))
  expect(preview).toHaveBeenCalledWith('acc1', file, {
    kind: 'mapping',
    mapping: {
      header: { kind: 'skip', rows: 0 },
      date: { index: 0 },
      amount: { kind: 'signed', column: { index: 2 } },
      narrative: [],
    },
  })
})

test('an admin reading a file another way keeps the saved layout by default', async () => {
  role = 'admin'
  preview.mockResolvedValue(outcome())
  importStatement.mockResolvedValue({ ...outcome(), id: 'imp1' })
  await importPage()
  const file = await chooseFile('statement.csv')
  await click(button('Next'))
  await click(button('Read it another way'))
  // The first preset is ready to use at once.
  expect(button('Preview with it')?.disabled).toBe(false)
  await click(button('Preview with it'))
  const keep = [...el.querySelectorAll('label')]
    .find((l) => l.textContent.startsWith('Keep this layout'))!
    .querySelector('input')!
  expect(keep.checked).toBe(false)
  await click(button('Import 4 new lines'))
  expect(importStatement).toHaveBeenCalledWith(
    'acc1',
    file,
    { kind: 'preset', id: 'lloyds' },
    false,
  )
})

test('an account’s imports that fail to load say so, with a retry', async () => {
  const refetch = vi.fn(() => Promise.resolve())
  importsRead = { error: new Error('down'), refetch }
  await page(import('./t.$slug.bank.index'))
  expect(el.querySelector('[role="alert"]')?.textContent).toContain(
    'The imports couldn’t load.',
  )
  await click(button('Try again'))
  expect(refetch).toHaveBeenCalled()
})
