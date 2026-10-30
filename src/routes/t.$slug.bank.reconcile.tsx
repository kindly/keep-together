import { Link, createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import {
  ConfidenceBadge,
  LineHeading,
  matchRefusal,
  proposalText,
} from '../components/reconcile'
import { useBankAccounts, useLines, useMatchWrites } from '../lib/data'
import type {
  AcceptOutcome,
  BankMatchState,
  LineWithSuggestions,
} from '../lib/data'
import { describe } from '../lib/data/rust/client'
import { useCanWrite } from '../lib/tenant'

export const Route = createFileRoute('/t/$slug/bank/reconcile')({
  component: ReconcilePage,
  validateSearch: (s: Record<string, unknown>): { account?: string } =>
    typeof s.account === 'string' ? { account: s.account } : {},
})

const field = 'rounded border border-neutral-300 px-2 py-1 text-sm'
const button =
  'self-start rounded bg-neutral-900 px-3 py-1 text-sm text-white hover:bg-neutral-700 disabled:opacity-50'

const STATES: Array<[BankMatchState, string]> = [
  ['unmatched', 'Unmatched'],
  ['matched', 'Matched'],
  ['not_donation', 'Not a donation'],
]

/**
 * Reconcile (bank transfers 6b): an account's statement lines. Unmatched
 * ones come with ranked suggestions and the reason for each; a strong one
 * is pre-ticked (a name alone never is), and "Accept ticked" applies only
 * what is ticked, one line at a time: a line someone matched meanwhile is
 * said so and left, the rest done. What shows is only the server's
 * answer (g1q5). Matched and not-a-donation lines are listed to open and
 * unmatch. Staff and admins: viewers never see statement lines (g1q9).
 */
function ReconcilePage() {
  const { slug } = Route.useParams()
  const search = Route.useSearch()
  const canWrite = useCanWrite()
  const accounts = useBankAccounts(canWrite)
  const [accountId, setAccountId] = useState<string | null>(null)
  const [state, setState] = useState<BankMatchState>('unmatched')
  if (!canWrite)
    return (
      <main className="mx-auto max-w-4xl p-6 text-sm text-neutral-600">
        Bank statements are for staff and admins.
      </main>
    )
  const list = accounts.data ?? []
  const chosen =
    accountId ??
    list.find((a) => a.id === search.account)?.id ??
    list.at(0)?.id ??
    null
  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-4 p-4 sm:p-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Reconcile</h1>
        <p className="text-sm text-neutral-600">
          Match each statement line to its gifts. Nothing counts until it is
          matched, and nothing is matched until you say so.{' '}
          <Link
            to="/t/$slug/bank/rules"
            params={{ slug }}
            className="underline"
          >
            Not-a-donation rules
          </Link>
        </p>
      </div>
      {accounts.data === undefined ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : list.length === 0 ? (
        <p className="text-sm text-neutral-600">
          No bank accounts yet: an admin adds them in Settings › Bank accounts.
        </p>
      ) : (
        <>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <label className="flex flex-col gap-1 text-sm">
              Bank account
              <select
                value={chosen ?? ''}
                onChange={(e) => setAccountId(e.target.value)}
                className={`${field} w-72 max-w-full`}
              >
                {list.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <div
              role="group"
              aria-label="Which lines"
              className="flex flex-wrap gap-2"
            >
              {STATES.map(([s, label]) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={state === s}
                  onClick={() => setState(s)}
                  className={`rounded border px-3 py-1 text-sm ${state === s ? 'border-neutral-900 bg-neutral-900 text-white' : 'border-neutral-300 hover:bg-neutral-50'}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          {chosen && (
            <Lines
              key={`${chosen}:${state}`}
              accountId={chosen}
              state={state}
            />
          )}
        </>
      )}
    </main>
  )
}

/** Per line: the ticked suggestion's index, or none. */
type Ticks = Record<string, number | null>

function Lines({
  accountId,
  state,
}: {
  accountId: string
  state: BankMatchState
}) {
  const lines = useLines(accountId, state)
  const writes = useMatchWrites()
  // Staff's own ticks; a line not touched yet follows the server's.
  const [ticks, setTicks] = useState<Ticks>({})
  const [busy, setBusy] = useState(false)
  const [outcomes, setOutcomes] = useState<Record<string, AcceptOutcome>>({})
  const [error, setError] = useState<string | null>(null)
  if (lines.error)
    return (
      <p role="alert" className="text-sm text-red-700">
        The lines couldn’t load.{' '}
        <button
          type="button"
          className="underline"
          onClick={() => void lines.refetch()}
        >
          Try again
        </button>
      </p>
    )
  if (lines.data === undefined)
    return <p className="text-sm text-neutral-500">Loading…</p>
  const rows = lines.data
  const tickOf = (l: LineWithSuggestions) =>
    l.id in ticks
      ? ticks[l.id]
      : (() => {
          const i = l.suggestions.findIndex((s) => s.ticked)
          return i < 0 ? null : i
        })()
  const ticked = rows.flatMap((l) => {
    const i = tickOf(l)
    return i === null || !l.suggestions[i]
      ? []
      : [
          {
            lineId: l.id,
            expected: l.matchVersion,
            proposal: l.suggestions[i].proposal,
          },
        ]
  })

  async function accept() {
    setBusy(true)
    setError(null)
    try {
      const out = await writes.accept(ticked)
      setOutcomes(Object.fromEntries(out.map((o) => [o.lineId, o])))
      setTicks({})
    } catch (err) {
      setError(matchRefusal(err))
    } finally {
      setBusy(false)
    }
  }

  const done = Object.values(outcomes).filter((o) => o.ok).length
  const failed = Object.values(outcomes).flatMap((o) => (o.ok ? [] : [o]))
  return (
    <section aria-label="Statement lines" className="flex flex-col gap-3">
      {state === 'unmatched' &&
        (rows.length > 0 || Object.keys(outcomes).length > 0) && (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <button
              type="button"
              className={button}
              disabled={busy || ticked.length === 0}
              onClick={() => void accept()}
            >
              {busy ? 'Accepting…' : `Accept ticked (${ticked.length})`}
            </button>
            {Object.keys(outcomes).length > 0 && (
              <p
                role="status"
                data-testid="accept-summary"
                className="text-sm text-neutral-700"
              >
                {done} matched
                {failed.length > 0 &&
                  `, ${failed.length} not: ${failed.some((f) => f.status === 409) ? 'changed meanwhile, reload' : 'see each line'}`}
              </p>
            )}
          </div>
        )}
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      {rows.length === 0 ? (
        <p className="text-sm text-neutral-600">
          {state === 'unmatched'
            ? 'Nothing left to match on this account.'
            : 'None.'}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((l) => (
            <li key={l.id}>
              <LineCard
                line={l}
                tick={tickOf(l)}
                outcome={outcomes[l.id]}
                onTick={(i) => setTicks((t) => ({ ...t, [l.id]: i }))}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function LineCard({
  line: l,
  tick,
  outcome,
  onTick,
}: {
  line: LineWithSuggestions
  tick: number | null
  outcome?: AcceptOutcome
  onTick: (i: number | null) => void
}) {
  const { slug } = Route.useParams()
  return (
    <div className="flex flex-col gap-2 rounded border border-neutral-200 p-3 text-sm">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
        <LineHeading line={l} />
        <Link
          to="/t/$slug/bank/lines/$lineId"
          params={{ slug, lineId: l.id }}
          className="shrink-0 underline"
        >
          {l.state === 'unmatched' ? 'Match by hand' : 'Open'}
        </Link>
      </div>
      {l.state === 'not_donation' && l.note && (
        <p className="text-neutral-600">Not a donation: {l.note}</p>
      )}
      {outcome && !outcome.ok && (
        <p role="alert" data-testid="line-outcome" className="text-red-700">
          {outcome.status === 409
            ? 'Changed meanwhile: someone else matched it. Reload to see.'
            : outcome.error
              ? describe(outcome.error)
              : 'Not matched'}
        </p>
      )}
      {l.suggestions.length > 0 && (
        <fieldset className="flex flex-col gap-1">
          <legend className="sr-only">Suggestions for this line</legend>
          {l.suggestions.map((s, i) => (
            <label key={i} className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-1"
                checked={tick === i}
                onChange={(e) => onTick(e.target.checked ? i : null)}
              />
              <span className="flex flex-col">
                <span className="flex flex-wrap items-center gap-2">
                  <ConfidenceBadge s={s} />
                  {proposalText(s)}
                </span>
                <span className="text-xs text-neutral-600">{s.reason}</span>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {l.state === 'unmatched' && l.suggestions.length === 0 && (
        <p className="text-xs text-neutral-500">
          No suggestion: match it by hand.
        </p>
      )}
    </div>
  )
}
