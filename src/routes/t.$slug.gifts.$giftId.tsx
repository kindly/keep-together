import { Link, createFileRoute } from '@tanstack/react-router'
import { useConvex, useMutation, useQuery } from 'convex/react'
import type { FunctionReturnType } from 'convex/server'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { Doc, Id } from '../../convex/_generated/dataModel'
import { api } from '../../convex/_generated/api'
import { giftWarnings } from '../../convex/giving/warnings'
import type { Moment } from '../../convex/contacts/history'
import { ConfirmDialog } from '../components/confirm-dialog'
import {
  HistoryFeed,
  fetchHistoryPage,
  useHistoryPages,
} from '../components/contact-history'
import { SourceCodePicker, localToday } from '../components/source-code-picker'
import type { ShownCode } from '../components/source-code-picker'
import {
  METHOD_LABELS,
  formatDay,
  formatPence,
  parsePounds,
  penceToInput,
  refusal,
} from '../lib/gifts'
import {
  describeDeclaration,
  giftCoverage,
  useDeclarations,
} from '../lib/giftaid'
import { threeWayMerge } from '../lib/merge'
import { cachedTenant, useCanWrite, useTenant } from '../lib/tenant'

export const Route = createFileRoute('/t/$slug/gifts/$giftId')({
  component: GiftPage,
  loader: ({ context: { convex }, params }) => {
    const tenant = cachedTenant(convex, params.slug)
    if (!tenant) return
    convex.prewarmQuery({
      query: api.giving.queries.get,
      args: { tenantId: tenant._id, id: params.giftId as Id<'contributions'> },
    })
  },
})

type Gift = NonNullable<FunctionReturnType<typeof api.giving.queries.get>>

/** The gift page's history is never re-anchored mid-read: it is short. */
const atRest = () => true

const AT = new Intl.DateTimeFormat([], {
  dateStyle: 'short',
  timeStyle: 'short',
})

const field = 'rounded border border-neutral-300 px-2 py-1 text-sm'
const primary =
  'rounded bg-neutral-900 px-3 py-1 text-sm text-white hover:bg-neutral-700 disabled:opacity-50'
const secondary =
  'rounded border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 disabled:opacity-50'

/**
 * One gift (cash gifts step 5): what was given, its Gift Aid coverage
 * (derived from the donor's declarations, never stored on the gift), an
 * edit form, void / un-void, and its history. The donor can't change
 * (g3q2): a wrong donor is void and record again.
 */
function GiftPage() {
  const tenant = useTenant()
  const { giftId } = Route.useParams()
  const id = giftId as Id<'contributions'>
  const gift = useQuery(api.giving.queries.get, { tenantId: tenant._id, id })
  if (gift === undefined)
    return <main className="p-6 text-sm text-neutral-500">Loading…</main>
  if (gift === null) return <main className="p-6">No such gift.</main>
  // Keyed so an edit form or a void in progress never carries to another gift.
  return <GiftView key={`${tenant._id}:${id}`} gift={gift} />
}

