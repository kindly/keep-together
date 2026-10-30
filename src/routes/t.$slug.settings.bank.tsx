import { createFileRoute } from '@tanstack/react-router'
import { useId, useState } from 'react'
import type { FormEvent } from 'react'
import { ReadRefused, useStepUp } from '../components/claims-ui'
import { SourceCodePicker } from '../components/source-code-picker'
import type { ShownCode } from '../components/source-code-picker'
import {
  useBankAccounts,
  useBankPresets,
  useCreateBankAccount,
  useSaveBankAccount,
} from '../lib/data'
import type {
  BankAccountPayload,
  BankAccountRow,
  BankPreset,
} from '../lib/data'
import { RustApiError } from '../lib/data/rust/client'
import { refusal } from '../lib/gifts'
import { useIsAdmin } from '../lib/tenant'
import { formatSortCode, layoutLabel, presetName } from '../components/bank'

export const Route = createFileRoute('/t/$slug/settings/bank')({
  component: BankAccountsPage,
})

const field = 'rounded border border-neutral-300 px-2 py-1 text-sm'
const button =
  'self-start rounded bg-neutral-900 px-3 py-1 text-sm text-white hover:bg-neutral-700 disabled:opacity-50'
const quiet =
  'self-start rounded border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-50 disabled:opacity-50'

/**
 * Settings › Bank accounts (bank transfers 6a): the group's accounts
 * statements are imported into. Admin only (g1q9). Each has a name, the
 * sort code and last four digits (never the whole number), the source
 * code a gift made from one of its lines falls back to (g2q6), and how
 * its CSV statements are read: a bank's preset (marked "unverified" until
 * a real file confirms it) or columns mapped by hand on the import page.
 */
function BankAccountsPage() {
  const admin = useIsAdmin()
  const accounts = useBankAccounts(admin)
  const presets = useBankPresets(admin)
  const [adding, setAdding] = useState(false)
  if (!admin)
    return (
      <p className="text-sm text-neutral-600">
        The group’s bank accounts are set up by its admins.
      </p>
    )
  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">Bank accounts</h2>
        <p className="mt-1 text-sm text-neutral-600">
          The accounts whose statements you import, to check gifts against the
          bank.
        </p>
      </div>
      {accounts.error ? (
        <ReadRefused
          error={accounts.error}
          retry={accounts.refetch}
          forbidden="Only admins can set up bank accounts."
          failed="The bank accounts couldn’t load."
        />
      ) : accounts.data === undefined || presets.data === undefined ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : (
        <>
          {accounts.data.length === 0 && !adding && (
            <p className="text-sm text-neutral-600">No bank accounts yet.</p>
          )}
          <ul className="flex flex-col gap-3">
            {accounts.data.map((a) => (
              <li key={a.id}>
                <AccountCard
                  row={a}
                  presets={presets.data.presets}
                  reload={() =>
                    accounts
                      .refetch()
                      .then((r) => r.data?.find((x) => x.id === a.id))
                  }
                />
              </li>
            ))}
          </ul>
          {adding ? (
            <AccountForm
              presets={presets.data.presets}
              onDone={() => setAdding(false)}
            />
          ) : (
            <button
              type="button"
              className={quiet}
              onClick={() => setAdding(true)}
            >
              Add a bank account
            </button>
          )}
        </>
      )}
    </section>
  )
}

function AccountCard({
  row,
  presets,
  reload,
}: {
  row: BankAccountRow
  presets: Array<BankPreset>
  reload: () => Promise<BankAccountRow | undefined>
}) {
  const [editing, setEditing] = useState(false)
  if (editing)
    return (
      <AccountForm
        row={row}
        presets={presets}
        reload={reload}
        onDone={() => setEditing(false)}
      />
    )
  return (
    <div className="flex flex-col gap-1 rounded border border-neutral-200 p-3 text-sm sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 flex-col gap-1">
        <p className="font-medium">
          {row.name}
          {!row.active && (
            <span className="ml-2 rounded bg-neutral-100 px-1.5 text-xs text-neutral-600">
              archived
            </span>
          )}
        </p>
        <p className="text-neutral-600">
          {[
            row.sortCode && `Sort code ${formatSortCode(row.sortCode)}`,
            row.accountLast4 && `ending ${row.accountLast4}`,
          ]
            .filter(Boolean)
            .join(', ') || 'No sort code or account number'}
        </p>
        <p className="text-neutral-600">
          Statement layout: {layoutLabel(row.csvLayout, presets)}
        </p>
        <p className="text-neutral-600">
          Default source code: {row.defaultSourceCode?.code ?? 'none'}
        </p>
      </div>
      <button
        type="button"
        className={quiet}
        onClick={() => setEditing(true)}
        aria-label={`Edit ${row.name}`}
      >
        Edit
      </button>
    </div>
  )
}

