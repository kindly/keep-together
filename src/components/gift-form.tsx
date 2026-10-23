import { Link } from '@tanstack/react-router'
import { useMutation, useQuery } from 'convex/react'
import { ConvexError } from 'convex/values'
import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent, ReactNode, Ref } from 'react'
import { api } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'
import { formatNumber } from '../../convex/contacts/number'
import { giftWarnings } from '../../convex/giving/warnings'
import {
  METHOD_LABELS as DECLARATION_METHOD_LABELS,
  SCOPE_LABELS,
  describeDeclaration,
} from '../lib/giftaid'
import {
  asksForAddress,
  defaultCode,
  differsNote,
  donorKind,
  donorName,
  draftProblems,
  freshDraft,
  giftAidOffer,
  homeOnFile,
  isDirty,
  newDonor,
  noAddressWarning,
  partialHome,
  toArgs,
} from '../lib/gift-form'
import type {
  DonorChoice,
  DonorInfo,
  GiftDraft,
  Problem,
  TickMethod,
} from '../lib/gift-form'
import { METHOD_LABELS, formatPence, parsePounds, refusal } from '../lib/gifts'
import { useTenant } from '../lib/tenant'
import { useReportUnsaved } from '../lib/unsaved'
import { SourceCodePicker, localToday } from './source-code-picker'

const field = 'rounded border border-neutral-300 px-2 py-1.5 text-sm'
const label = 'flex flex-col gap-1 text-sm text-neutral-700'

/** How many search matches the donor box lists. */
const SHOWN_MATCHES = 8

/**
 * The tick's methods, each said plainly (HMRC 3.10, 3.31): what staff are
 * recording, and what it means for a claim. The default is the honest one
 * for a tick with no form in hand.
 */
const TICK_METHODS: Array<{ value: TickMethod; explain: string }> = [
  {
    value: 'staffTickedNoEvidence',
    explain:
      'You’re recording that the donor wants Gift Aid, with no signed form or written record yet. It’s saved as exactly that: the gift can’t be claimed until evidence is added.',
  },
  {
    value: 'paperForm',
    explain:
      'The donor filled in a Gift Aid form. Keep the form: it’s the evidence for a claim.',
  },
  {
    value: 'oral',
    explain:
      'The donor said so, in person or by phone. It only counts once they’re sent a written record of it, and they can then cancel within 30 days.',
  },
]

function FieldProblems({
  problems,
  of,
}: {
  problems: Array<Problem>
  of: string
}) {
  return problems
    .filter((p) => p.field === of)
    .map((p) => (
      <span key={p.message} className="text-xs text-red-700">
        {p.message}
      </span>
    ))
}

function Warning({ children }: { children: ReactNode }) {
  return (
    <p className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-sm text-amber-900">
      {children}
    </p>
  )
}

/** What the last save recorded, for the "Saved" line (g1q7). */
type Saved = {
  giftId: Id<'contributions'>
  amount: bigint
  name: string
  /** The save had already landed (a retry after a lost answer). */
  already: boolean
}

/**
 * The record-gift form (cash gifts step 3): donor, source code, amount,
 * method, date and the Gift Aid tick, saved in one `recordGift`. After a
 * save the form clears for the next gift, keeping the date and method,
 * and says what was saved with a link to it (g1q7).
 *
 * `clientKey` is minted per gift and kept across retries of it, so a
 * double click or a retry after a lost answer records one gift; a new
 * one is minted only once a save has landed.
 */
