import { Link, createFileRoute } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import {
  kindOfFile,
  useBankAccounts,
  useBankPresets,
  useImportStatement,
  usePeekStatement,
  usePreviewImport,
} from '../lib/data'
import type {
  BankAccountRow,
  BankFileLayout,
  BankImportedOutcome,
  BankPeekRow,
  BankPreset,
  BankPreviewOutcome,
  BankRowError,
  BankUndated,
} from '../lib/data'
import { RustApiError, describe } from '../lib/data/rust/client'
import {
  columnLabel,
  emptyPicks,
  mappingOf,
  missing,
} from '../lib/domain/bank-mapping'
import type { MappingPicks } from '../lib/domain/bank-mapping'
import { formatDay, formatPence } from '../lib/gifts'
import { useCanWrite, useIsAdmin } from '../lib/tenant'
import { LinesTable, layoutLabel, presetName } from '../components/bank'

export const Route = createFileRoute('/t/$slug/bank/import')({
  component: ImportPage,
  validateSearch: (s: Record<string, unknown>): { account?: string } =>
    typeof s.account === 'string' ? { account: s.account } : {},
})

/** The rows `bank/peek` shows (`banking::csv::PEEK_ROWS`). */
const PEEK_ROWS = 30

const field = 'rounded border border-neutral-300 px-2 py-1 text-sm'
const button =
  'self-start rounded bg-neutral-900 px-3 py-1 text-sm text-white hover:bg-neutral-700 disabled:opacity-50'
const quiet =
  'self-start rounded border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-50 disabled:opacity-50'

/** Where the import has got to. */
type Step =
  | { kind: 'choose' }
  /** A CSV with no layout yet (or staff asked for another). */
  | { kind: 'layout' }
  | { kind: 'map'; rows: Array<BankPeekRow> }
  | {
      kind: 'preview'
      layout: BankFileLayout | null
      preview: BankPreviewOutcome
    }
  | { kind: 'done'; outcome: BankImportedOutcome }

/**
 * Import a statement (bank transfers 6a): choose the account and the
 * file; a CSV is read with the account's layout, or a bank's preset, or
 * columns mapped by hand over its first rows (then kept on the account).
 * Every import is previewed first: what it would add, written nowhere.
 * Importing shows only what the server committed, "41 new, 12 already
 * imported"; a file with a bad row imports nothing and lists the rows by
 * line. Staff and admins (viewers never see statement lines).
 */
function ImportPage() {
  const { slug } = Route.useParams()
  const search = Route.useSearch()
  const canWrite = useCanWrite()
  const accounts = useBankAccounts(canWrite)
  if (!canWrite)
    return (
      <main className="mx-auto max-w-4xl p-6 text-sm text-neutral-600">
        Bank statements are for staff and admins.
      </main>
    )
  const active = accounts.data?.filter((a) => a.active)
  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-4 p-4 sm:p-6">
      <div>
        <Link
          to="/t/$slug/bank"
          params={{ slug }}
          className="text-sm text-neutral-600 underline"
        >
          Bank statements
        </Link>
        <h1 className="text-xl font-semibold">Import a statement</h1>
      </div>
      {accounts.error ? (
        <p role="alert" className="text-sm text-red-700">
          The bank accounts couldn’t load.
        </p>
      ) : active === undefined ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : active.length === 0 ? (
        <p className="text-sm text-neutral-600">
          No bank account to import into yet: an admin adds one in Settings ›
          Bank accounts.
        </p>
      ) : (
        <ImportFlow
          accounts={active}
          initialAccount={
            active.find((a) => a.id === search.account)?.id ?? active[0].id
          }
        />
      )}
    </main>
  )
}

