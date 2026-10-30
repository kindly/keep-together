import { Link, createFileRoute } from '@tanstack/react-router'
import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { ConfirmDialog } from '../components/confirm-dialog'
import { DonorSearch } from '../components/gift-form'
import {
  ConfidenceBadge,
  LineHeading,
  matchRefusal,
  proposalText,
} from '../components/reconcile'
import { SourceCodePicker } from '../components/source-code-picker'
import type { ShownCode } from '../components/source-code-picker'
import {
  useBankAccounts,
  useBatches,
  useDonor,
  useHandTransfers,
  useLine,
  useMatchWrites,
} from '../lib/data'
import type {
  BankSuggestion,
  DonorRef,
  LineDetail,
  SplitPart,
} from '../lib/data'
import { RustApiError } from '../lib/data/rust/client'
import { STATUS_LABELS } from '../lib/domain/gift-status'
import { nearestFirst } from '../lib/domain/reconcile'
import {
  payerAsPerson,
  remainderOf,
  splitIssues,
} from '../lib/domain/line-split'
import type { DonorChoice } from '../lib/gift-form'
import { formatDay, formatPence, parsePounds } from '../lib/gifts'
import { useCanWrite } from '../lib/tenant'

export const Route = createFileRoute('/t/$slug/bank/lines/$lineId')({
  component: LinePage,
})

const field = 'rounded border border-neutral-300 px-2 py-1 text-sm'
const button =
  'self-start rounded bg-neutral-900 px-3 py-1 text-sm text-white hover:bg-neutral-700 disabled:opacity-50'
const quiet =
  'self-start rounded border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-50 disabled:opacity-50'

/**
 * One statement line (bank transfers 6b): what it is and, unmatched, its
 * ranked suggestions and every way to match it by hand: gifts made from
 * it (split across donors if need be, the rest not a donation), gifts
 * already entered, a paying-in batch, or not a donation. Matched, what it
 * became, and unmatch. Never optimistic: the page shows the line as the
 * server read it back after each command; a line matched meanwhile is
 * said so and read again. Staff and admins (viewers never see lines).
 */
function LinePage() {
  const { slug, lineId } = Route.useParams()
  const canWrite = useCanWrite()
  const detail = useLine(canWrite ? lineId : null)
  if (!canWrite)
    return (
      <main className="mx-auto max-w-4xl p-6 text-sm text-neutral-600">
        Bank statements are for staff and admins.
      </main>
    )
  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-4 p-4 sm:p-6">
      <Link
        to="/t/$slug/bank/reconcile"
        params={{ slug }}
        className="text-sm text-neutral-600 underline"
      >
        Reconcile
      </Link>
      {detail.error ? (
        <p role="alert" className="text-sm text-red-700">
          {detail.error instanceof RustApiError &&
          detail.error.error.kind === 'not_found'
            ? 'No such statement line.'
            : 'The line couldn’t load.'}
        </p>
      ) : detail.data === undefined ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : (
        <Line detail={detail.data} />
      )}
    </main>
  )
}

function Line({ detail: d }: { detail: LineDetail }) {
  const { line } = d
  return (
    <>
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">
          <LineHeading line={line} />
        </h1>
        <p className="text-sm text-neutral-600" data-testid="line-state">
          {line.state === 'unmatched'
            ? 'Unmatched: it counts for nothing until it is matched.'
            : line.state === 'matched'
              ? 'Matched.'
              : `Not a donation${line.note ? `: ${line.note}` : '.'}`}
        </p>
      </div>
      {line.state === 'unmatched' ? (
        <>
          <Suggestions detail={d} />
          <MatchForms detail={d} />
        </>
      ) : (
        <Matched detail={d} />
      )}
    </>
  )
}

