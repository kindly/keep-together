import { Link } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { useExpectedPeriods, useTermsWrites } from '../lib/data'
import type {
  RegularGift,
  RegularGiftFrequency,
  ShareArgs,
  Term,
} from '../lib/data'
import { useRequestKey } from '../lib/request-key'
import {
  DAYS_OF_MONTH,
  monthName,
  scheduleText,
} from '../lib/domain/direct-debit'
import { annualValue, changeKind, total } from '../lib/domain/regular-terms'
import type { Share, Terms } from '../lib/domain/regular-terms'
import {
  formatDay,
  formatPence,
  parsePounds,
  penceToInput,
  refusal,
} from '../lib/gifts'
import { useCanWrite, useTenant } from '../lib/tenant'
import {
  EXPECTED_LABELS,
  KIND_LABELS,
  TERM_STATUS_LABELS,
  effectiveOptions,
  liveChain,
  proposedSplit,
  rowBefore,
  sameSchedule,
  splitProblem,
} from '../lib/terms-form'
import { localToday } from './source-code-picker'
import { ConfirmDialog } from './confirm-dialog'
import {
  AmountField,
  CodeField,
  DialogFrame,
  amountProblem,
  field,
  isEnded,
  primary,
  small,
} from './direct-debit'
import type { PickedCode } from './direct-debit'

// Regular-gift terms on the card (ADR 0026, regular-gift-terms step 6):
// "Change amount or schedule" (the new total, the code that won it, the
// payment it starts on, the split shown and editable), the terms
// history, a scheduled change to edit or withdraw, "change not coded"
// and its picker, and the last 12 periods of expected against what
// happened. Staff and admins change terms; viewers see them. Nothing is
// optimistic: the chain shown is the server's, read back after each write.

const STATUS_STYLE: Record<Term['status'], string> = {
  scheduled: 'bg-sky-100 text-sky-900',
  sending: 'bg-amber-100 text-amber-900',
  sent: 'bg-amber-100 text-amber-900',
  applied: 'bg-green-100 text-green-900',
  withdrawn: 'bg-neutral-100 text-neutral-500',
}

/** "STREET-1 £10.00 + PHONE-2 £2.00", or the one code. */
export function splitText(
  shares: ReadonlyArray<{ sourceCode: string | null; amount: bigint }>,
): string {
  if (shares.length === 1) return shares[0].sourceCode ?? '?'
  return shares
    .map((s) => `${s.sourceCode ?? '?'} ${formatPence(s.amount)}`)
    .join(' + ')
}