function ImportFlow({
  accounts,
  initialAccount,
}: {
  accounts: Array<BankAccountRow>
  initialAccount: string
}) {
  const { slug } = Route.useParams()
  const admin = useIsAdmin()
  const presets = useBankPresets()
  const peek = usePeekStatement()
  const previewImport = usePreviewImport()
  const importStatement = useImportStatement()
  const [accountId, setAccountId] = useState(initialAccount)
  const [file, setFile] = useState<File | null>(null)
  const [step, setStepState] = useState<Step>({ kind: 'choose' })
  // Past the first step: each new step's heading takes focus.
  const [moved, setMoved] = useState(false)
  const setStep = (to: Step) => {
    setMoved(true)
    setStepState(to)
  }
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rows, setRows] = useState<Array<BankRowError> | null>(null)
  // Keeping the layout: by default only when the account has none, so an
  // admin reading one file another way doesn't replace a working one.
  const [keep, setKeep] = useState(true)
  const account = accounts.find((a) => a.id === accountId) ?? accounts[0]
  const presetList = presets.data?.presets ?? []

  /** Run a request; a refusal shows its rows or its sentence. */
  async function attempt(f: () => Promise<void>) {
    setBusy(true)
    setError(null)
    setRows(null)
    try {
      await f()
    } catch (err) {
      if (err instanceof RustApiError && err.error.kind === 'file_rows') {
        setRows(err.error.rows)
        setError('The file can’t be read this way, so nothing was imported:')
      } else if (err instanceof RustApiError) setError(describe(err.error))
      else setError('Something went wrong: try again')
    } finally {
      setBusy(false)
    }
  }

  const preview = (layout: BankFileLayout | null) =>
    attempt(async () => {
      if (!file) return
      const p = await previewImport(account.id, file, layout)
      setKeep(!account.csvLayout)
      setStep({ kind: 'preview', layout, preview: p })
    })

  function next(e: FormEvent) {
    e.preventDefault()
    if (!file) return
    const kind = kindOfFile(file.name)
    if (kind !== 'csv') void preview({ kind })
    else if (account.csvLayout) void preview(null)
    else setStep({ kind: 'layout' })
  }

  const reset = () => {
    setStep({ kind: 'choose' })
    setFile(null)
    setError(null)
    setRows(null)
  }

  const notice = (error || rows) && (
    <div role="alert" className="flex flex-col gap-1 text-sm text-red-700">
      {error && <p>{error}</p>}
      {rows && (
        <ul className="list-disc pl-5" data-testid="bank-row-errors">
          {rows.map((r, i) => (
            <li key={`${r.line}:${i}`}>
              {r.line === 0 ? r.message : `Line ${r.line}: ${r.message}`}
            </li>
          ))}
        </ul>
      )}
    </div>
  )

  if (step.kind === 'done')
    return (
      <Done outcome={step.outcome} slug={slug} again={reset} focus={moved} />
    )

  if (step.kind === 'choose')
    return (
      <form
        aria-label="Choose a statement"
        onSubmit={next}
        className="flex flex-col gap-4"
      >
        <StepHeading focus={moved}>Choose the statement</StepHeading>
        <label className="flex flex-col gap-1 text-sm">
          Bank account
          <select
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            className={`${field} w-72 max-w-full`}
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <span className="text-xs text-neutral-500">
            CSV layout: {layoutLabel(account.csvLayout, presetList)}
          </span>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Statement file (CSV, OFX or QIF, up to 5 MB)
          <input
            type="file"
            accept=".csv,.txt,.ofx,.qfx,.qif,text/csv"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="text-sm"
          />
        </label>
        {notice}
        <button type="submit" disabled={busy || !file} className={button}>
          {busy ? 'Reading…' : 'Next'}
        </button>
      </form>
    )

  if (step.kind === 'layout')
    return (
      <LayoutChoice
        presets={presetList}
        hasLayout={account.csvLayout !== undefined}
        focus={moved}
        busy={busy}
        notice={notice}
        onPreset={(id) => void preview({ kind: 'preset', id })}
        onMap={() =>
          void attempt(async () => {
            if (!file) return
            setStep({ kind: 'map', rows: await peek(file) })
          })
        }
        onBack={reset}
      />
    )

  if (step.kind === 'map')
    return (
      <MapColumns
        rows={step.rows}
        focus={moved}
        busy={busy}
        notice={notice}
        onCheck={(mapping) => void preview({ kind: 'mapping', mapping })}
        onBack={() => setStep({ kind: 'layout' })}
      />
    )

  // Preview: what it would add. A CSV layout chosen here can be kept on
  // the account: by staff only while it has none, by an admin always.
  const p = step.preview
  const csvLayout =
    step.layout?.kind === 'preset' || step.layout?.kind === 'mapping'
  const mayKeep = csvLayout && (admin || !account.csvLayout)
  return (
    <section aria-label="Preview" className="flex flex-col gap-4">
      <StepHeading focus={moved}>Check before importing</StepHeading>
      <p className="text-sm">
        <span className="font-medium">{file?.name}</span> into{' '}
        <span className="font-medium">{account.name}</span>
      </p>
      <Summary outcome={p} verb="would be" />
      {p.lines.length > 0 && (
        <LinesTable lines={p.lines} caption="First new lines" />
      )}
      {mayKeep && (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={keep}
            onChange={(e) => setKeep(e.target.checked)}
          />
          Keep this layout for {account.name}
        </label>
      )}
      {notice}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={button}
          disabled={busy || p.newLines === 0}
          onClick={() =>
            void attempt(async () => {
              if (!file) return
              const outcome = await importStatement(
                account.id,
                file,
                step.layout,
                Boolean(mayKeep && keep),
              )
              setStep({ kind: 'done', outcome })
            })
          }
        >
          {busy
            ? 'Importing…'
            : p.newLines === 0
              ? 'Nothing new to import'
              : `Import ${p.newLines} new ${p.newLines === 1 ? 'line' : 'lines'}`}
        </button>
        {kindOfFile(file?.name ?? '') === 'csv' && (
          <button
            type="button"
            className={quiet}
            disabled={busy}
            onClick={() => setStep({ kind: 'layout' })}
          >
            Read it another way
          </button>
        )}
        <button type="button" className={quiet} disabled={busy} onClick={reset}>
          Start again
        </button>
      </div>
    </section>
  )
}