/** What the form edits, from an account as the server read it. */
const valuesOf = (row?: BankAccountRow): BankAccountPayload => ({
  name: row?.name ?? '',
  sortCode: row ? formatSortCode(row.sortCode) : '',
  accountLast4: row?.accountLast4 ?? '',
  defaultSourceCodeId: row?.defaultSourceCodeId,
  csvLayout: row?.csvLayout,
  active: row?.active ?? true,
})

const shownOf = (row?: BankAccountRow): ShownCode | null =>
  row?.defaultSourceCode
    ? {
        code: row.defaultSourceCode.code,
        isActive: row.defaultSourceCode.isActive,
        startDate: row.defaultSourceCode.startDate,
        endDate: row.defaultSourceCode.endDate,
      }
    : null

/** The fields a `422 invalid` can name, as the server names them. */
type FieldName =
  'name' | 'sortCode' | 'accountLast4' | 'defaultSourceCodeId' | 'csvLayout'
const FIELDS: ReadonlyArray<string> = [
  'name',
  'sortCode',
  'accountLast4',
  'defaultSourceCodeId',
  'csvLayout',
]

/**
 * Add an account, or edit one against its version. Another admin's save
 * meanwhile answers `stale`: the form reloads the account and shows their
 * version, and the change is made again on top of it. Never a blind
 * overwrite. A field the server refuses says so beside it.
 */
