import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { ReadRefused, useStepUp } from '../components/claims-ui'
import { useHmrcDetails, useSaveHmrcDetails } from '../lib/data'
import type { HmrcDetails, HmrcDetailsView } from '../lib/data'
import { RustApiError } from '../lib/data/rust/client'
import type { CharityRegulator } from '../lib/data/rust-types/CharityRegulator'
import { refusal } from '../lib/gifts'
import { threeWayMerge } from '../lib/merge'
import { useIsAdmin } from '../lib/tenant'

export const Route = createFileRoute('/t/$slug/settings/hmrc')({
  component: HmrcDetailsPage,
})

const field = 'rounded border border-neutral-300 px-2 py-1 text-sm'

const REGULATORS: Array<[CharityRegulator, string]> = [
  ['ccew', 'Charity Commission for England and Wales'],
  ['ccni', 'Charity Commission for Northern Ireland'],
  ['oscr', 'Scottish Charity Regulator (OSCR)'],
  ['none', 'None (excepted or exempt)'],
]

/** The text fields, in the order the form shows them. */
const TEXT: Array<[Exclude<keyof HmrcDetails, 'regulator'>, string, string?]> =
  [
    ['hmrcReference', 'HMRC charity reference', 'Like AB12345'],
    ['regulatorNumber', 'Registered charity number'],
    ['officialTitle', 'Title', 'Mr, Mrs, Ms, Dr… (optional)'],
    ['officialFirstName', 'First name'],
    ['officialLastName', 'Last name'],
    ['officialPostcode', 'Postcode'],
    ['officialPhone', 'Phone'],
  ]

/**
 * Settings › HMRC details (G3, from G1's `giftaid.hmrcDetails`): the
 * charity's HMRC reference, its regulator and number, and the authorised
 * official who signs its claims. Admin only. Anything storable saves;
 * what HMRC would refuse shows as a warning (ADR 0015), and the claim
 * XML waits until there are none.
 */
function HmrcDetailsPage() {
  const admin = useIsAdmin()
  const details = useHmrcDetails(admin)
  if (!admin)
    return (
      <p className="text-sm text-neutral-600">
        The group’s HMRC details are for its admins.
      </p>
    )
  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">HMRC details</h2>
        <p className="mt-1 text-sm text-neutral-600">
          What a Gift Aid claim tells HMRC about the charity and who signs it.
        </p>
      </div>
      {details.error ? (
        <ReadRefused error={details.error} retry={details.refetch} />
      ) : details.data === undefined ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : (
        <DetailsForm view={details.data} reload={details.refetch} />
      )}
    </section>
  )
}

/** What the form edits, as the server last answered it. */
function detailsOf(view: HmrcDetailsView): HmrcDetails {
  return {
    hmrcReference: view.hmrcReference,
    regulator: view.regulator,
    regulatorNumber: view.regulatorNumber,
    officialTitle: view.officialTitle,
    officialFirstName: view.officialFirstName,
    officialLastName: view.officialLastName,
    officialPostcode: view.officialPostcode,
    officialPhone: view.officialPhone,
  }
}

const FIELD_NAMES: Record<keyof HmrcDetails, string> = {
  hmrcReference: 'HMRC reference',
  regulator: 'regulator',
  regulatorNumber: 'charity number',
  officialTitle: 'title',
  officialFirstName: 'first name',
  officialLastName: 'last name',
  officialPostcode: 'postcode',
  officialPhone: 'phone',
}

/**
 * The details, saved together against their version. Another admin's
 * save while this form is open is merged in field by field, as the gift
 * form does (lib/merge): a field only they changed takes their value,
 * one you changed keeps yours, and the form says which. `expected` moves
 * to their version, so Save then overwrites knowingly.
 */