/**
 * Each step's heading. Moving to a step replaces the form, so focus goes
 * here (not to the page's body), and a screen reader says which step it
 * is; not on the page's first render, where focus stays put.
 */
function StepHeading({
  children,
  focus,
}: {
  children: string
  focus: boolean
}) {
  const ref = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (focus) ref.current?.focus()
  }, [focus])
  return (
    <h2 ref={ref} tabIndex={-1} className="text-lg font-medium outline-none">
      {children}
    </h2>
  )
}

function LayoutChoice({
  presets,
  hasLayout,
  focus,
  busy,
  notice,
  onPreset,
  onMap,
  onBack,
}: {
  presets: Array<BankPreset>
  hasLayout: boolean
  focus: boolean
  busy: boolean
  notice: React.ReactNode
  onPreset: (id: string) => void
  onMap: () => void
  onBack: () => void
}) {
  const [picked, setPreset] = useState<string | null>(null)
  // Until one is picked, the first: the presets may have loaded after
  // this step opened.
  const preset = picked ?? presets.at(0)?.id ?? ''
  return (
    <section aria-label="How to read it" className="flex flex-col gap-4">
      <StepHeading focus={focus}>How to read the file</StepHeading>
      <p className="text-sm text-neutral-700">
        {hasLayout
          ? 'Read this file another way: the bank’s layout, or columns matched by hand.'
          : 'This account has no CSV layout yet. Choose the bank’s, or match the columns by hand.'}
      </p>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <label className="flex flex-col gap-1 text-sm">
          The bank’s layout
          <select
            value={preset}
            onChange={(e) => setPreset(e.target.value)}
            className={`${field} w-96 max-w-full`}
          >
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {presetName(p)}
                {p.verified ? '' : ' (unverified)'}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className={button}
          disabled={busy || !preset}
          onClick={() => onPreset(preset)}
        >
          Preview with it
        </button>
      </div>
      <p className="text-xs text-neutral-500">
        Unverified: written from the bank’s documents, not checked against a
        real file yet. The preview shows what it reads.
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={quiet} disabled={busy} onClick={onMap}>
          Map the columns by hand
        </button>
        <button
          type="button"
          className={quiet}
          disabled={busy}
          onClick={onBack}
        >
          Back
        </button>
      </div>
      {notice}
    </section>
  )
}