function AccountForm({
  row,
  presets,
  reload,
  onDone,
}: {
  row?: BankAccountRow
  presets: Array<BankPreset>
  reload?: () => Promise<BankAccountRow | undefined>
  onDone: () => void
}) {
  const create = useCreateBankAccount()
  const save = useSaveBankAccount()
  const stepUp = useStepUp()
  const id = useId()
  const [values, setValues] = useState<BankAccountPayload>(() => valuesOf(row))
  const [shownCode, setShownCode] = useState<ShownCode | null>(() =>
    shownOf(row),
  )
  const [expected, setExpected] = useState(row?.version ?? 0)
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<FieldName, string>>
  >({})
  const [busy, setBusy] = useState(false)
  /** An input's error wiring: invalid, and described by its message. */
  const invalid = (f: FieldName, hint?: string) => {
    const described = [fieldErrors[f] && `${id}-${f}-error`, hint]
      .filter(Boolean)
      .join(' ')
    return {
      'aria-invalid': fieldErrors[f] ? true : undefined,
      'aria-describedby': described || undefined,
    }
  }
  const fieldError = (f: FieldName) =>
    fieldErrors[f] && (
      <span id={`${id}-${f}-error`} className="text-xs text-red-700">
        {fieldErrors[f]}
      </span>
    )

  const layoutValue = !values.csvLayout
    ? ''
    : values.csvLayout.kind === 'mapping'
      ? 'mapping'
      : `preset:${values.csvLayout.id}`

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setFieldErrors({})
    setBusy(true)
    const sent = values
    try {
      await stepUp.run(async () => {
        if (row) await save(row.id, expected, sent)
        else await create(sent)
        onDone()
      })
    } catch (err) {
      const refused = err instanceof RustApiError ? err.error : null
      if (refused?.kind === 'stale') {
        // Their version, in full: the change is redone on top of it.
        const fresh = await reload?.()
        if (fresh) {
          setValues(valuesOf(fresh))
          setShownCode(shownOf(fresh))
          setExpected(fresh.version)
        }
        setError(
          'Someone else saved this account just now. The form now shows their version: make your change again, then save.',
        )
      } else if (
        refused?.kind === 'invalid' &&
        refused.problems.every((p) => FIELDS.includes(p.field))
      ) {
        setFieldErrors(
          Object.fromEntries(refused.problems.map((p) => [p.field, p.message])),
        )
        setError('Check the marked fields.')
      } else setError(refusal(err, 'Could not save the account', ''))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded border border-neutral-300 p-3">
      <form
        aria-label={row ? `Edit ${row.name}` : 'New bank account'}
        onSubmit={(e) => void submit(e)}
        className="flex flex-col gap-3"
      >
        <label className="flex flex-col gap-1 text-sm">
          Name
          <input
            required
            value={values.name}
            placeholder="CAF current account"
            onChange={(e) => setValues({ ...values, name: e.target.value })}
            className={`${field} w-72 max-w-full`}
            {...invalid('name')}
          />
          {fieldError('name')}
        </label>
        <div className="flex flex-wrap gap-3">
          <label className="flex flex-col gap-1 text-sm">
            Sort code
            <input
              value={values.sortCode}
              inputMode="numeric"
              placeholder="40-52-40"
              onChange={(e) =>
                setValues({ ...values, sortCode: e.target.value })
              }
              className={`${field} w-32`}
              {...invalid('sortCode')}
            />
            {fieldError('sortCode')}
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Account number’s last four digits
            <input
              value={values.accountLast4}
              inputMode="numeric"
              maxLength={4}
              placeholder="1234"
              onChange={(e) =>
                setValues({ ...values, accountLast4: e.target.value })
              }
              className={`${field} w-24`}
              {...invalid('accountLast4', `${id}-last4`)}
            />
            {fieldError('accountLast4')}
            <span id={`${id}-last4`} className="text-xs text-neutral-500">
              Only the last four: an OFX file for another account is refused.
            </span>
          </label>
        </div>
        <label className="flex flex-col gap-1 text-sm">
          Statement layout (CSV)
          <select
            value={layoutValue}
            onChange={(e) => {
              const v = e.target.value
              setValues({
                ...values,
                csvLayout:
                  v === ''
                    ? undefined
                    : v === 'mapping'
                      ? values.csvLayout
                      : { kind: 'preset', id: v.slice('preset:'.length) },
              })
            }}
            className={`${field} w-96 max-w-full`}
            {...invalid('csvLayout')}
          >
            <option value="">Not set: choose at each import</option>
            {values.csvLayout?.kind === 'mapping' && (
              <option value="mapping">Columns mapped by hand</option>
            )}
            {presets.map((p) => (
              <option key={p.id} value={`preset:${p.id}`}>
                {presetName(p)}
                {p.verified ? '' : ' (unverified)'}
              </option>
            ))}
          </select>
          <span className="text-xs text-neutral-500">
            Unverified layouts come from the bank’s documents, not a real file
            yet: check the first import’s preview. OFX and QIF files need no
            layout.
          </span>
          {fieldError('csvLayout')}
        </label>
        <SourceCodePicker
          label="Default source code"
          value={shownCode}
          onPick={(entry) => {
            setValues({ ...values, defaultSourceCodeId: entry.versionId })
            setShownCode({
              code: entry.code,
              isActive: true,
              startDate: entry.startDate,
              endDate: entry.endDate,
            })
          }}
          onClear={() => {
            setValues({ ...values, defaultSourceCodeId: undefined })
            setShownCode(null)
          }}
        />
        {fieldError('defaultSourceCodeId')}
        {row && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={!values.active}
              onChange={(e) =>
                setValues({ ...values, active: !e.target.checked })
              }
            />
            Archived: no more imports into it
          </label>
        )}
        {error && (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <button type="submit" disabled={busy} className={button}>
            {row ? 'Save' : 'Add account'}
          </button>
          <button
            type="button"
            disabled={busy}
            className={quiet}
            onClick={onDone}
          >
            Cancel
          </button>
        </div>
      </form>
      {stepUp.form}
    </div>
  )
}