function DetailsForm({
  view,
  reload,
}: {
  view: HmrcDetailsView
  reload: () => Promise<unknown>
}) {
  const save = useSaveHmrcDetails()
  const stepUp = useStepUp()
  const [expected, setExpected] = useState(view.version)
  // The server state the form was last reconciled against.
  const [base, setBase] = useState(() => detailsOf(view))
  const [values, setValues] = useState<HmrcDetails>(() => detailsOf(view))
  const [merged, setMerged] = useState<{
    changed: Array<keyof HmrcDetails>
    conflicts: Array<keyof HmrcDetails>
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)

  // Someone else saved: merge their version in (adjusting state while
  // rendering). Not mid-save, when the newer version may be our own.
  if (
    !busy &&
    view.version !== null &&
    (expected === null || view.version > expected)
  ) {
    const remote = detailsOf(view)
    const m = threeWayMerge(base, values, remote)
    const changed = (Object.keys(remote) as Array<keyof HmrcDetails>).filter(
      (k) => remote[k] !== base[k],
    )
    setValues(m.value)
    setMerged((was) => ({
      changed: [...new Set([...(was?.changed ?? []), ...changed])],
      conflicts: [...new Set([...(was?.conflicts ?? []), ...m.conflicts])],
    }))
    setBase(remote)
    setExpected(view.version)
    setSaved(false)
  }

  const set = (k: keyof HmrcDetails, v: string) => {
    setSaved(false)
    setValues((was) => ({ ...was, [k]: v }))
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSaved(false)
    setBusy(true)
    const sent = values
    try {
      await stepUp.run(async () => {
        const done = await save(expected, sent)
        // Our own save: its version is no one else's change.
        setExpected(done.counter)
        setBase(sent)
        setMerged(null)
        setSaved(true)
      })
    } catch (err) {
      setError(
        refusal(
          err,
          'Could not save the HMRC details',
          'Someone else saved these details just now: their change is merged in here. Check it, then save again',
        ),
      )
      if (err instanceof RustApiError && err.error.kind === 'stale')
        void reload()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <form
        aria-label="HMRC details"
        onSubmit={(e) => void submit(e)}
        className="flex flex-col gap-4"
      >
        {merged && (
          <div
            role="status"
            data-testid="hmrc-merged"
            className="flex flex-col gap-1 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-sm text-amber-900"
          >
            <p>
              Someone else saved these details while you were editing
              {merged.changed.length > 0 &&
                ` (${merged.changed.map((k) => FIELD_NAMES[k]).join(', ')})`}
              : their change has been merged in, and Save keeps your edits on
              top of it.
            </p>
            {merged.conflicts.length > 0 && (
              <p>
                Changed by both of you:{' '}
                {merged.conflicts.map((k) => FIELD_NAMES[k]).join(', ')}. Your
                value is kept — check it.
              </p>
            )}
          </div>
        )}
        {view.warnings.length > 0 && (
          <ul data-testid="hmrc-warnings" className="flex flex-col gap-1">
            {view.warnings.map((w) => (
              <li
                key={`${w.anchor}:${w.message}`}
                className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-sm text-amber-900"
              >
                {w.label ? `${w.label}: ${w.message}` : w.message}
              </li>
            ))}
          </ul>
        )}
        <label className="flex flex-col gap-1 text-sm">
          {TEXT[0][1]}
          <input
            value={values.hmrcReference}
            placeholder={TEXT[0][2]}
            onChange={(e) => set('hmrcReference', e.target.value)}
            className={`${field} w-48`}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Regulator
          <select
            value={values.regulator ?? ''}
            onChange={(e) => {
              setSaved(false)
              setValues((was) => ({
                ...was,
                regulator: (e.target.value || null) as CharityRegulator | null,
              }))
            }}
            className={`${field} w-96 max-w-full`}
          >
            <option value="">Not set</option>
            {REGULATORS.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {TEXT[1][1]}
          <input
            value={values.regulatorNumber}
            onChange={(e) => set('regulatorNumber', e.target.value)}
            className={`${field} w-48`}
          />
        </label>
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-sm font-medium">
            Authorised official
          </legend>
          {TEXT.slice(2).map(([k, label, hint]) => (
            <label key={k} className="flex flex-col gap-1 text-sm">
              {label}
              <input
                value={values[k]}
                placeholder={hint}
                onChange={(e) => set(k, e.target.value)}
                className={`${field} w-72`}
              />
            </label>
          ))}
        </fieldset>
        {error && (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        )}
        {saved && (
          <p role="status" className="text-sm text-neutral-700">
            Saved.
          </p>
        )}
        <button
          type="submit"
          disabled={busy}
          className="self-start rounded bg-neutral-900 px-3 py-1 text-sm text-white hover:bg-neutral-700 disabled:opacity-50"
        >
          Save
        </button>
      </form>
      {/* Outside the details form: it is a form itself, and Confirm must
        submit only it. */}
      {stepUp.form}
    </div>
  )
}