/** What the card adds for terms: the change button, history, periods. */
export function RegularGiftTerms({ gift }: { gift: RegularGift }) {
  const canWrite = useCanWrite()
  const [dialog, setDialog] = useState<
    | { kind: 'change' }
    | { kind: 'edit'; term: Term }
    | { kind: 'withdraw'; term: Term }
    | { kind: 'code'; term: Term }
    | null
  >(null)
  const ended = isEnded(gift)
  const uncoded = gift.terms.filter((t) => t.uncoded)
  return (
    <div className="flex flex-col gap-2">
      {gift.changeNotCoded && (
        <div
          role="status"
          data-testid="change-not-coded"
          className="flex flex-wrap items-baseline gap-2 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-amber-900"
        >
          <span>
            Change not coded: the amount was changed in GoCardless. Pick the
            code that won it.
          </span>
          {canWrite && uncoded[0] && (
            <button
              type="button"
              className="underline"
              onClick={() => setDialog({ kind: 'code', term: uncoded[0] })}
            >
              Pick code
            </button>
          )}
        </div>
      )}
      {gift.scheduled && (
        <ScheduledChange
          term={gift.scheduled}
          canWrite={canWrite && !ended}
          onEdit={(term) => setDialog({ kind: 'edit', term })}
          onWithdraw={(term) => setDialog({ kind: 'withdraw', term })}
        />
      )}
      {canWrite && !ended && (
        <button
          type="button"
          className={`${small} self-start`}
          onClick={() => setDialog({ kind: 'change' })}
        >
          Change amount or schedule
        </button>
      )}
      <TermsHistory
        gift={gift}
        canWrite={canWrite}
        onEdit={(term) => setDialog({ kind: 'edit', term })}
        onWithdraw={(term) => setDialog({ kind: 'withdraw', term })}
        onCode={(term) => setDialog({ kind: 'code', term })}
      />
      <ExpectedPeriods gift={gift} />
      {(dialog?.kind === 'change' || dialog?.kind === 'edit') && (
        <ChangeDialog
          gift={gift}
          editing={dialog.kind === 'edit' ? dialog.term : undefined}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'withdraw' && (
        <WithdrawDialog
          gift={gift}
          term={dialog.term}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'code' && (
        <CodeDialog
          gift={gift}
          term={dialog.term}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  )
}

/** The next change still to reach GoCardless, with Edit and Withdraw. */
function ScheduledChange({
  term,
  canWrite,
  onEdit,
  onWithdraw,
}: {
  term: Term
  canWrite: boolean
  onEdit: (t: Term) => void
  onWithdraw: (t: Term) => void
}) {
  const editable = term.status === 'scheduled'
  return (
    <div
      data-testid="scheduled-change"
      className="flex flex-col gap-1 rounded border border-sky-200 bg-sky-50 px-2 py-1"
    >
      <p>
        {KIND_LABELS[term.changeKind]} from {formatDay(term.effectiveOn)}:{' '}
        {formatPence(term.amount)} {scheduleText(term)} (
        {splitText(term.allocations)}).{' '}
        <span className="text-xs text-neutral-600">
          {TERM_STATUS_LABELS[term.status]}
          {term.appliesFrom &&
            ` · moved to ${formatDay(term.appliesFrom)}: GoCardless had made the earlier payment already`}
        </span>
      </p>
      {term.syncError && (
        <p role="alert" className="text-xs text-red-700">
          GoCardless refused this change: {term.syncError}. Edit or withdraw it.
        </p>
      )}
      {canWrite && editable && (
        <span className="flex gap-2">
          <button type="button" className={small} onClick={() => onEdit(term)}>
            Edit change
          </button>
          <button
            type="button"
            className={small}
            onClick={() => onWithdraw(term)}
          >
            Withdraw change
          </button>
        </span>
      )}
    </div>
  )
}

/** Every row of the chain, newest first, withdrawn ones included. */
function TermsHistory({
  gift,
  canWrite,
  onEdit,
  onWithdraw,
  onCode,
}: {
  gift: RegularGift
  canWrite: boolean
  onEdit: (t: Term) => void
  onWithdraw: (t: Term) => void
  onCode: (t: Term) => void
}) {
  if (gift.terms.length < 2) return null
  const rows = [...gift.terms].reverse()
  return (
    <details>
      <summary className="cursor-pointer text-xs font-medium text-neutral-500">
        Terms history ({gift.terms.length})
      </summary>
      <table
        data-testid="terms-history"
        className="mt-1 w-full text-left text-xs"
      >
        <thead>
          <tr className="text-neutral-500">
            <th className="py-1 pr-3 font-normal">From</th>
            <th className="py-1 pr-3 font-normal">Terms</th>
            <th className="py-1 pr-3 font-normal">Change</th>
            <th className="py-1 pr-3 font-normal">Code</th>
            <th className="py-1 font-normal">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr
              key={t.id}
              data-term={t.id}
              data-status={t.status}
              className={`border-t border-neutral-100 align-top ${t.status === 'withdrawn' ? 'text-neutral-400 line-through' : ''}`}
            >
              <td className="py-1 pr-3 whitespace-nowrap">
                {formatDay(t.effectiveOn)}
              </td>
              <td className="py-1 pr-3">
                {formatPence(t.amount)} {scheduleText(t)}
                <div className="text-neutral-500">
                  {splitText(t.allocations)}
                </div>
                {t.note && <div className="text-neutral-500">{t.note}</div>}
              </td>
              <td className="py-1 pr-3">
                {KIND_LABELS[t.changeKind]}
                {t.origin === 'gocardless' && (
                  <div className="text-neutral-500">changed in GoCardless</div>
                )}
              </td>
              <td className="py-1 pr-3">
                {t.changeCode ?? (t.uncoded ? 'not coded' : '')}
                {canWrite &&
                  t.origin !== 'setup' &&
                  t.status !== 'withdrawn' && (
                    <button
                      type="button"
                      className="ml-1 underline"
                      onClick={() => onCode(t)}
                    >
                      {t.changeCodeId ? 'Change code' : 'Pick code'}
                    </button>
                  )}
              </td>
              <td className="py-1">
                <span className={`rounded px-1 ${STATUS_STYLE[t.status]}`}>
                  {TERM_STATUS_LABELS[t.status]}
                </span>
                {canWrite && t.status === 'scheduled' && !isEnded(gift) && (
                  <span className="ml-1 inline-flex gap-1">
                    <button
                      type="button"
                      className="underline"
                      onClick={() => onEdit(t)}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="underline"
                      onClick={() => onWithdraw(t)}
                    >
                      Withdraw
                    </button>
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  )
}

/** The last 12 periods: what was expected, and what happened. Read when opened. */
function ExpectedPeriods({ gift }: { gift: RegularGift }) {
  const { slug } = useTenant()
  const [open, setOpen] = useState(false)
  const rows = useExpectedPeriods(gift.id, open)
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="cursor-pointer text-xs font-medium text-neutral-500">
        Expected vs actual (last 12 months)
      </summary>
      {!open ? null : rows === undefined ? (
        <p className="text-xs text-neutral-500">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-neutral-500">Nothing expected yet.</p>
      ) : (
        <table
          data-testid="expected-periods"
          className="mt-1 w-full text-left text-xs"
        >
          <thead>
            <tr className="text-neutral-500">
              <th className="py-1 pr-3 font-normal">Due</th>
              <th className="py-1 pr-3 text-right font-normal">Expected</th>
              <th className="py-1 pr-3 font-normal">What happened</th>
              <th className="py-1 font-normal">Gift</th>
            </tr>
          </thead>
          <tbody>
            {[...rows].reverse().map((r) => (
              <tr
                key={r.period}
                data-period={r.period}
                data-status={r.status}
                className="border-t border-neutral-100"
              >
                <td className="py-1 pr-3 whitespace-nowrap">
                  {formatDay(r.dueOn)}
                </td>
                <td className="py-1 pr-3 text-right">
                  {formatPence(r.expected)}
                </td>
                <td
                  className={`py-1 pr-3 ${r.status === 'collected' ? 'text-green-800' : r.status === 'failed' || r.status === 'missing' ? 'text-red-700' : 'text-neutral-600'}`}
                >
                  {EXPECTED_LABELS[r.status]}
                  {r.amount !== null &&
                    r.amount !== r.expected &&
                    ` (${formatPence(r.amount)})`}
                </td>
                <td className="py-1">
                  {r.giftId && (
                    <Link
                      to="/t/$slug/gifts/$giftId"
                      params={{ slug, giftId: r.giftId }}
                      className="underline"
                    >
                      Open
                    </Link>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </details>
  )
}

/** One line of an edited split as the form holds it. */
type SplitLine = { key?: string; code: PickedCode | null; amount: string }

const linesOf = (
  shares: ReadonlyArray<{ key?: string; sourceCodeId: string; amount: bigint }>,
  names: Map<string, string>,
): Array<SplitLine> =>
  shares.map((s) => ({
    ...(s.key && { key: s.key }),
    // An upgrade's layer before its code is picked: no code yet.
    code: s.sourceCodeId
      ? {
          id: s.sourceCodeId,
          shown: { code: names.get(s.sourceCodeId) ?? '?', isActive: true },
        }
      : null,
    amount: penceToInput(s.amount),
  }))

/**
 * "Change amount or schedule", or a scheduled change edited: the new
 * total, the code that won it, the payment it starts on (from
 * GoCardless's next ones), and the split the server will store, shown
 * from the TS twin and editable.
 */
function ChangeDialog({
  gift,
  editing,
  onClose,
}: {
  gift: RegularGift
  editing?: Term
  onClose: () => void
}) {
  const writes = useTermsWrites()
  const keyFor = useRequestKey()
  const today = localToday()
  // Every code the gift's rows name, for the split's lines.
  const names = useMemo(() => {
    const m = new Map<string, string>()
    for (const t of gift.terms) {
      for (const a of t.allocations)
        if (a.sourceCode) m.set(a.sourceCodeId, a.sourceCode)
      if (t.changeCodeId && t.changeCode) m.set(t.changeCodeId, t.changeCode)
    }
    return m
  }, [gift.terms])
  const chain = useMemo(
    () => liveChain(gift.terms, editing?.id),
    [gift.terms, editing?.id],
  )
  const from = editing ?? gift
  const [amount, setAmount] = useState(
    editing ? penceToInput(editing.amount) : '',
  )
  const [frequency, setFrequency] = useState<RegularGiftFrequency>(
    from.frequency,
  )
  const [day, setDay] = useState(from.dayOfMonth)
  const [month, setMonth] = useState(from.month ?? new Date().getMonth() + 1)
  const [effectiveFrom, setEffectiveFrom] = useState(
    editing?.effectiveFrom ?? '',
  )
  const [code, setCode] = useState<PickedCode | null>(
    editing?.changeCodeId
      ? {
          id: editing.changeCodeId,
          shown: { code: editing.changeCode ?? '?', isActive: true },
        }
      : null,
  )
  const [note, setNote] = useState(editing?.note ?? '')
  // The proposed split until "Edit split": an edited row's own (with
  // its keys) while its total still holds, else the proposal.
  const [lines, setLines] = useState<Array<SplitLine> | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const schedule = {
    frequency,
    dayOfMonth: day,
    month: frequency === 'yearly' ? month : null,
  }
  const before = rowBefore(chain, effectiveFrom)
  const same = before ? sameSchedule(before, schedule) : true
  const options = effectiveOptions({
    schedule,
    same,
    upcoming: gift.upcoming,
    today,
    own: editing?.effectiveFrom,
  })
  const typed = amountProblem(amount)
  const pence = parsePounds(amount)
  const proposed: Array<Share> =
    before && pence !== null && pence > 0n
      ? proposedSplit(before.split, pence, code?.id ?? null)
      : []
  const edited =
    lines?.map((l) => ({
      sourceCodeId: l.code?.id ?? '',
      amount: parsePounds(l.amount),
    })) ?? null
  const split: Array<Share> = edited
    ? edited.map((s) => ({ ...s, amount: s.amount ?? 0n }))
    : proposed
  const next: Terms | undefined =
    pence !== null && pence > 0n
      ? { effectiveOn: effectiveFrom, amount: pence, ...schedule, split }
      : undefined
  const kind = next ? changeKind(before, next) : undefined
  const delta =
    before && next
      ? annualValue(next.amount, next.frequency) -
        annualValue(before.amount, before.frequency)
      : 0n
  // A new frequency moves no layer: the split is the staff's own.
  const needsSplit = before !== undefined && before.frequency !== frequency
  const problem =
    typed ??
    (pence === null
      ? null
      : !effectiveFrom
        ? 'Pick the payment it starts on'
        : kind === 'upgrade' && !code && !edited
          ? 'Pick the code that won the upgrade'
          : kind === 'unchanged'
            ? 'That is no change'
            : edited
              ? splitProblem(edited, pence)
              : needsSplit
                ? 'A new frequency needs its split: edit the split'
                : null)
  const ready = pence !== null && problem === null && !busy

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!ready) return
    setBusy(true)
    setError(null)
    const allocations: Array<ShareArgs> | undefined = edited
      ? edited.map((s, i) => ({
          ...(lines?.[i].key && { key: lines[i].key }),
          sourceCodeId: s.sourceCodeId,
          amount: s.amount ?? 0n,
        }))
      : undefined
    const body = {
      effectiveFrom,
      amount: pence,
      frequency,
      dayOfMonth: day,
      ...(frequency === 'yearly' && { month }),
      ...(code && { changeCodeId: code.id }),
      ...(allocations && { allocations }),
      ...(note.trim() && { note: note.trim() }),
    }
    try {
      if (editing)
        await writes.edit(gift.id, editing.id, {
          ...body,
          expected: editing.termsVersion,
          ...((code?.id ?? null) !== editing.changeCodeId && {
            codeExpected: editing.codeVersion,
          }),
        })
      // The new row's id: kept only for an identical retry.
      else await writes.change(gift.id, { ...body, clientKey: keyFor(body) })
      onClose()
    } catch (err) {
      setError(
        refusal(
          err,
          'Couldn’t save the change',
          'Someone else changed this regular gift just now: it has been read again. Check it, then save again',
        ),
      )
    } finally {
      setBusy(false)
    }
  }

  const shown = (s: Share) =>
    `${names.get(s.sourceCodeId) ?? (s.sourceCodeId === code?.id ? code.shown.code : '?')} ${formatPence(s.amount)}`

  return (
    <DialogFrame
      title={
        editing ? 'Edit the scheduled change' : 'Change amount or schedule'
      }
      description={`Now ${formatPence(gift.amount)} ${scheduleText(gift)}. The change is sent to GoCardless shortly before the payment it starts on; GoCardless emails the donor.`}
      onClose={onClose}
      busy={busy}
    >
      <form
        aria-label="Change amount or schedule"
        onSubmit={(e) => void submit(e)}
        className="flex flex-col gap-3"
      >
        <AmountField
          label="New amount (£)"
          value={amount}
          onChange={setAmount}
          problem={typed}
        />
        <div className="flex flex-wrap gap-3">
          <label className="flex flex-col gap-1 text-sm">
            How often
            <select
              value={frequency}
              onChange={(e) =>
                setFrequency(e.target.value as RegularGiftFrequency)
              }
              className={field}
            >
              <option value="monthly">Monthly</option>
              <option value="yearly">Yearly</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Day of the month
            <select
              value={day}
              onChange={(e) => setDay(Number(e.target.value))}
              className={field}
            >
              {DAYS_OF_MONTH.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
          {frequency === 'yearly' && (
            <label className="flex flex-col gap-1 text-sm">
              Month
              <select
                value={month}
                onChange={(e) => setMonth(Number(e.target.value))}
                className={field}
              >
                {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                  <option key={m} value={m}>
                    {monthName(m)}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <label className="flex flex-col gap-1 text-sm">
          Starts with the payment on
          <select
            value={options.includes(effectiveFrom) ? effectiveFrom : ''}
            onChange={(e) => setEffectiveFrom(e.target.value)}
            className={`${field} w-48`}
          >
            <option value="">Pick a payment</option>
            {options.map((d) => (
              <option key={d} value={d}>
                {formatDay(d)}
              </option>
            ))}
          </select>
        </label>
        <CodeField label="Code that won it" code={code} onChange={setCode} />
        <div
          data-testid="change-preview"
          className="flex flex-col gap-1 rounded border border-neutral-200 bg-neutral-50 px-2 py-1 text-sm"
        >
          {kind && (
            <p>
              <span data-testid="change-kind" className="font-medium">
                {KIND_LABELS[kind]}
              </span>
              {delta !== 0n && (
                <span data-testid="change-annual">
                  {' '}
                  · {delta > 0n ? '+' : '−'}
                  {formatPence(delta > 0n ? delta : -delta)} a year
                </span>
              )}
            </p>
          )}
          {lines === null ? (
            <p className="flex flex-wrap items-baseline gap-2">
              <span data-testid="change-split">
                Split: {split.length ? split.map(shown).join(' + ') : '—'}
              </span>
              <button
                type="button"
                className="text-xs underline"
                onClick={() =>
                  setLines(
                    linesOf(
                      editing && pence === editing.amount
                        ? editing.allocations
                        : split.length
                          ? split
                          : (before?.split ?? []),
                      new Map([
                        ...names,
                        ...(code ? [[code.id, code.shown.code] as const] : []),
                      ]),
                    ),
                  )
                }
              >
                Edit split
              </button>
            </p>
          ) : (
            <SplitEditor
              lines={lines}
              onChange={setLines}
              total={edited ? total(split) : 0n}
              amount={pence}
            />
          )}
        </div>
        <label className="flex flex-col gap-1 text-sm">
          Note (optional)
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className={`${field} w-full`}
          />
        </label>
        {problem && pence !== null && (
          <p data-testid="change-problem" className="text-sm text-amber-800">
            {problem}
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={!ready}
          className={`${primary} self-start`}
        >
          {busy ? 'Saving…' : editing ? 'Save change' : 'Schedule change'}
        </button>
      </form>
    </DialogFrame>
  )
}

/** The split's lines, each a code and an amount; add and remove lines. */
function SplitEditor({
  lines,
  onChange,
  total: sum,
  amount,
}: {
  lines: Array<SplitLine>
  onChange: (l: Array<SplitLine>) => void
  total: bigint
  amount: bigint | null
}) {
  const set = (i: number, l: Partial<SplitLine>) =>
    onChange(lines.map((x, j) => (j === i ? { ...x, ...l } : x)))
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-medium">Split</legend>
      {lines.map((l, i) => (
        <div
          key={i}
          data-testid="split-line"
          className="flex flex-wrap items-end gap-2"
        >
          <CodeField
            label={`Code ${i + 1}`}
            code={l.code}
            onChange={(code) => set(i, { code })}
          />
          <label className="flex flex-col gap-1 text-sm">
            Amount (£)
            <input
              inputMode="decimal"
              value={l.amount}
              onChange={(e) => set(i, { amount: e.target.value })}
              className={`${field} w-24`}
            />
          </label>
          {lines.length > 1 && (
            <button
              type="button"
              className={small}
              onClick={() => onChange(lines.filter((_, j) => j !== i))}
            >
              Remove
            </button>
          )}
        </div>
      ))}
      <span className="flex items-baseline gap-3 text-xs text-neutral-600">
        <button
          type="button"
          className="underline"
          onClick={() => onChange([...lines, { code: null, amount: '' }])}
        >
          Add a line
        </button>
        <span data-testid="split-total">
          Adds up to {formatPence(sum)}
          {amount !== null && ` of ${formatPence(amount)}`}
        </span>
      </span>
    </fieldset>
  )
}

/** "Withdraw change", asked first. */
function WithdrawDialog({
  gift,
  term,
  onClose,
}: {
  gift: RegularGift
  term: Term
  onClose: () => void
}) {
  const writes = useTermsWrites()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function confirm() {
    setBusy(true)
    setError(null)
    try {
      await writes.withdraw(gift.id, term.id, term.termsVersion)
      onClose()
    } catch (err) {
      setError(
        refusal(
          err,
          'Couldn’t withdraw it',
          'Someone else changed it just now: it has been read again',
        ),
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <ConfirmDialog
      open
      title="Withdraw this change?"
      description={`${formatPence(term.amount)} ${scheduleText(term)} from ${formatDay(term.effectiveOn)}. Nothing has been sent to GoCardless yet: the gift stays as it is.`}
      confirm={busy ? 'Withdrawing…' : 'Withdraw change'}
      cancel="Keep it"
      confirmDisabled={busy}
      onConfirm={() => void confirm()}
      onCancel={onClose}
    >
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
    </ConfirmDialog>
  )
}

/** The code a change is credited to, at any state. */
function CodeDialog({
  gift,
  term,
  onClose,
}: {
  gift: RegularGift
  term: Term
  onClose: () => void
}) {
  const writes = useTermsWrites()
  const [code, setCode] = useState<PickedCode | null>(
    term.changeCodeId
      ? {
          id: term.changeCodeId,
          shown: { code: term.changeCode ?? '?', isActive: true },
        }
      : null,
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const changed = (code?.id ?? null) !== term.changeCodeId
  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await writes.code(gift.id, term.id, term.codeVersion, code?.id ?? null)
      onClose()
    } catch (err) {
      setError(
        refusal(
          err,
          'Couldn’t save the code',
          'Someone else coded it just now: it has been read again',
        ),
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <DialogFrame
      title="Code that won the change"
      description={`${KIND_LABELS[term.changeKind]} from ${formatDay(term.effectiveOn)}: ${formatPence(term.amount)} ${scheduleText(term)}. Reports credit the change to this code.`}
      onClose={onClose}
      busy={busy}
    >
      <form
        aria-label="Code that won the change"
        onSubmit={(e) => void submit(e)}
        className="flex flex-col gap-3"
      >
        <CodeField label="Code that won it" code={code} onChange={setCode} />
        {error && (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={!changed || busy}
          className={`${primary} self-start`}
        >
          {busy ? 'Saving…' : 'Save code'}
        </button>
      </form>
    </DialogFrame>
  )
}