export function GiftForm() {
  const tenant = useTenant()
  const today = localToday()
  const record = useMutation(api.giving.mutations.recordGift)
  const [draft, setDraft] = useState<GiftDraft>(() => freshDraft(today))
  const [fresh, setFresh] = useState<GiftDraft>(draft)
  const [clientKey, setClientKey] = useState(() => crypto.randomUUID())
  const [problems, setProblems] = useState<Array<Problem>>([])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // A second click lands before React re-renders with `saving`.
  const inFlight = useRef(false)
  const [saved, setSaved] = useState<Saved | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const existingId = draft.donor?.kind === 'existing' ? draft.donor.id : null
  const info = useQuery(
    api.giving.queries.donor,
    existingId
      ? { tenantId: tenant._id, contactId: existingId, today }
      : 'skip',
  )
  // The donor's own code fills an empty code once their details arrive
  // (g2q1). A code staff picked first stays.
  const defaulted = useRef<Id<'contacts'> | null>(null)
  useEffect(() => {
    if (!info || !existingId || defaulted.current === existingId) return
    defaulted.current = existingId
    setDraft((d) => (d.code ? d : { ...d, code: defaultCode(info) }))
  }, [info, existingId])

  const dirty = isDirty(draft, fresh)
  useReportUnsaved(saving ? 'busy' : dirty ? 'unsaved' : 'clean')

  const set = (patch: Partial<GiftDraft>) => {
    setDraft((d) => ({ ...d, ...patch }))
    setError(null)
  }
  const pickDonor = (donor: DonorChoice | null) => {
    defaulted.current = null
    setDraft((d) => ({
      ...d,
      donor,
      // The code follows the donor: a new donor's starts empty.
      code: null,
      giftAid: false,
      line1: '',
      postcode: '',
    }))
    setProblems([])
    setError(null)
    if (donor) setSaved(null)
  }

  const shownInfo = existingId ? info : undefined
  const pence = parsePounds(draft.amountText)
  const warnings =
    pence !== null && pence > 0n && draft.receivedOn
      ? giftWarnings({ receivedOn: draft.receivedOn, amount: pence }, today)
      : []
  const offer = giftAidOffer(draft.donor, shownInfo)
  const onFile = homeOnFile(draft.donor, shownInfo)
  const addressWarning = noAddressWarning(draft, shownInfo)
  const differs = differsNote(draft, shownInfo)
  const explain = TICK_METHODS.find((m) => m.value === draft.declarationMethod)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (inFlight.current) return
    // An existing donor's Gift Aid state must be known before saving.
    if (existingId && info === undefined) return
    const found = draftProblems(draft, shownInfo)
    setProblems(found)
    setError(null)
    if (found.length) return
    const args = toArgs(draft, shownInfo, clientKey)
    const done = (giftId: Id<'contributions'>, already: boolean) => {
      const next = freshDraft(today, draft)
      setSaved({
        giftId,
        amount: args.amount,
        name: donorName(draft.donor!),
        already,
      })
      setDraft(next)
      setFresh(next)
      setClientKey(crypto.randomUUID())
      defaulted.current = null
      searchRef.current?.focus()
    }
    inFlight.current = true
    setSaving(true)
    try {
      const { giftId } = await record({ tenantId: tenant._id, ...args })
      done(giftId, false)
    } catch (err) {
      const data =
        err instanceof ConvexError
          ? (err.data as {
              kind?: string
              reason?: string
              message?: string
              problems?: Array<Problem>
            })
          : null
      if (data?.kind === 'rejected' && data.reason === 'duplicate') {
        done(data.message as Id<'contributions'>, true)
      } else if (data?.kind === 'invalid' && data.problems) {
        setProblems(data.problems)
        setError('Not saved: check the fields marked')
      } else {
        setError(refusal(err, 'Could not save the gift: try again', ''))
      }
    } finally {
      inFlight.current = false
      setSaving(false)
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      noValidate
      className="flex flex-col gap-5"
      aria-label="Record a gift"
    >
      {saved && (
        <p
          role="status"
          className="rounded border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900"
        >
          {saved.already ? 'Already saved' : 'Saved'}:{' '}
          {formatPence(saved.amount)} from {saved.name}{' '}
          <Link
            to="/t/$slug/gifts/$giftId"
            params={{ slug: tenant.slug, giftId: saved.giftId }}
            className="underline"
          >
            (open)
          </Link>
        </p>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Donor</h2>
        {draft.donor === null ? (
          <DonorSearch onPick={pickDonor} inputRef={searchRef} />
        ) : (
          <DonorShown
            donor={draft.donor}
            info={shownInfo}
            problems={problems}
            onChange={(donor) => set({ donor })}
            onClear={() => {
              pickDonor(null)
              // After React shows the search box again.
              setTimeout(() => searchRef.current?.focus(), 0)
            }}
          />
        )}
        <FieldProblems problems={problems} of="contact" />
      </section>

      <section className="flex flex-col gap-1">
        <h2 className="text-sm font-medium">Source code</h2>
        <SourceCodePicker
          value={draft.code?.shown ?? null}
          onPick={(entry) =>
            set({
              code: {
                id: entry.versionId,
                shown: { ...entry, isActive: true },
              },
            })
          }
          onClear={() => set({ code: null })}
        />
        {differs && <span className="text-xs text-neutral-500">{differs}</span>}
        <FieldProblems problems={problems} of="sourceCode" />
        <FieldProblems problems={problems} of="allocations" />
      </section>

      <div className="flex flex-wrap gap-4">
        <label className={label}>
          Amount (£)
          <input
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={draft.amountText}
            onChange={(e) => set({ amountText: e.target.value })}
            className={`${field} w-32`}
          />
          <FieldProblems problems={problems} of="amount" />
        </label>
        <label className={label}>
          Date received
          <input
            type="date"
            value={draft.receivedOn}
            onChange={(e) => set({ receivedOn: e.target.value })}
            className={field}
          />
          <FieldProblems problems={problems} of="receivedOn" />
        </label>
      </div>
      {warnings.map((w) => (
        <Warning key={w.anchor}>{w.message}</Warning>
      ))}

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">Method</legend>
        <div className="flex flex-wrap gap-4 text-sm">
          {(['cash', 'card'] as const).map((m) => (
            <label key={m} className="flex items-center gap-2">
              <input
                type="radio"
                name="method"
                checked={draft.method === m}
                onChange={() => set({ method: m })}
              />
              {METHOD_LABELS[m]}
            </label>
          ))}
        </div>
        {draft.method === 'card' && (
          <label className={label}>
            <span>
              Reference{' '}
              <span className="text-xs text-neutral-500">
                (optional: the reader’s receipt or transaction id)
              </span>
            </span>
            <input
              type="text"
              value={draft.reference}
              onChange={(e) => set({ reference: e.target.value })}
              className={`${field} max-w-sm`}
            />
            <FieldProblems problems={problems} of="reference" />
          </label>
        )}
      </fieldset>

      {offer === 'covered' && shownInfo?.current && (
        <p className="text-sm text-emerald-800" data-testid="gift-aid">
          ✓ Gift Aid: covered by {describeDeclaration(shownInfo.current)}
        </p>
      )}
      {offer === 'none' && donorKind(draft.donor, shownInfo) !== undefined && (
        <p className="text-sm text-neutral-500" data-testid="gift-aid">
          Gift Aid is only for gifts from a person.
        </p>
      )}
      {offer === 'tick' && (
        <fieldset
          className="flex flex-col gap-3 rounded border border-neutral-200 p-3"
          data-testid="gift-aid"
        >
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={draft.giftAid}
              onChange={(e) => {
                const on = e.target.checked
                // A partial address on file prefills the fields to complete.
                const home = on && !onFile ? partialHome(shownInfo) : null
                set({
                  giftAid: on,
                  ...(home && !draft.line1 && !draft.postcode ? home : {}),
                })
              }}
            />
            Gift Aid declaration
          </label>
          {draft.giftAid && (
            <>
              <div className="flex flex-wrap gap-4">
                <label className={label}>
                  Covers
                  <select
                    value={draft.scope}
                    onChange={(e) =>
                      set({ scope: e.target.value as GiftDraft['scope'] })
                    }
                    className={field}
                  >
                    {(['futureAndPast4y', 'future', 'thisGift'] as const).map(
                      (s) => (
                        <option key={s} value={s}>
                          {SCOPE_LABELS[s]}
                        </option>
                      ),
                    )}
                  </select>
                </label>
                <label className={label}>
                  How it was made
                  <select
                    value={draft.declarationMethod}
                    onChange={(e) =>
                      set({ declarationMethod: e.target.value as TickMethod })
                    }
                    className={field}
                  >
                    {TICK_METHODS.map((m) => (
                      <option key={m.value} value={m.value}>
                        {DECLARATION_METHOD_LABELS[m.value]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {explain && (
                <p
                  className="text-xs text-neutral-600"
                  data-testid="tick-method-explained"
                >
                  {explain.explain}
                </p>
              )}
              {onFile ? (
                <p className="text-sm text-neutral-700">
                  Declared under their home address: {onFile.line1},{' '}
                  {onFile.postcode}
                </p>
              ) : (
                asksForAddress(draft, shownInfo) && (
                  <div className="flex flex-wrap gap-4">
                    <label className={label}>
                      House number or name, street
                      <input
                        type="text"
                        autoComplete="off"
                        value={draft.line1}
                        onChange={(e) => set({ line1: e.target.value })}
                        className={`${field} w-64`}
                      />
                      <FieldProblems problems={problems} of="line1" />
                    </label>
                    <label className={label}>
                      Postcode
                      <input
                        type="text"
                        autoComplete="off"
                        value={draft.postcode}
                        onChange={(e) => set({ postcode: e.target.value })}
                        className={`${field} w-28`}
                      />
                      <FieldProblems problems={problems} of="postcode" />
                    </label>
                  </div>
                )
              )}
              {addressWarning && <Warning>{addressWarning}</Warning>}
            </>
          )}
        </fieldset>
      )}

      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={saving || (existingId !== null && info === undefined)}
        className="self-start rounded bg-neutral-900 px-4 py-2 text-sm text-white hover:bg-neutral-700 disabled:opacity-50"
      >
        {saving ? 'Saving…' : 'Record gift'}
      </button>
    </form>
  )
}

type Option =
  | { kind: 'match'; row: SearchRow; numberMatch: boolean }
  | { kind: 'new'; contactKind: 'individual' | 'organization' }

type SearchRow = NonNullable<ReturnType<typeof useSearch>>['rows'][number]

function useSearch(text: string, open: boolean) {
  const tenant = useTenant()
  const term = text.trim()
  // Until the new answer comes, the last one stands (as the code picker).
  const now = useQuery(
    api.contacts.queries.search,
    open && term ? { tenantId: tenant._id, search: term } : 'skip',
  )
  const last = useRef(now)
  if (now !== undefined) last.current = now
  return term ? (now ?? last.current) : undefined
}

/**
 * The donor quick search (`contacts.search`): matches as you type, then
 * "New person" and "New organisation" filled in from the text (g1q3). A
 * contact found by its number is listed first and marked, but only a
 * pick (click or Enter) chooses it, never the search by itself (contact
 * numbers g2q5).
 */
export function DonorSearch({
  onPick,
  inputRef,
}: {
  onPick: (donor: DonorChoice) => void
  inputRef?: Ref<HTMLInputElement>
}) {
  const listId = useId()
  const [text, setText] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const found = useSearch(text, open)
  const term = text.trim()
  const options: Array<Option> = term
    ? [
        ...(found?.rows ?? []).slice(0, SHOWN_MATCHES).map((row) => ({
          kind: 'match' as const,
          row,
          numberMatch: found?.numberMatch === row._id,
        })),
        { kind: 'new', contactKind: 'individual' },
        { kind: 'new', contactKind: 'organization' },
      ]
    : []

  function pick(o: Option) {
    setOpen(false)
    setText('')
    setActive(0)
    onPick(
      o.kind === 'match'
        ? { kind: 'existing', id: o.row._id, displayName: o.row.displayName }
        : newDonor(o.contactKind, term),
    )
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      // Never submits the form from here.
      e.preventDefault()
      const o = options.at(active)
      if (open && o) pick(o)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setOpen(true)
      setActive((i) => Math.min(i + 1, Math.max(options.length - 1, 0)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  const more =
    (found?.rows.length ?? 0) > SHOWN_MATCHES || (found?.truncated ?? false)
  return (
    <div className="relative max-w-md">
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-label="Donor"
        aria-expanded={open && options.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        autoComplete="off"
        autoFocus
        value={text}
        placeholder="Name, email, phone, postcode or contact no."
        onChange={(e) => {
          setText(e.target.value)
          setActive(0)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        className="w-full rounded border border-neutral-300 px-3 py-1.5 text-sm"
      />
      {open && options.length > 0 && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Donor matches"
          className="absolute z-10 mt-1 max-h-96 w-full overflow-auto rounded border border-neutral-200 bg-white text-sm shadow"
        >
          {found === undefined && (
            <li className="px-3 py-2 text-neutral-500">Searching…</li>
          )}
          {found && found.rows.length === 0 && (
            <li className="px-3 py-2 text-neutral-500">
              {found.tooBroad
                ? 'Too many to look through: type more.'
                : (found.invalidNumber ?? 'No contacts match.')}
            </li>
          )}
          {options.map((o, i) => (
            <li
              key={o.kind === 'match' ? o.row._id : `new-${o.contactKind}`}
              role="option"
              aria-selected={i === active}
              // Keep focus in the input, so the click lands as a pick.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(o)}
              onMouseEnter={() => setActive(i)}
              className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 ${
                o.kind === 'new' ? 'border-t border-neutral-100' : ''
              } ${
                o.kind === 'match' && o.numberMatch
                  ? i === active
                    ? 'bg-emerald-100'
                    : 'bg-emerald-50'
                  : i === active
                    ? 'bg-neutral-100'
                    : ''
              }`}
            >
              {o.kind === 'match' ? (
                <>
                  <span className="flex-1 truncate">{o.row.displayName}</span>
                  {o.numberMatch && (
                    <span className="rounded bg-emerald-200 px-1.5 text-xs text-emerald-900">
                      contact no. {formatNumber(o.row.number)}
                    </span>
                  )}
                  {o.row.kind !== 'individual' && (
                    <span className="text-xs text-neutral-500">
                      {o.row.kind === 'organization'
                        ? 'organisation'
                        : 'household'}
                    </span>
                  )}
                  {o.row.email && (
                    <span className="truncate text-xs text-neutral-500">
                      {o.row.email}
                    </span>
                  )}
                </>
              ) : (
                <span>
                  {o.contactKind === 'individual'
                    ? 'New person'
                    : 'New organisation'}{' '}
                  <span className="text-neutral-500">“{term}”</span>
                </span>
              )}
            </li>
          ))}
          {more && (
            <li className="px-3 py-1.5 text-xs text-neutral-500">
              More contacts match: type more to narrow.
            </li>
          )}
        </ul>
      )}
    </div>
  )
}

/** The picked donor, or a new one's fields, with "Change" back to the search. */
function DonorShown({
  donor,
  info,
  problems,
  onChange,
  onClear,
}: {
  donor: DonorChoice
  info: DonorInfo | null | undefined
  problems: Array<Problem>
  onChange: (donor: DonorChoice) => void
  onClear: () => void
}) {
  const change = (
    <button
      type="button"
      onClick={onClear}
      className="text-sm text-neutral-500 underline hover:text-neutral-900"
    >
      Change
    </button>
  )
  if (donor.kind === 'existing') {
    return (
      <div
        className="flex flex-wrap items-baseline gap-3 text-sm"
        data-testid="donor"
      >
        <span className="font-medium">{donor.displayName}</span>
        {info?.kind && info.kind !== 'individual' && (
          <span className="text-xs text-neutral-500">
            {info.kind === 'organization' ? 'organisation' : 'household'}
          </span>
        )}
        {info === null && (
          <span className="text-xs text-red-700">
            This contact can’t be found
          </span>
        )}
        {change}
      </div>
    )
  }
  const typed = (patch: Partial<typeof donor>) =>
    onChange({ ...donor, ...patch })
  return (
    <div className="flex flex-col gap-2" data-testid="donor">
      <div className="flex items-baseline gap-3 text-sm">
        <span className="font-medium">
          {donor.contactKind === 'individual'
            ? 'New person'
            : 'New organisation'}
        </span>
        {change}
      </div>
      {donor.contactKind === 'individual' ? (
        <div className="flex flex-wrap gap-4">
          <label className={label}>
            First name
            <input
              type="text"
              value={donor.firstName}
              onChange={(e) => typed({ firstName: e.target.value })}
              className={field}
            />
            <FieldProblems problems={problems} of="firstName" />
          </label>
          <label className={label}>
            Last name
            <input
              type="text"
              value={donor.lastName}
              onChange={(e) => typed({ lastName: e.target.value })}
              className={field}
            />
            <FieldProblems problems={problems} of="lastName" />
          </label>
          <label className={label}>
            <span>
              Email <span className="text-xs text-neutral-500">(optional)</span>
            </span>
            <input
              type="email"
              value={donor.email}
              onChange={(e) => typed({ email: e.target.value })}
              className={field}
            />
            <FieldProblems problems={problems} of="email" />
          </label>
        </div>
      ) : (
        <label className={label}>
          Name
          <input
            type="text"
            value={donor.name}
            onChange={(e) => typed({ name: e.target.value })}
            className={`${field} max-w-md`}
          />
          <FieldProblems problems={problems} of="name" />
        </label>
      )}
    </div>
  )
}