/** A column picker over the header row's cells. */
function ColumnSelect({
  label,
  value,
  header,
  optional,
  onChange,
}: {
  label: string
  value: number | null
  header: Array<string>
  optional?: boolean
  onChange: (v: number | null) => void
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      {label}
      <select
        value={value ?? ''}
        onChange={(e) =>
          onChange(e.target.value === '' ? null : Number(e.target.value))
        }
        className={`${field} w-64 max-w-full`}
      >
        <option value="">{optional ? 'None' : 'Choose…'}</option>
        {header.map((_, i) => (
          <option key={i} value={i}>
            {columnLabel(i, header)}
          </option>
        ))}
      </select>
    </label>
  )
}

/**
 * The file's first rows as they are, and which column is which. The
 * check is a preview with the mapping: what it reads, written nowhere.
 */
function MapColumns({
  rows,
  focus,
  busy,
  notice,
  onCheck,
  onBack,
}: {
  rows: Array<BankPeekRow>
  focus: boolean
  busy: boolean
  notice: React.ReactNode
  onCheck: (mapping: NonNullable<ReturnType<typeof mappingOf>>) => void
  onBack: () => void
}) {
  const [picks, setPicks] = useState<MappingPicks>(emptyPicks)
  const width = Math.max(0, ...rows.map((r) => r.cells.length))
  const header = Array.from({ length: width }, (_, i) =>
    picks.headerRow === null ? '' : (rows[picks.headerRow]?.cells[i] ?? ''),
  )
  const mapping = mappingOf(picks, header)
  const set = (p: Partial<MappingPicks>) => setPicks({ ...picks, ...p })
  const amount = picks.amount
  return (
    <section aria-label="Map the columns" className="flex flex-col gap-4">
      <StepHeading focus={focus}>Match the columns</StepHeading>
      {rows.length >= PEEK_ROWS && (
        <p className="text-sm text-neutral-600">
          Only the first {PEEK_ROWS} lines are shown. The column names must be
          among them; if your bank puts them further down, delete the lines
          above them in a spreadsheet, or use one of the bank layouts.
        </p>
      )}
      <div className="max-h-80 overflow-auto rounded border border-neutral-200">
        <table className="min-w-full text-xs">
          <caption className="sr-only">The file’s first rows</caption>
          <thead className="sticky top-0 bg-neutral-50">
            <tr>
              <th scope="col" className="px-2 py-1 text-left">
                Line
              </th>
              {header.map((_, i) => (
                <th key={i} scope="col" className="px-2 py-1 text-left">
                  {columnLabel(i, [])}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr
                key={r.line}
                className={
                  ri === picks.headerRow
                    ? 'bg-amber-50 font-medium'
                    : 'border-t border-neutral-100'
                }
              >
                <th scope="row" className="px-2 py-1 text-left font-normal">
                  {r.line}
                </th>
                {header.map((_, i) => (
                  <td key={i} className="max-w-48 truncate px-2 py-1">
                    {r.cells[i] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <label className="flex flex-col gap-1 text-sm">
        Which line holds the column names?
        <select
          value={picks.headerRow ?? 'none'}
          onChange={(e) =>
            set({
              headerRow:
                e.target.value === 'none' ? null : Number(e.target.value),
            })
          }
          className={`${field} w-64 max-w-full`}
        >
          <option value="none">No header row: the data starts on line 1</option>
          {rows.map((r, i) => (
            <option key={r.line} value={i}>
              Line {r.line}: {r.cells.filter(Boolean).slice(0, 3).join(', ')}
            </option>
          ))}
        </select>
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <ColumnSelect
          label="Date"
          value={picks.date}
          header={header}
          onChange={(date) => set({ date })}
        />
        <fieldset className="flex flex-col gap-2 text-sm">
          <legend className="mb-1">Amount</legend>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              checked={amount.kind === 'signed'}
              onChange={() => set({ amount: { kind: 'signed', column: null } })}
            />
            One column (money in positive)
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              checked={amount.kind === 'paidInOut'}
              onChange={() =>
                set({
                  amount: { kind: 'paidInOut', paidIn: null, paidOut: null },
                })
              }
            />
            Money in and money out columns
          </label>
        </fieldset>
        {amount.kind === 'signed' ? (
          <ColumnSelect
            label="Amount column"
            value={amount.column}
            header={header}
            onChange={(column) => set({ amount: { kind: 'signed', column } })}
          />
        ) : (
          <>
            <ColumnSelect
              label="Money in"
              value={amount.paidIn}
              header={header}
              onChange={(paidIn) => set({ amount: { ...amount, paidIn } })}
            />
            <ColumnSelect
              label="Money out"
              value={amount.paidOut}
              header={header}
              onChange={(paidOut) => set({ amount: { ...amount, paidOut } })}
            />
          </>
        )}
        <ColumnSelect
          label="Payer"
          optional
          value={picks.payer}
          header={header}
          onChange={(payer) => set({ payer })}
        />
        <ColumnSelect
          label="Reference"
          optional
          value={picks.reference}
          header={header}
          onChange={(reference) => set({ reference })}
        />
        <ColumnSelect
          label="Bank’s transaction id"
          optional
          value={picks.bankId}
          header={header}
          onChange={(bankId) => set({ bankId })}
        />
      </div>
      <fieldset className="flex flex-col gap-1 text-sm">
        <legend className="mb-1">Description (any columns, in order)</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {header.map((_, i) => (
            <label key={i} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={picks.narrative.includes(i)}
                onChange={(e) =>
                  set({
                    narrative: e.target.checked
                      ? [...picks.narrative, i].sort((a, b) => a - b)
                      : picks.narrative.filter((n) => n !== i),
                  })
                }
              />
              {columnLabel(i, header)}
            </label>
          ))}
        </div>
      </fieldset>
      {!mapping && (
        <p className="text-sm text-neutral-600">
          Still to choose: {missing(picks).join(', ')}.
        </p>
      )}
      {notice}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={button}
          disabled={busy || !mapping}
          onClick={() => mapping && onCheck(mapping)}
        >
          {busy ? 'Reading…' : 'Preview with these columns'}
        </button>
        <button
          type="button"
          className={quiet}
          disabled={busy}
          onClick={onBack}
        >
          Back
        </button>
      </div>
    </section>
  )
}

function UndatedWarning({
  rows,
  count,
}: {
  rows: Array<BankUndated>
  count: number
}) {
  if (count === 0) return null
  const lines = rows.map((r) => `${r.line} (${formatPence(r.amount)})`)
  return (
    <p
      role="status"
      data-testid="bank-undated"
      className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-sm text-amber-900"
    >
      {count} {count === 1 ? 'row' : 'rows'} with an amount but no date{' '}
      {count === 1 ? 'was' : 'were'} skipped: line {lines.join(', ')}
      {count > rows.length ? ' and more' : ''}. A totals row looks like this; if
      one is a payment, check the date column.
    </p>
  )
}

function Summary({
  outcome,
  verb,
}: {
  outcome: BankPreviewOutcome | BankImportedOutcome
  verb: 'would be' | 'were'
}) {
  const range =
    outcome.firstDate && outcome.lastDate
      ? `${formatDay(outcome.firstDate)} to ${formatDay(outcome.lastDate)}`
      : null
  return (
    <div className="flex flex-col gap-2">
      <p className="text-base font-medium" data-testid="bank-summary">
        {outcome.newLines} new, {outcome.duplicateLines} already imported
      </p>
      <p className="text-sm text-neutral-600">
        {[
          range && `Credits from ${range}`,
          outcome.debitsDropped > 0 &&
            `${outcome.debitsDropped} payments out ${verb} skipped (only money in is kept)`,
        ]
          .filter(Boolean)
          .join('. ')}
      </p>
      <UndatedWarning rows={outcome.undated} count={outcome.undatedCount} />
    </div>
  )
}

function Done({
  outcome,
  slug,
  again,
  focus,
}: {
  outcome: BankImportedOutcome
  slug: string
  again: () => void
  focus: boolean
}) {
  return (
    <section aria-label="Imported" className="flex flex-col gap-4">
      <StepHeading focus={focus}>Imported</StepHeading>
      <div role="status">
        <Summary outcome={outcome} verb="were" />
      </div>
      <div className="flex flex-wrap gap-2">
        <Link
          to="/t/$slug/bank/imports/$importId"
          params={{ slug, importId: outcome.id }}
          className={button}
        >
          See the lines
        </Link>
        <button type="button" className={quiet} onClick={again}>
          Import another
        </button>
      </div>
    </section>
  )
}