/** The line's ranked suggestions, each applied on its own. */
function Suggestions({ detail: d }: { detail: LineDetail }) {
  const writes = useMatchWrites()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (d.suggestions.length === 0) return null
  async function use(s: BankSuggestion) {
    setBusy(true)
    setError(null)
    try {
      const [out] = await writes.accept([
        {
          lineId: d.line.id,
          expected: d.line.matchVersion,
          proposal: s.proposal,
        },
      ])
      if (!out.ok)
        setError(
          out.status === 409
            ? 'Changed meanwhile: someone else matched this line. It has been read again.'
            : out.error && 'message' in out.error
              ? out.error.message
              : 'Could not match the line',
        )
    } catch (err) {
      setError(matchRefusal(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section aria-label="Suggestions" className="flex flex-col gap-2">
      <h2 className="font-medium">Suggestions</h2>
      <ul className="flex flex-col gap-2">
        {d.suggestions.map((s, i) => (
          <li
            key={i}
            className="flex flex-col gap-1 rounded border border-neutral-200 p-2 text-sm sm:flex-row sm:items-center sm:justify-between"
          >
            <span className="flex flex-col">
              <span className="flex flex-wrap items-center gap-2">
                <ConfidenceBadge s={s} />
                {proposalText(s)}
              </span>
              <span className="text-xs text-neutral-600">{s.reason}</span>
            </span>
            <button
              type="button"
              className={quiet}
              disabled={busy}
              onClick={() => void use(s)}
            >
              Use this
            </button>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
    </section>
  )
}

type Way = 'gifts' | 'entered' | 'batch' | 'notDonation'

const WAYS: Array<[Way, string]> = [
  ['gifts', 'Make gifts'],
  ['entered', 'Gifts already entered'],
  ['batch', 'A paying-in batch'],
  ['notDonation', 'Not a donation'],
]

/** Matching by hand: one way at a time. */
function MatchForms({ detail: d }: { detail: LineDetail }) {
  const [way, setWay] = useState<Way>('gifts')
  const [moved, setMoved] = useState(false)
  return (
    <section aria-label="Match by hand" className="flex flex-col gap-3">
      <h2 className="font-medium">Match by hand</h2>
      <div
        role="group"
        aria-label="How to match it"
        className="flex flex-wrap gap-2"
      >
        {WAYS.map(([w, label]) => (
          <button
            key={w}
            type="button"
            aria-pressed={way === w}
            onClick={() => {
              setWay(w)
              setMoved(true)
            }}
            className={`rounded border px-3 py-1 text-sm ${way === w ? 'border-neutral-900 bg-neutral-900 text-white' : 'border-neutral-300 hover:bg-neutral-50'}`}
          >
            {label}
          </button>
        ))}
      </div>
      {way === 'gifts' && <SplitForm detail={d} focus={moved} />}
      {way === 'entered' && <EnteredForm detail={d} focus={moved} />}
      {way === 'batch' && <BatchForm detail={d} focus={moved} />}
      {way === 'notDonation' && <NotDonationForm detail={d} focus={moved} />}
    </section>
  )
}

/** A form's heading, focused when staff switch to it. */
function FormHeading({
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
    <h3 ref={ref} tabIndex={-1} className="text-sm font-medium outline-none">
      {children}
    </h3>
  )
}

/** Runs a match; a refusal is said, and the line is read again. */
function useAttempt() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function attempt(f: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      await f()
    } catch (err) {
      setError(matchRefusal(err))
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, attempt }
}

function Alert({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="text-sm text-red-700">
      {error}
    </p>
  ) : null
}

type Part = {
  key: number
  donor: DonorChoice | null
  amountText: string
  code: { id: string; shown: ShownCode } | null
}

const donorRef = (d: DonorChoice): DonorRef =>
  d.kind === 'existing'
    ? d.id
    : {
        kind: d.contactKind,
        firstName: d.firstName.trim(),
        lastName: d.lastName.trim(),
        name: d.name.trim(),
        ...(d.email.trim() ? { email: d.email.trim() } : {}),
      }

/**
 * Gifts made from the line (g1q6): one or several, for one donor or
 * several, each with its amount and (optionally) its source code (else
 * the donor's acquisition code, else the account's default, g2q6). What
 * the parts leave of the line is not a donation, with a note. The sum is
 * shown as staff type, and must come out exact.
 */
function SplitForm({
  detail: d,
  focus,
}: {
  detail: LineDetail
  focus: boolean
}) {
  const writes = useMatchWrites()
  const id = useId()
  const line = d.line
  const [parts, setParts] = useState<Array<Part>>(() => [
    {
      key: 0,
      donor: null,
      amountText: formatPence(line.amount).replace(/^£/, '').replace(/,/g, ''),
      code: null,
    },
  ])
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The server's refusal, field by field (`parts[1].sourceCodeId`).
  const [refused, setRefused] = useState<Record<string, string>>({})
  const amounts = parts.map((p) => parsePounds(p.amountText))
  const left = remainderOf(line.amount, amounts)
  const issues = splitIssues(
    line.amount,
    parts.map((p, i) => ({ amount: amounts[i], donor: p.donor })),
    note,
  )
  const blocked =
    issues.total !== undefined ||
    issues.rest !== undefined ||
    issues.parts.some((p) => p.donor || p.amount)
  const set = (key: number, patch: Partial<Part>) => {
    setRefused({})
    setParts((ps) => ps.map((p) => (p.key === key ? { ...p, ...patch } : p)))
  }
  /** An input's wiring to its message, when it has one. */
  const describedBy = (name: string, message: string | undefined) =>
    message
      ? {
          'aria-invalid': true as const,
          'aria-describedby': `${id}-${name}-error`,
        }
      : {}
  const fieldError = (name: string, message: string | undefined) =>
    message && (
      <span id={`${id}-${name}-error`} className="text-xs text-red-700">
        {message}
      </span>
    )

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (blocked) return
    const sent: Array<SplitPart> = parts.map((p, i) => ({
      contact: donorRef(p.donor as DonorChoice),
      amount: amounts[i] as bigint,
      ...(p.code ? { sourceCodeId: p.code.id } : {}),
    }))
    setBusy(true)
    setError(null)
    setRefused({})
    try {
      await writes.gifts(
        line.id,
        line.matchVersion,
        sent,
        left > 0n ? { amount: left, note: note.trim() } : undefined,
      )
    } catch (err) {
      if (
        err instanceof RustApiError &&
        err.error.kind === 'invalid' &&
        err.error.problems.every((p) =>
          /^(parts\[\d+\]|remainder)/.test(p.field),
        )
      ) {
        setRefused(
          Object.fromEntries(
            err.error.problems.map((p) => [p.field, p.message]),
          ),
        )
        setError('Check the marked fields.')
      } else setError(matchRefusal(err))
    } finally {
      setBusy(false)
    }
  }

  /** The server's word on part `i`, any of its fields. */
  const refusedOn = (i: number, what: string) =>
    Object.entries(refused).find(([f]) =>
      f.startsWith(`parts[${i}]${what}`),
    )?.[1]

  return (
    <form
      aria-label="Make gifts from the line"
      onSubmit={(e) => void submit(e)}
      className="flex flex-col gap-3 rounded border border-neutral-300 p-3"
    >
      <FormHeading focus={focus}>Make gifts from the line</FormHeading>
      <p className="text-xs text-neutral-500">
        Dated {formatDay(line.postedOn)}, the day the money reached the bank;
        their amounts and date are the line’s and can’t be edited afterwards.
      </p>
      {parts.map((p, i) => {
        const donorIssue = issues.parts[i]?.donor ?? refusedOn(i, '.contact')
        const amountIssue = issues.parts[i]?.amount ?? refusedOn(i, '.amount')
        const codeIssue = refusedOn(i, '.sourceCodeId')
        return (
          <fieldset
            key={p.key}
            className="flex flex-col gap-2 rounded border border-neutral-200 p-2"
          >
            <legend className="px-1 text-sm">
              {parts.length > 1 ? `Gift ${i + 1}` : 'The gift'}
            </legend>
            {p.donor ? (
              <ChosenDonor
                donor={p.donor}
                onChange={(donor) => set(p.key, { donor })}
                invalid={describedBy(`${p.key}-donor`, donorIssue)}
              />
            ) : (
              <div className="flex flex-col gap-1">
                <label className="text-sm" htmlFor={`${id}-${p.key}-donor`}>
                  Donor
                </label>
                <DonorSearch
                  id={`${id}-${p.key}-donor`}
                  onPick={(donor) => set(p.key, { donor })}
                  {...describedBy(`${p.key}-donor`, donorIssue)}
                />
                {line.payer && (
                  <button
                    type="button"
                    className="self-start text-sm underline"
                    onClick={() =>
                      set(p.key, {
                        donor: {
                          kind: 'new',
                          contactKind: 'individual',
                          ...payerAsPerson(line.payer),
                          name: '',
                          email: '',
                        },
                      })
                    }
                  >
                    A new person from the payer: {line.payer}
                  </button>
                )}
              </div>
            )}
            {fieldError(`${p.key}-donor`, donorIssue)}
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-sm">
                Amount (£)
                <input
                  value={p.amountText}
                  inputMode="decimal"
                  onChange={(e) => set(p.key, { amountText: e.target.value })}
                  className={`${field} w-28`}
                  {...describedBy(`${p.key}-amount`, amountIssue)}
                />
                {fieldError(`${p.key}-amount`, amountIssue)}
              </label>
              {parts.length > 1 && (
                <button
                  type="button"
                  className={quiet}
                  onClick={() =>
                    setParts((ps) => ps.filter((q) => q.key !== p.key))
                  }
                >
                  Remove this gift
                </button>
              )}
            </div>
            <SourceCodePicker
              label="Source code (optional)"
              value={p.code?.shown ?? null}
              onPick={(entry) =>
                set(p.key, {
                  code: {
                    id: entry.versionId,
                    shown: {
                      code: entry.code,
                      isActive: true,
                      startDate: entry.startDate,
                      endDate: entry.endDate,
                    },
                  },
                })
              }
              onClear={() => set(p.key, { code: null })}
            />
            {!p.code && (
              <DefaultCode
                donor={p.donor}
                accountId={line.accountId}
                on={line.postedOn}
              />
            )}
            {fieldError(`${p.key}-code`, codeIssue)}
          </fieldset>
        )
      })}
      <button
        type="button"
        className={quiet}
        onClick={() =>
          setParts((ps) => [
            ...ps,
            {
              key: Math.max(...ps.map((q) => q.key)) + 1,
              donor: null,
              amountText:
                left > 0n
                  ? formatPence(left).replace(/^£/, '').replace(/,/g, '')
                  : '',
              code: null,
            },
          ])
        }
      >
        Split: add another gift
      </button>
      <p
        data-testid="split-sum"
        aria-live="polite"
        className={`text-sm ${left < 0n ? 'text-red-700' : 'text-neutral-700'}`}
      >
        {left === 0n
          ? `The gifts add up to the line, ${formatPence(line.amount)}.`
          : left > 0n
            ? `${formatPence(left)} of the line is left: it isn’t a donation.`
            : `The gifts are ${formatPence(-left)} more than the line.`}
      </p>
      {issues.total === 'Add at least one gift' && (
        <p className="text-sm text-red-700">{issues.total}</p>
      )}
      {left > 0n && (
        <label className="flex flex-col gap-1 text-sm">
          What the rest is
          <input
            value={note}
            placeholder="Raffle tickets, a refund…"
            onChange={(e) => {
              setRefused({})
              setNote(e.target.value)
            }}
            className={`${field} w-full max-w-md`}
            {...describedBy('rest', issues.rest ?? refused['remainder.note'])}
          />
          {fieldError('rest', issues.rest ?? refused['remainder.note'])}
        </label>
      )}
      <Alert error={error} />
      <button type="submit" className={button} disabled={busy || blocked}>
        {busy
          ? 'Saving…'
          : parts.length > 1
            ? 'Make these gifts'
            : 'Make the gift'}
      </button>
    </form>
  )
}

/**
 * The code a part with none picked takes (g2q6): the donor's acquisition
 * code, else the account's default; named, so staff see what they accept.
 */
function DefaultCode({
  donor,
  accountId,
  on,
}: {
  donor: DonorChoice | null
  accountId: string
  on: string
}) {
  const existing = donor?.kind === 'existing' ? donor.id : null
  const info = useDonor(existing, on)
  const accounts = useBankAccounts()
  const fallback = accounts.data?.find((a) => a.id === accountId)
    ?.defaultSourceCode?.code
  const own = info?.acquisition?.code
  return (
    <p className="text-xs text-neutral-500" data-testid="split-default-code">
      {own
        ? `None picked: ${own}, the donor’s own source code.`
        : fallback
          ? `None picked: ${fallback}, the account’s default.`
          : existing === null && donor === null
            ? 'None picked: the donor’s own source code, else the account’s default.'
            : 'None picked, and there is no default to fall back on: pick one.'}
    </p>
  )
}

/** A chosen donor: an existing contact's name, or a new one's fields. */
function ChosenDonor({
  donor,
  onChange,
  invalid,
}: {
  donor: DonorChoice
  onChange: (d: DonorChoice | null) => void
  /** A new donor's names' wiring to the part's donor message. */
  invalid: { 'aria-invalid'?: true; 'aria-describedby'?: string }
}) {
  if (donor.kind === 'existing')
    return (
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <span data-testid="split-donor">{donor.displayName}</span>
        <button
          type="button"
          className="underline"
          onClick={() => onChange(null)}
        >
          Change
        </button>
      </p>
    )
  const set = (patch: Partial<typeof donor>) => onChange({ ...donor, ...patch })
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm">
        A new {donor.contactKind === 'individual' ? 'person' : 'organisation'}{' '}
        <button
          type="button"
          className="underline"
          onClick={() => onChange(null)}
        >
          Search instead
        </button>
      </p>
      {donor.contactKind === 'individual' ? (
        <div className="flex flex-wrap gap-3">
          <label className="flex flex-col gap-1 text-sm">
            First name
            <input
              value={donor.firstName}
              onChange={(e) => set({ firstName: e.target.value })}
              className={`${field} w-40`}
              {...(donor.firstName.trim() ? {} : invalid)}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Last name
            <input
              value={donor.lastName}
              onChange={(e) => set({ lastName: e.target.value })}
              className={`${field} w-40`}
              {...(donor.lastName.trim() ? {} : invalid)}
            />
          </label>
        </div>
      ) : (
        <label className="flex flex-col gap-1 text-sm">
          Name
          <input
            value={donor.name}
            onChange={(e) => set({ name: e.target.value })}
            className={`${field} w-64`}
            {...invalid}
          />
        </label>
      )}
    </div>
  )
}

/**
 * Transfers entered by hand near the line's date, not on a statement yet:
 * tick the ones it paid; what they leave of the line needs a note.
 */
function EnteredForm({
  detail: d,
  focus,
}: {
  detail: LineDetail
  focus: boolean
}) {
  const writes = useMatchWrites()
  const { busy, error, attempt } = useAttempt()
  const [days, setDays] = useState(14)
  const found = useHandTransfers(d.line.id, days)
  const [picked, setPicked] = useState<Array<string>>([])
  const [note, setNote] = useState('')
  const chosen = (found.data ?? []).filter((g) => picked.includes(g.id))
  const left = remainderOf(
    d.line.amount,
    chosen.map((g) => g.amount),
  )
  const blocked =
    chosen.length === 0 || left < 0n || (left > 0n && note.trim() === '')
  return (
    <form
      aria-label="Match to gifts already entered"
      onSubmit={(e) => {
        e.preventDefault()
        if (blocked) return
        void attempt(() =>
          writes.matchGifts(
            d.line.id,
            d.line.matchVersion,
            // Only those still listed: one matched elsewhere meanwhile is gone.
            chosen.map((g) => g.id),
            left > 0n ? { amount: left, note: note.trim() } : undefined,
          ),
        )
      }}
      className="flex flex-col gap-3 rounded border border-neutral-300 p-3"
    >
      <FormHeading focus={focus}>Gifts already entered</FormHeading>
      {found.data === undefined ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : found.data.length === 0 ? (
        <p className="text-sm text-neutral-600">
          No transfers entered by hand within {days} days of the line wait for a
          statement.
        </p>
      ) : (
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-sm">
            Transfers not on a statement yet, within {days} days
          </legend>
          {found.data.map((g) => (
            <label key={g.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={picked.includes(g.id)}
                onChange={(e) =>
                  setPicked((p) =>
                    e.target.checked
                      ? [...p, g.id]
                      : p.filter((x) => x !== g.id),
                  )
                }
              />
              {formatPence(g.amount)} from {g.contactName},{' '}
              {formatDay(g.receivedOn)}
            </label>
          ))}
        </fieldset>
      )}
      {days < 60 && (
        <button
          type="button"
          className="self-start text-sm underline"
          onClick={() => setDays(60)}
        >
          Look further: 60 days
        </button>
      )}
      {chosen.length > 0 && (
        <p
          data-testid="entered-sum"
          aria-live="polite"
          className={`text-sm ${left < 0n ? 'text-red-700' : 'text-neutral-700'}`}
        >
          {left === 0n
            ? 'They add up to the line.'
            : left > 0n
              ? `${formatPence(left)} of the line is left: it isn’t a donation.`
              : `They are ${formatPence(-left)} more than the line.`}
        </p>
      )}
      {chosen.length > 0 && left > 0n && (
        <label className="flex flex-col gap-1 text-sm">
          What the rest is
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className={`${field} w-full max-w-md`}
          />
        </label>
      )}
      <Alert error={error} />
      <button type="submit" className={button} disabled={busy || blocked}>
        {busy ? 'Matching…' : 'Match to these gifts'}
      </button>
    </form>
  )
}

/** A closed, unmatched paying-in batch on the line's account. */
function BatchForm({
  detail: d,
  focus,
}: {
  detail: LineDetail
  focus: boolean
}) {
  const writes = useMatchWrites()
  const { busy, error, attempt } = useAttempt()
  const closed = useBatches('closed')
  // Nearest the line first (amount, then date); none chosen for staff.
  const candidates = nearestFirst(
    (closed.data ?? []).filter(
      (b) => b.accountId === d.line.accountId && b.line === null,
    ),
    { amount: d.line.amount, date: d.line.postedOn },
    (b) => ({ amount: b.total, date: b.bankedOn }),
  )
  const [picked, setPicked] = useState<string>('')
  const batch = candidates.find((b) => b.id === picked)
  return (
    <form
      aria-label="Match to a paying-in batch"
      onSubmit={(e) => {
        e.preventDefault()
        if (!batch) return
        void attempt(() =>
          writes.matchBatch(
            d.line.id,
            d.line.matchVersion,
            batch.id,
            batch.lineVersion,
          ),
        )
      }}
      className="flex flex-col gap-3 rounded border border-neutral-300 p-3"
    >
      <FormHeading focus={focus}>A paying-in batch</FormHeading>
      {closed.data === undefined ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : candidates.length === 0 ? (
        <p className="text-sm text-neutral-600">
          No closed batch on this account waits for its statement line.
        </p>
      ) : (
        <>
          <label className="flex flex-col gap-1 text-sm">
            Batch
            <select
              value={picked}
              onChange={(e) => setPicked(e.target.value)}
              className={`${field} w-96 max-w-full`}
            >
              <option value="">Choose a batch…</option>
              {candidates.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.slipNumber ? `Slip ${b.slipNumber}` : 'No slip number'}
                  {b.bankedOn ? `, paid in ${formatDay(b.bankedOn)}` : ''},{' '}
                  {b.total !== null ? formatPence(b.total) : ''}
                </option>
              ))}
            </select>
          </label>
          {batch && batch.total !== null && batch.total !== d.line.amount && (
            <p
              role="status"
              className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-sm text-amber-900"
            >
              The slip says {formatPence(batch.total)}; the line is{' '}
              {formatPence(d.line.amount)}. Matching shows the difference, never
              forces it.
            </p>
          )}
          <p className="text-xs text-neutral-500">
            Its cheques clear when it is matched.
          </p>
        </>
      )}
      <Alert error={error} />
      <button type="submit" className={button} disabled={busy || !batch}>
        {busy ? 'Matching…' : 'Match to this batch'}
      </button>
    </form>
  )
}

function NotDonationForm({
  detail: d,
  focus,
}: {
  detail: LineDetail
  focus: boolean
}) {
  const writes = useMatchWrites()
  const { busy, error, attempt } = useAttempt()
  const [note, setNote] = useState('')
  return (
    <form
      aria-label="Not a donation"
      onSubmit={(e) => {
        e.preventDefault()
        if (!note.trim()) return
        void attempt(() =>
          writes.notDonation(d.line.id, d.line.matchVersion, note.trim()),
        )
      }}
      className="flex flex-col gap-3 rounded border border-neutral-300 p-3"
    >
      <FormHeading focus={focus}>Not a donation</FormHeading>
      <label className="flex flex-col gap-1 text-sm">
        What it is
        <input
          value={note}
          placeholder="A grant, a refund, a GoCardless payout…"
          onChange={(e) => setNote(e.target.value)}
          className={`${field} w-full max-w-md`}
        />
      </label>
      <Alert error={error} />
      <button type="submit" className={button} disabled={busy || !note.trim()}>
        {busy ? 'Saving…' : 'Mark not a donation'}
      </button>
    </form>
  )
}

/**
 * What a matched line became, and unmatch. Unmatching voids the gifts
 * made from the line, unlinks the ones entered by hand (they go back to
 * "not on a statement yet"), and puts a batch's cheques back to pending;
 * a claimed gift voided so is repaid through the next claim.
 */
function Matched({ detail: d }: { detail: LineDetail }) {
  const { slug } = Route.useParams()
  const writes = useMatchWrites()
  const { busy, error, attempt } = useAttempt()
  const [asking, setAsking] = useState(false)
  const made = d.gifts.filter((g) => g.fromLine)
  const linked = d.gifts.filter((g) => !g.fromLine)
  const effects: Array<ReactNode> = [
    made.length > 0 &&
      `${made.length === 1 ? 'The gift' : `The ${made.length} gifts`} made from it ${made.length === 1 ? 'is' : 'are'} voided.`,
    linked.length > 0 &&
      `${linked.length === 1 ? 'The gift' : `The ${linked.length} gifts`} entered by hand ${linked.length === 1 ? 'is' : 'are'} unlinked: “not on a statement yet” again.`,
    d.batchId !== null &&
      'Its paying-in batch is unmatched: its cleared cheques go back to pending.',
    d.gifts.length === 0 &&
      d.batchId === null &&
      'It goes back to unmatched, counting for nothing until matched again.',
    made.length > 0 &&
      'If a voided gift was claimed for Gift Aid, the next claim repays it.',
    d.batchId !== null &&
      'If one of its cheques was claimed for Gift Aid, the next claim repays it.',
  ].filter(Boolean)
  return (
    <section aria-label="What it is matched to" className="flex flex-col gap-3">
      {d.gifts.length > 0 && (
        <ul className="divide-y divide-neutral-200 rounded border border-neutral-200">
          {d.gifts.map((g) => (
            <li key={g.id}>
              <Link
                to="/t/$slug/gifts/$giftId"
                params={{ slug, giftId: g.id }}
                className="flex flex-wrap items-baseline gap-x-3 px-3 py-2 text-sm hover:bg-neutral-50"
              >
                <span>{formatPence(g.amount)}</span>
                <span className="min-w-0 flex-1 truncate">
                  {g.contactName ?? 'an unknown contact'}
                </span>
                <span className="text-xs text-neutral-600">
                  {g.fromLine ? 'made from the line' : 'entered by hand'}
                  {g.status !== 'completed' && `, ${STATUS_LABELS[g.status]}`}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {d.batchId && (
        <Link
          to="/t/$slug/bank/batches/$batchId"
          params={{ slug, batchId: d.batchId }}
          className="text-sm underline"
        >
          Its paying-in batch
        </Link>
      )}
      {d.line.state === 'matched' && d.line.note && (
        <p className="text-sm text-neutral-600">The rest: {d.line.note}</p>
      )}
      <button
        type="button"
        className={quiet}
        disabled={busy}
        onClick={() => setAsking(true)}
      >
        {busy ? 'Unmatching…' : 'Unmatch'}
      </button>
      <Alert error={error} />
      <ConfirmDialog
        open={asking}
        title="Unmatch this line?"
        description={effects.join(' ')}
        confirm="Unmatch"
        cancel="Cancel"
        onConfirm={() => {
          setAsking(false)
          void attempt(() => writes.unmatch(d.line.id, d.line.matchVersion))
        }}
        onCancel={() => setAsking(false)}
      />
    </section>
  )
}