function GiftView({ gift }: { gift: Gift }) {
  const tenant = useTenant()
  const canWrite = useCanWrite()
  const convex = useConvex()
  const members = useQuery(api.platform.tenants.members, {
    tenantId: tenant._id,
  })
  const declarations = useDeclarations(tenant._id, gift.contactId)
  // Fetched, not subscribed, as the contact's is: a subscribed history
  // would re-run on every save and hold up "saved" (ContactHistory).
  const feed = useMemo(
    () =>
      new HistoryFeed((paginationOpts) =>
        fetchHistoryPage(convex, api.giving.queries.history, {
          tenantId: tenant._id,
          id: gift._id,
          paginationOpts,
        }),
      ),
    [convex, tenant._id, gift._id],
  )
  const setStatus = useMutation(api.giving.mutations.setStatus)
  const [editing, setEditing] = useState(false)
  // The status change being confirmed, with the counter seen when asked.
  const [confirming, setConfirming] = useState<{
    status: Doc<'contributions'>['status']
    expected: number
  } | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const isVoid = gift.status === 'void'
  // "system" means an import or a webhook: never say it while loading.
  const name = (userId: Id<'users'> | null | undefined) =>
    members === undefined
      ? '…'
      : (members.find((m) => m.userId === userId)?.name ?? 'system')
  const warnings = giftWarnings(gift, localToday())
  const coverage = giftCoverage(declarations, gift)

  async function changeStatus(
    status: Doc<'contributions'>['status'],
    expected: number,
  ) {
    setStatusError(null)
    setBusy(true)
    feed.hold()
    try {
      await setStatus({ tenantId: tenant._id, id: gift._id, expected, status })
    } catch (err) {
      setStatusError(
        refusal(
          err,
          'Could not change the gift’s status',
          'Someone else changed this gift’s status just now: check it, then try again',
        ),
      )
    } finally {
      feed.release()
      setBusy(false)
    }
  }

  return (
    <main className="mx-auto grid max-w-5xl gap-8 p-6 md:grid-cols-[1fr_18rem]">
      <div className="flex flex-col gap-6">
        <header className="flex flex-col gap-1">
          <h1 className="flex flex-wrap items-baseline gap-2 text-xl font-semibold">
            <span className={isVoid ? 'text-neutral-500 line-through' : ''}>
              {formatPence(gift.amount)}
            </span>
            <span>from</span>
            {gift.contact ? (
              <Link
                to="/t/$slug/contacts/$contactId"
                params={{ slug: tenant.slug, contactId: gift.contactId }}
                className="underline"
              >
                {gift.contact.displayName}
              </Link>
            ) : (
              <span className="text-neutral-500">an unknown contact</span>
            )}
            {isVoid && (
              <span className="rounded bg-red-100 px-1.5 text-sm font-normal text-red-800">
                void
              </span>
            )}
          </h1>
          {isVoid && (
            <p className="text-sm text-neutral-600">
              Void: kept for the record, counts for nothing.
            </p>
          )}
        </header>

        {editing ? (
          <GiftEdit gift={gift} feed={feed} onDone={() => setEditing(false)} />
        ) : (
          <dl className="grid grid-cols-[9rem_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-neutral-500">Received</dt>
            <dd>{formatDay(gift.receivedOn)}</dd>
            <dt className="text-neutral-500">Amount</dt>
            <dd>{formatPence(gift.amount)}</dd>
            <dt className="text-neutral-500">Method</dt>
            <dd>{METHOD_LABELS[gift.method]}</dd>
            {gift.method === 'card' && (
              <>
                <dt className="text-neutral-500">Reference</dt>
                <dd>{gift.reference ?? '—'}</dd>
              </>
            )}
            <dt className="text-neutral-500">Source code</dt>
            <dd>
              <ul>
                {gift.allocations.map((a) => (
                  <li key={a.key} data-testid="gift-code">
                    {a.code ?? 'unknown code'}
                    {!a.isActive && a.code && (
                      <span className="ml-1 text-xs text-neutral-500">
                        (archived)
                      </span>
                    )}
                    {gift.allocations.length > 1 && (
                      <span className="ml-2 text-neutral-600">
                        {formatPence(a.amount)}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </dd>
            <dt className="text-neutral-500">Gift Aid</dt>
            <dd data-testid="gift-coverage">
              {gift.contact?.kind !== 'individual'
                ? 'Not for an organisation or household'
                : isVoid
                  ? 'None: a void gift is never claimed'
                  : coverage === undefined
                    ? '…'
                    : coverage
                      ? `✓ Covered by ${describeDeclaration(coverage)}`
                      : 'Not covered by a declaration'}
            </dd>
            <dt className="text-neutral-500">Entered by</dt>
            <dd>{name(gift.enteredBy)}</dd>
          </dl>
        )}

        {!editing && warnings.length > 0 && (
          <ul className="flex flex-col gap-1">
            {warnings.map((w) => (
              <li
                key={w.anchor}
                className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-sm text-amber-900"
              >
                {w.message}
              </li>
            ))}
          </ul>
        )}

        {canWrite && !editing && (
          <div className="flex gap-2">
            <button
              type="button"
              className={secondary}
              onClick={() => setEditing(true)}
            >
              Edit
            </button>
            {isVoid ? (
              <button
                type="button"
                className={secondary}
                disabled={busy}
                onClick={() =>
                  setConfirming({
                    status: 'completed',
                    expected: gift.statusVersion,
                  })
                }
              >
                Unvoid
              </button>
            ) : (
              <button
                type="button"
                className={secondary}
                disabled={busy}
                onClick={() =>
                  setConfirming({
                    status: 'void',
                    expected: gift.statusVersion,
                  })
                }
              >
                Void
              </button>
            )}
          </div>
        )}
        {statusError && (
          <p role="alert" className="text-sm text-red-700">
            {statusError}
          </p>
        )}
        <ConfirmDialog
          open={confirming !== null}
          {...(confirming?.status === 'completed'
            ? {
                title: 'Unvoid this gift?',
                description:
                  'It counts again, and Gift Aid can be claimed on it if a declaration covers it. You can void it again later.',
                confirm: 'Unvoid',
              }
            : {
                title: 'Void this gift?',
                description:
                  'It stays on record but counts for nothing. You can unvoid it later.',
                confirm: 'Void',
              })}
          cancel="Cancel"
          onConfirm={() => {
            if (!confirming) return
            setConfirming(null)
            void changeStatus(confirming.status, confirming.expected)
          }}
          onCancel={() => setConfirming(null)}
        />
      </div>
      <GiftHistory
        feed={feed}
        version={`${gift.giftVersion}:${gift.statusVersion}`}
        name={name}
      />
    </main>
  )
}

/** The code the edit form holds: the gift's, or one picked just now. */
type PickedCode = { id: Id<'sourceCodes'>; shown: ShownCode }

/** What the edit form holds, as compared field by field in a merge. */
type EditFields = {
  receivedOn: string
  amount: string
  method: Gift['method']
  reference: string
  code: Id<'sourceCodes'> | null
}

const FIELD_NAMES: Record<keyof EditFields, string> = {
  receivedOn: 'date',
  amount: 'amount',
  method: 'method',
  reference: 'reference',
  code: 'source code',
}

/** The single allocation's code as the form holds it. */
function pickedOf(gift: Gift): PickedCode | null {
  const single = gift.allocations.length === 1 ? gift.allocations[0] : null
  return single
    ? {
        id: single.sourceCodeId,
        shown: {
          code: single.code ?? 'unknown code',
          isActive: single.isActive,
          startDate: single.startDate,
          endDate: single.endDate,
        },
      }
    : null
}

function fieldsOf(gift: Gift): EditFields {
  return {
    receivedOn: gift.receivedOn,
    amount: penceToInput(gift.amount),
    method: gift.method,
    reference: gift.reference ?? '',
    code: pickedOf(gift)?.id ?? null,
  }
}

/**
 * The gift's fields, saved together against `giftVersion`. Someone else's
 * edit while the form is open is merged in field by field, as the contact
 * form does (lib/merge): a field only they changed takes their value, one
 * you changed keeps yours, and the form says which fields changed and
 * which you both changed. `expected` moves to their version, so Save then
 * overwrites knowingly; a save that raced their edit is refused as stale
 * and retries the same way once it arrives. A gift split across several
 * codes keeps its amount and split (there is no split entry).
 */
function GiftEdit({
  gift,
  feed,
  onDone,
}: {
  gift: Gift
  feed: HistoryFeed
  onDone: () => void
}) {
  const tenant = useTenant()
  const save = useMutation(api.giving.mutations.save)
  const single = gift.allocations.length === 1 ? gift.allocations[0] : null
  const [expected, setExpected] = useState(gift.giftVersion)
  // The server state the form was last reconciled against.
  const [base, setBase] = useState(() => fieldsOf(gift))
  const [receivedOn, setReceivedOn] = useState(gift.receivedOn)
  const [amountText, setAmountText] = useState(penceToInput(gift.amount))
  const [method, setMethod] = useState(gift.method)
  const [reference, setReference] = useState(gift.reference ?? '')
  const [code, setCode] = useState<PickedCode | null>(() => pickedOf(gift))
  const [merged, setMerged] = useState<{
    changed: Array<keyof EditFields>
    conflicts: Array<keyof EditFields>
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const first = useRef<HTMLInputElement>(null)
  useEffect(() => first.current?.focus(), [])

  // Someone else saved: merge their version in (adjusting state while
  // rendering, as React advises). Not mid-save, when the newer version may
  // be our own write coming back; the form closes when that resolves.
  if (!saving && gift.giftVersion > expected) {
    const remote = fieldsOf(gift)
    const m = threeWayMerge(
      base,
      {
        receivedOn,
        amount: amountText,
        method,
        reference,
        code: code?.id ?? null,
      },
      remote,
    )
    setReceivedOn(m.value.receivedOn)
    setAmountText(m.value.amount)
    setMethod(m.value.method)
    setReference(m.value.reference)
    if (m.value.code !== (code?.id ?? null)) setCode(pickedOf(gift))
    const changed = (Object.keys(remote) as Array<keyof EditFields>).filter(
      (k) => remote[k] !== base[k],
    )
    setMerged((was) => ({
      changed: [...new Set([...(was?.changed ?? []), ...changed])],
      conflicts: [...new Set([...(was?.conflicts ?? []), ...m.conflicts])],
    }))
    setBase(remote)
    setExpected(gift.giftVersion)
    setError(null)
  }

  const amount = single ? parsePounds(amountText) : gift.amount
  const warnings =
    amount !== null && receivedOn
      ? giftWarnings({ receivedOn, amount }, localToday())
      : []

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (amount === null) {
      setError('Enter the amount in pounds, like 20 or 20.50')
      return
    }
    // Said here once: the server would refuse both the amount and its one
    // share, which reads as the same problem twice.
    if (amount <= 0n) {
      setError('The amount must be over £0')
      return
    }
    if (single && !code) {
      setError('Pick a source code')
      return
    }
    setError(null)
    setSaving(true)
    feed.hold()
    try {
      await save({
        tenantId: tenant._id,
        id: gift._id,
        expected,
        contactId: gift.contactId,
        receivedOn,
        amount,
        method,
        reference: method === 'card' ? reference : undefined,
        allocations: single
          ? [{ key: single.key, sourceCodeId: code!.id, amount }]
          : gift.allocations.map((a) => ({
              key: a.key,
              sourceCodeId: a.sourceCodeId,
              amount: a.amount,
            })),
      })
      onDone()
    } catch (err) {
      setError(
        refusal(
          err,
          'Could not save the gift',
          'Someone else changed this gift just now: their change is merged in here as it arrives. Check it, then save again',
        ),
      )
    } finally {
      feed.release()
      setSaving(false)
    }
  }

  return (
    <form
      onSubmit={(e) => void submit(e)}
      aria-label="Edit gift"
      className="flex flex-col gap-4"
    >
      {merged && (
        <div
          role="status"
          className="flex flex-col gap-1 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-sm text-amber-900"
        >
          <p data-testid="gift-merged">
            Someone else changed this gift while you were editing
            {merged.changed.length > 0 &&
              ` (${merged.changed.map((k) => FIELD_NAMES[k]).join(', ')})`}
            : their change has been merged in, and Save keeps your edits on top
            of it.
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
      <label className="flex flex-col gap-1 text-sm">
        Received
        <input
          ref={first}
          type="date"
          required
          aria-describedby="gift-edit-warnings"
          value={receivedOn}
          onChange={(e) => setReceivedOn(e.target.value)}
          className={`${field} w-48`}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Amount (£)
        <input
          inputMode="decimal"
          value={amountText}
          onChange={(e) => setAmountText(e.target.value)}
          disabled={!single}
          aria-describedby={
            single ? 'gift-edit-warnings' : 'gift-edit-warnings gift-split-hint'
          }
          className={`${field} w-48`}
        />
        {!single && (
          <span id="gift-split-hint" className="text-xs text-neutral-500">
            Split across several codes: the amount can’t be changed here.
          </span>
        )}
      </label>
      <fieldset className="flex flex-col gap-1 text-sm">
        <legend className="mb-1">Method</legend>
        {(['cash', 'card'] as const).map((m) => (
          <label key={m} className="flex items-center gap-2">
            <input
              type="radio"
              name="method"
              checked={method === m}
              onChange={() => setMethod(m)}
            />
            {METHOD_LABELS[m]}
          </label>
        ))}
      </fieldset>
      {method === 'card' && (
        <label className="flex flex-col gap-1 text-sm">
          Reference
          <input
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="Receipt or transaction id (optional)"
            className={`${field} w-72`}
          />
        </label>
      )}
      {single ? (
        <SourceCodePicker
          value={code?.shown ?? null}
          onPick={(entry) =>
            setCode({
              id: entry.versionId,
              shown: {
                code: entry.code,
                isActive: true,
                startDate: entry.startDate,
                endDate: entry.endDate,
              },
            })
          }
          onClear={() => setCode(null)}
          disabled={saving}
        />
      ) : (
        <p className="text-sm text-neutral-600">
          Source codes:{' '}
          {gift.allocations
            .map((a) => `${a.code ?? 'unknown code'} ${formatPence(a.amount)}`)
            .join(', ')}
        </p>
      )}
      {/* Always there, so a warning appearing as you type is announced. */}
      <div id="gift-edit-warnings" aria-live="polite">
        {warnings.length > 0 && (
          <ul className="flex flex-col gap-1">
            {warnings.map((w) => (
              <li
                key={w.anchor}
                className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-sm text-amber-900"
              >
                {w.message}
              </li>
            ))}
          </ul>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button type="submit" className={primary} disabled={saving}>
          Save
        </button>
        <button
          type="button"
          className={secondary}
          disabled={saving}
          onClick={onDone}
        >
          Cancel
        </button>
      </div>
    </form>
  )
}

/** The gift's history, newest first: who changed what, when. */
function GiftHistory({
  feed,
  version,
  name,
}: {
  feed: HistoryFeed
  /** Changes with either counter: fetch the history again. */
  version: string
  name: (userId: Id<'users'> | null) => string
}) {
  const { moments, loading, loadOlder, error, retry, olderError, retryOlder } =
    useHistoryPages(feed, version, atRest)
  return (
    <aside className="flex flex-col gap-4 text-sm">
      <h2 className="text-lg font-medium">History</h2>
      {error && (
        <p role="alert" className="text-red-700">
          History couldn’t load.{' '}
          <button type="button" onClick={retry} className="underline">
            Retry
          </button>
        </p>
      )}
      {moments === undefined ? (
        !error && <p className="text-neutral-500">Loading…</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {moments.map((m: Moment, i) => (
            <li
              key={m.key}
              data-revision={m.revisionId}
              className="rounded border border-neutral-200 bg-white p-2"
            >
              <div className="flex items-baseline justify-between gap-2">
                <time className="text-neutral-600">{AT.format(m.at)}</time>
                {i === 0 && (
                  <span className="rounded bg-neutral-200 px-1 text-xs">
                    current
                  </span>
                )}
              </div>
              <div className="text-neutral-700">
                {m.groupName ?? m.slices.join(', ')} · {name(m.actor)}
              </div>
              {m.groupName && (
                <div className="text-xs text-neutral-500">
                  {m.slices.join(', ')}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
      {loading && <p className="text-neutral-500">Loading…</p>}
      {olderError && (
        <p role="alert" className="text-red-700">
          Older history couldn’t load.{' '}
          <button type="button" onClick={retryOlder} className="underline">
            Retry
          </button>
        </p>
      )}
      {loadOlder && (
        <button
          type="button"
          onClick={loadOlder}
          className="self-start text-xs text-neutral-600 underline"
        >
          Load older
        </button>
      )}
    </aside>
  )
}
