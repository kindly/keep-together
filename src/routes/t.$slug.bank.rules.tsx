import { Link, createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { ConfirmDialog } from '../components/confirm-dialog'
import { useBankAccounts, useRuleWrites, useRules } from '../lib/data'
import type { BankRule, BankRuleField } from '../lib/data'
import { RustApiError } from '../lib/data/rust/client'
import { refusal } from '../lib/gifts'
import { useCanWrite } from '../lib/tenant'

export const Route = createFileRoute('/t/$slug/bank/rules')({
  component: RulesPage,
})

const field = 'rounded border border-neutral-300 px-2 py-1 text-sm'
const button =
  'self-start rounded bg-neutral-900 px-3 py-1 text-sm text-white hover:bg-neutral-700 disabled:opacity-50'

const FIELDS: Array<[BankRuleField, string]> = [
  ['narrative', 'Description'],
  ['payer', 'Payer'],
  ['reference', 'Reference'],
]

/**
 * Not-a-donation rules (bank transfers 6b): "the description contains
 * GOCARDLESS" on one account or all. A line a rule fits is suggested as
 * not a donation, pre-ticked, and applied only when staff accept it
 * (g1q5). Deleting a rule keeps it on record, inactive.
 */
function RulesPage() {
  const { slug } = Route.useParams()
  const canWrite = useCanWrite()
  const rules = useRules(canWrite)
  const accounts = useBankAccounts(canWrite)
  if (!canWrite)
    return (
      <main className="mx-auto max-w-4xl p-6 text-sm text-neutral-600">
        Bank statements are for staff and admins.
      </main>
    )
  const name = (id: string | null) =>
    id === null
      ? 'every account'
      : (accounts.data?.find((a) => a.id === id)?.name ?? 'an account')
  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-4 p-4 sm:p-6">
      <Link
        to="/t/$slug/bank/reconcile"
        params={{ slug }}
        className="text-sm text-neutral-600 underline"
      >
        Reconcile
      </Link>
      <div>
        <h1 className="text-xl font-semibold">Not-a-donation rules</h1>
        <p className="mt-1 text-sm text-neutral-600">
          Lines that are never donations (payouts, grants, interest): each rule
          suggests them as not a donation, ticked, for you to accept.
        </p>
      </div>
      <NewRule />
      {rules.error ? (
        <p role="alert" className="text-sm text-red-700">
          The rules couldn’t load.
        </p>
      ) : rules.data === undefined ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : rules.data.length === 0 ? (
        <p className="text-sm text-neutral-600">No rules yet.</p>
      ) : (
        <ul className="divide-y divide-neutral-200 rounded border border-neutral-200">
          {rules.data.map((r) => (
            <li key={r.id}>
              <RuleRow rule={r} accountName={name(r.accountId)} />
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}

const fieldName = (f: BankRuleField) =>
  (FIELDS.find(([k]) => k === f)?.[1] ?? f).toLowerCase()

function RuleRow({
  rule: r,
  accountName,
}: {
  rule: BankRule
  accountName: string
}) {
  const writes = useRuleWrites()
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="flex flex-col gap-1 px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between">
      <span>
        The {fieldName(r.field)} contains “{r.contains}”, on {accountName}
        {r.note && <span className="text-neutral-600"> — {r.note}</span>}
      </span>
      <button
        type="button"
        className="self-start rounded border border-neutral-300 px-3 py-1 text-sm disabled:opacity-50"
        disabled={busy}
        onClick={() => setAsking(true)}
      >
        Delete
      </button>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      <ConfirmDialog
        open={asking}
        title="Delete this rule?"
        description="Lines it fits stop being suggested as not a donation. Lines already marked stay as they are."
        confirm="Delete"
        cancel="Cancel"
        onCancel={() => setAsking(false)}
        onConfirm={() => {
          setAsking(false)
          setBusy(true)
          setError(null)
          writes
            .remove(r.id, r.version)
            .catch((err: unknown) =>
              setError(
                refusal(
                  err,
                  'Could not delete the rule',
                  'Someone else changed this rule just now: check it, then try again',
                ),
              ),
            )
            .finally(() => setBusy(false))
        }}
      />
    </div>
  )
}

function NewRule() {
  const writes = useRuleWrites()
  const accounts = useBankAccounts()
  const [ruleField, setRuleField] = useState<BankRuleField>('narrative')
  const [contains, setContains] = useState('')
  const [note, setNote] = useState('')
  const [accountId, setAccountId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setProblem(null)
    try {
      await writes.create({
        accountId: accountId || null,
        field: ruleField,
        contains: contains.trim(),
        note: note.trim() || null,
      })
      setContains('')
      setNote('')
    } catch (err) {
      if (
        err instanceof RustApiError &&
        err.error.kind === 'invalid' &&
        err.error.problems.some((p) => p.field === 'contains')
      )
        setProblem(
          err.error.problems.find((p) => p.field === 'contains')!.message,
        )
      else setError(refusal(err, 'Could not save the rule', ''))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      aria-label="New rule"
      onSubmit={(e) => void submit(e)}
      className="flex flex-col gap-3 rounded border border-neutral-200 p-3"
    >
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          When the
          <select
            value={ruleField}
            onChange={(e) => setRuleField(e.target.value as BankRuleField)}
            className={field}
          >
            {FIELDS.map(([k, label]) => (
              <option key={k} value={k}>
                {label.toLowerCase()}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          contains
          <input
            value={contains}
            required
            placeholder="GOCARDLESS"
            onChange={(e) => setContains(e.target.value)}
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem ? 'rule-contains-problem' : undefined}
            className={`${field} w-48`}
          />
          {problem && (
            <span id="rule-contains-problem" className="text-xs text-red-700">
              {problem}
            </span>
          )}
        </label>
        <label className="flex flex-col gap-1 text-sm">
          on
          <select
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            className={field}
          >
            <option value="">every account</option>
            {(accounts.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="flex flex-col gap-1 text-sm">
        It is (the note on each line)
        <input
          value={note}
          placeholder="A GoCardless payout"
          onChange={(e) => setNote(e.target.value)}
          className={`${field} w-full max-w-md`}
        />
      </label>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      <button
        type="submit"
        className={button}
        disabled={busy || !contains.trim()}
      >
        {busy ? 'Saving…' : 'Add the rule'}
      </button>
    </form>
  )
}
