import { useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useEffect, useId, useRef, useState } from 'react'
import type {
  FormEvent,
  InputHTMLAttributes,
  KeyboardEvent,
  ReactNode,
  Ref,
} from 'react'
import type { Id } from '../lib/domain/ids'
import { formatNumber } from '../lib/domain/contacts'
import { giftWarnings } from '../lib/domain/warnings'
import {
  METHOD_LABELS as DECLARATION_METHOD_LABELS,
  SCOPE_LABELS,
  describeDeclaration,
} from '../lib/giftaid'
import {
  amountPence,
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
import {
  fetchGift,
  useContactSearch,
  useDonor,
  useRecordGift,
} from '../lib/data'
import { RustApiError } from '../lib/data/rust/client'
import { METHOD_LABELS, formatPence, refusal } from '../lib/gifts'
import { useTenant } from '../lib/tenant'
import { useReportUnsaved } from '../lib/unsaved'
import { ScanWithPhone } from './scans'
import { SourceCodePicker, localToday } from './source-code-picker'

const fieldClass = 'rounded border border-neutral-300 px-2 py-1.5 text-sm'
const label = 'flex flex-col gap-1 text-sm text-neutral-700'

/** How many search matches the donor box lists. */
const SHOWN_MATCHES = 8

/**
 * The fields a problem can name, in the order the form shows them: the
 * first one with a problem takes focus when a save is refused.
 */
const FIELD_ORDER = [
  'contact',
  'firstName',
  'lastName',
  'name',
  'email',
  'sourceCode',
  'allocations',
  'amount',
  'receivedOn',
  'reference',
  'line1',
  'postcode',
]

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

/** The id of a field's input, and of its problem line. */
const fieldId = (form: string, of: string) => `${form}-${of}`
const problemId = (form: string, of: string) => `${form}-${of}-problem`

/** A field's problems, as one line its input points at (`aria-describedby`). */
function FieldProblems({
  problems,
  of,
  form,
}: {
  problems: Array<Problem>
  of: string
  form: string
}) {
  const mine = problems.filter((p) => p.field === of)
  if (!mine.length) return null
  return (
    <span id={problemId(form, of)} className="text-xs text-red-700">
      {mine.map((p) => p.message).join(' ')}
    </span>
  )
}

/** What an input carries when `of` has problems. */
function invalidProps(problems: Array<Problem>, of: string, form: string) {
  return problems.some((p) => p.field === of)
    ? {
        'aria-invalid': true as const,
        'aria-describedby': problemId(form, of),
      }
    : {}
}

/**
 * A labelled text input with its problems under it, outside the label so
 * they aren't part of the field's name.
 */
function TextField({
  form,
  of,
  label: text,
  problems,
  className,
  ...input
}: {
  form: string
  of: string
  label: ReactNode
  problems: Array<Problem>
} & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className={label}>
      <label htmlFor={fieldId(form, of)}>{text}</label>
      <input
        id={fieldId(form, of)}
        type="text"
        className={`${fieldClass} ${className ?? ''}`}
        {...invalidProps(problems, of, form)}
        {...input}
      />
      <FieldProblems problems={problems} of={of} form={form} />
    </div>
  )
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
  /** Unknown only when an already-saved gift couldn't be read back. */
  amount: bigint | null
  name: string | null
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
 * one is minted only once a save has landed. A retry that finds its gift
 * already saved says what the stored gift is, read back from the server,
 * not what the form holds now.
 */
export function GiftForm() {
  const tenant = useTenant()
  const qc = useQueryClient()
  const form = useId()
  const today = localToday()
  const record = useRecordGift()
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
  const codeRef = useRef<HTMLInputElement>(null)

  const existingId = draft.donor?.kind === 'existing' ? draft.donor.id : null
  // Coverage is judged on the gift's date (an empty date input: today).
  const fetched = useDonor(existingId, draft.receivedOn || today)
  // While a changed date is re-read, the donor's last answer stays on
  // screen; saving waits for the fresh one.
  const last = useRef<{ id: Id<'contacts'>; info: DonorInfo | null } | null>(
    null,
  )
  if (fetched !== undefined && existingId)
    last.current = { id: existingId, info: fetched }
  const shownInfo = existingId
    ? (fetched ??
      (last.current?.id === existingId ? last.current.info : undefined))
    : undefined
  const infoReady = existingId === null || fetched !== undefined

  // The donor's own code fills an empty code once their details arrive
  // (g2q1). A code staff picked first stays.
  const defaulted = useRef<Id<'contacts'> | null>(null)
  useEffect(() => {
    if (!fetched || !existingId || defaulted.current === existingId) return
    defaulted.current = existingId
    setDraft((d) => (d.code ? d : { ...d, code: defaultCode(fetched) }))
  }, [fetched, existingId])

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

  /** Refused: say so in the alert, and take the user to the first field. */
  function refuse(found: Array<Problem>) {
    setProblems(found)
    setError(`Not saved: ${found.map((p) => p.message).join('; ')}`)
    const first = FIELD_ORDER.find((f) => found.some((p) => p.field === f))
    // After React has rendered the problems (and any field they open).
    setTimeout(() => {
      if (first === 'contact') searchRef.current?.focus()
      else if (first === 'sourceCode' || first === 'allocations')
        codeRef.current?.focus()
      else if (first) document.getElementById(fieldId(form, first))?.focus()
    }, 0)
  }

  const pence = amountPence(draft.amountText)
  const warnings =
    typeof pence === 'bigint' && pence > 0n && draft.receivedOn
      ? giftWarnings({ receivedOn: draft.receivedOn, amount: pence }, today)
      : []
  const offer = giftAidOffer(draft.donor, shownInfo)
  const onFile = homeOnFile(draft.donor, shownInfo)
  const addressWarning = noAddressWarning(draft, shownInfo)
  const differs = differsNote(draft, shownInfo)
  const explain = TICK_METHODS.find((m) => m.value === draft.declarationMethod)

  /** The stored gift a repeated save names, as the "Saved" line shows it. */
  async function readBack(giftId: Id<'contributions'>): Promise<Saved> {
    try {
      const gift = await fetchGift(qc, tenant.slug, giftId)
      return {
        giftId,
        amount: gift?.amount ?? null,
        name: gift?.contact?.displayName ?? null,
        already: true,
      }
    } catch {
      return { giftId, amount: null, name: null, already: true }
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (inFlight.current) return
    // An existing donor's Gift Aid state must be known before saving.
    if (!infoReady) return
    const found = draftProblems(draft, shownInfo)
    if (found.length) return refuse(found)
    setProblems([])
    setError(null)
    const args = toArgs(draft, shownInfo, clientKey)
    const done = (next: Saved) => {
      const blank = freshDraft(today, draft)
      setSaved(next)
      setDraft(blank)
      setFresh(blank)
      setClientKey(crypto.randomUUID())
      defaulted.current = null
      searchRef.current?.focus()
    }
    inFlight.current = true
    setSaving(true)
    try {
      const { giftId } = await record(args)
      done({
        giftId: giftId as Id<'contributions'>,
        amount: args.amount,
        name: donorName(draft.donor!),
        already: false,
      })
    } catch (err) {
      const refused = err instanceof RustApiError ? err.error : null
      if (refused?.kind === 'duplicate') {
        // A repeat of a save that landed: it names the gift.
        done(await readBack(refused.id as Id<'contributions'>))
      } else if (refused?.kind === 'invalid' && refused.problems.length) {
        refuse(refused.problems)
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
          {saved.already ? 'Already saved' : 'Saved'}
          {saved.amount !== null && `: ${formatPence(saved.amount)}`}
          {saved.name !== null && ` from ${saved.name}`}{' '}
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
        <h2 className="text-sm font-medium" id={`${form}-donor`}>
          Donor
        </h2>
        {draft.donor === null ? (
          <DonorSearch
            onPick={pickDonor}
            inputRef={searchRef}
            id={fieldId(form, 'contact')}
            {...invalidProps(problems, 'contact', form)}
          />
        ) : (
          <DonorShown
            form={form}
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
        <FieldProblems problems={problems} of="contact" form={form} />
      </section>

      <section className="flex flex-col gap-1">
        <h2 className="text-sm font-medium">Source code</h2>
        <SourceCodePicker
          value={draft.code?.shown ?? null}
          inputRef={codeRef}
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
        <FieldProblems problems={problems} of="sourceCode" form={form} />
        <FieldProblems problems={problems} of="allocations" form={form} />
      </section>

      <div className="flex flex-wrap gap-4">
        <TextField
          form={form}
          of="amount"
          label="Amount (£)"
          problems={problems}
          inputMode="decimal"
          autoComplete="off"
          value={draft.amountText}
          onChange={(e) => set({ amountText: e.target.value })}
          className="w-32"
        />
        <TextField
          form={form}
          of="receivedOn"
          label="Date received"
          problems={problems}
          type="date"
          value={draft.receivedOn}
          onChange={(e) => set({ receivedOn: e.target.value })}
        />
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
          <TextField
            form={form}
            of="reference"
            problems={problems}
            label={
              <>
                Reference{' '}
                <span className="text-xs text-neutral-500">
                  (optional: the reader’s receipt or transaction id)
                </span>
              </>
            }
            value={draft.reference}
            onChange={(e) => set({ reference: e.target.value })}
            className="max-w-sm"
          />
        )}
      </fieldset>

      {offer === 'covered' && shownInfo?.covering && (
        <p className="text-sm text-emerald-800" data-testid="gift-aid">
          ✓ Gift Aid: covered by {describeDeclaration(shownInfo.covering)}
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
                    className={fieldClass}
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
                    className={fieldClass}
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
              {/* The form in hand, scanned now and matched to the
                  declaration this save records (declaration scans g2q3):
                  only a paper form's, as only that can hold a scan. */}
              {draft.declarationMethod === 'paperForm' && (
                <div className="flex flex-col gap-1">
                  <ScanWithPhone
                    purpose="gift"
                    contactId={existingId ?? undefined}
                  />
                  <p className="text-xs text-neutral-500">
                    Scans wait in Scans to match: once the gift is saved, match
                    them to its paper declaration there or on the donor’s page.
                  </p>
                </div>
              )}
              {onFile && existingId ? (
                <p className="text-sm text-neutral-700">
                  Declared under their home address: {onFile.line1},{' '}
                  {onFile.postcode}{' '}
                  <Link
                    to="/t/$slug/contacts/$contactId"
                    params={{ slug: tenant.slug, contactId: existingId }}
                    target="_blank"
                    rel="noopener"
                    className="text-neutral-500 underline hover:text-neutral-900"
                  >
                    (change it on their contact page)
                  </Link>
                </p>
              ) : (
                asksForAddress(draft, shownInfo) && (
                  <div className="flex flex-wrap gap-4">
                    <TextField
                      form={form}
                      of="line1"
                      label="House number or name, street"
                      problems={problems}
                      autoComplete="off"
                      value={draft.line1}
                      onChange={(e) => set({ line1: e.target.value })}
                      className="w-64"
                    />
                    <TextField
                      form={form}
                      of="postcode"
                      label="Postcode"
                      problems={problems}
                      autoComplete="off"
                      value={draft.postcode}
                      onChange={(e) => set({ postcode: e.target.value })}
                      className="w-28"
                    />
                  </div>
                )
              )}
              {addressWarning && <Warning>{addressWarning}</Warning>}
            </>
          )}
        </fieldset>
      )}

      {/* Always in the page, so a refusal is announced when it appears. */}
      <p role="alert" className="text-sm text-red-700 empty:hidden">
        {error}
      </p>
      <button
        type="submit"
        disabled={saving || !infoReady}
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

type SearchRow = NonNullable<
  ReturnType<typeof useSearch>['result']
>['rows'][number]

/**
 * `contacts.search` for `term`. Until the answer for `term` comes, the
 * last answer stays on screen (as the code picker does), but `fresh` is
 * false: those rows answer an older term.
 */
function useSearch(term: string, open: boolean) {
  const now = useContactSearch(open && term ? { search: term } : 'skip')
  const last = useRef(now)
  if (now !== undefined) last.current = now
  if (!term) return { result: undefined, fresh: false }
  return { result: now ?? last.current, fresh: now !== undefined }
}

/**
 * The donor quick search (`contacts.search`): matches as you type, each
 * with its contact number (contact numbers g1q4), then "New person" and
 * "New organisation" filled in from the text (g1q3). A contact found by
 * its number is listed first and marked, but only a pick (click or
 * Enter) chooses it, never the search by itself (g2q5).
 *
 * Enter picks only from results that answer what is typed now: while
 * they are loading, or still the last term's, it does nothing and says
 * so. Otherwise a fast typist's Enter could pick "New person" (a
 * duplicate contact) or the previous number's contact.
 */
export function DonorSearch({
  onPick,
  inputRef,
  id,
  existingOnly = false,
  ...invalid
}: {
  onPick: (donor: DonorChoice) => void
  inputRef?: Ref<HTMLInputElement>
  id?: string
  /** Matches only: no "New person" or "New organisation". */
  existingOnly?: boolean
  'aria-invalid'?: true
  'aria-describedby'?: string
}) {
  const listId = useId()
  const [text, setText] = useState('')
  const [open, setOpen] = useState(false)
  const [waitHint, setWaitHint] = useState(false)
  const term = text.trim()
  const { result: found, fresh } = useSearch(term, open)
  // The highlighted option, held against the answer it was moved in: when
  // new rows arrive it is back on the first, so it can never land on a
  // different contact at the same position.
  const [cursor, setCursor] = useState({ i: 0, of: found })
  const active = cursor.of === found ? cursor.i : 0
  const setActive = (next: number | ((i: number) => number)) =>
    setCursor({
      i: typeof next === 'function' ? next(active) : next,
      of: found,
    })
  const options: Array<Option> = term
    ? [
        ...(found?.rows ?? []).slice(0, SHOWN_MATCHES).map((row) => ({
          kind: 'match' as const,
          row,
          // Never marked from an older term's answer.
          numberMatch: fresh && found?.numberMatch === row._id,
        })),
        ...(existingOnly
          ? []
          : ([
              { kind: 'new', contactKind: 'individual' },
              { kind: 'new', contactKind: 'organization' },
            ] as const)),
      ]
    : []
  const shown = open && options.length > 0
  const optionId = (i: number) => `${listId}-${i}`

  function pick(o: Option) {
    setOpen(false)
    setText('')
    setActive(0)
    setWaitHint(false)
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
      if (!open || !term) return
      if (!fresh) {
        setWaitHint(true)
        return
      }
      const o = options.at(active)
      if (o) pick(o)
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
    fresh &&
    ((found?.rows.length ?? 0) > SHOWN_MATCHES || (found?.truncated ?? false))
  return (
    <div className="relative max-w-md">
      <input
        ref={inputRef}
        id={id}
        type="text"
        role="combobox"
        aria-label="Donor"
        aria-expanded={shown}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          shown && options.at(active) ? optionId(active) : undefined
        }
        {...invalid}
        autoComplete="off"
        autoFocus
        value={text}
        placeholder="Name, email, phone, postcode or contact no."
        onChange={(e) => {
          setText(e.target.value)
          setActive(0)
          setOpen(true)
          setWaitHint(false)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        className="w-full rounded border border-neutral-300 px-3 py-1.5 text-sm"
      />
      {shown && (
        <div className="absolute z-10 mt-1 w-full rounded border border-neutral-200 bg-white text-sm shadow">
          <p
            role="status"
            className="px-3 py-1.5 text-xs text-neutral-500 empty:hidden"
          >
            {!fresh
              ? waitHint
                ? 'Still searching: press Enter again once the results show.'
                : 'Searching…'
              : found && found.rows.length === 0
                ? found.tooBroad
                  ? 'Too many to look through: type more.'
                  : (found.invalidNumber ?? 'No contacts match.')
                : ''}
          </p>
          <ul
            id={listId}
            role="listbox"
            aria-label="Donor matches"
            className={`max-h-96 overflow-auto ${fresh ? '' : 'opacity-60'}`}
          >
            {options.map((o, i) => (
              <li
                key={o.kind === 'match' ? o.row._id : `new-${o.contactKind}`}
                id={optionId(i)}
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
                    <span
                      className={`rounded px-1.5 text-xs ${
                        o.numberMatch
                          ? 'bg-emerald-200 text-emerald-900'
                          : 'text-neutral-500'
                      }`}
                    >
                      contact no. {formatNumber(o.row.number)}
                    </span>
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
          </ul>
          {more && (
            <p className="px-3 py-1.5 text-xs text-neutral-500">
              More contacts match: type more to narrow.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

/** The picked donor, or a new one's fields, with "Change" back to the search. */
function DonorShown({
  form,
  donor,
  info,
  problems,
  onChange,
  onClear,
}: {
  form: string
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
          <TextField
            form={form}
            of="firstName"
            label="First name"
            problems={problems}
            value={donor.firstName}
            onChange={(e) => typed({ firstName: e.target.value })}
          />
          <TextField
            form={form}
            of="lastName"
            label="Last name"
            problems={problems}
            value={donor.lastName}
            onChange={(e) => typed({ lastName: e.target.value })}
          />
          <TextField
            form={form}
            of="email"
            label={
              <>
                Email{' '}
                <span className="text-xs text-neutral-500">(optional)</span>
              </>
            }
            problems={problems}
            type="email"
            value={donor.email}
            onChange={(e) => typed({ email: e.target.value })}
          />
        </div>
      ) : (
        <TextField
          form={form}
          of="name"
          label="Name"
          problems={problems}
          value={donor.name}
          onChange={(e) => typed({ name: e.target.value })}
          className="max-w-md"
        />
      )}
    </div>
  )
}
