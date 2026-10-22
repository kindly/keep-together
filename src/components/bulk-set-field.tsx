import { useMutation } from 'convex/react'
import { ConvexError } from 'convex/values'
import { useState } from 'react'
import type { Id } from '../../convex/_generated/dataModel'
import { api } from '../../convex/_generated/api'
import type { FieldDefinition } from '../../convex/contacts/fieldTypes'
import { BULK_FIELD_LIMIT } from '../../convex/contacts/rules'
import { useTenant } from '../lib/tenant'

/** "clear" in the value select ('' is "not chosen yet"). */
const CLEAR = 'none'

export type BulkFieldState =
  | { state: 'idle' }
  | { state: 'running'; done: number; total: number }
  | { state: 'done'; message: string }
  | { state: 'failed'; message: string }

/** A user-facing line for a failed bulk mutation. */
export function bulkFailure(err: unknown, fallback: string): string {
  if (!(err instanceof ConvexError)) return fallback
  const d = err.data as {
    kind?: string
    message?: string
    problems?: Array<{ message: string }>
  }
  if (d.kind === 'invalid' && d.problems?.length)
    return d.problems.map((p) => p.message).join('; ')
  if (d.kind === 'stale')
    return 'Someone else changed one of these contacts just now; try again'
  return d.message ?? d.kind ?? fallback
}

const contacts = (n: number) => `${n} contact${n === 1 ? '' : 's'}`

/**
 * A bulk "set field" run and its result, held by the list page itself:
 * setting a value moves the changed rows out of a list filtered on that
 * field, so the selection (and the bar showing it) can empty mid-run. The
 * run carries on over the ids it started with, and its result stays until
 * dismissed or the next run. Each batch of BULK_FIELD_LIMIT is one
 * all-or-nothing `bulkSetField` (one command group); contacts of a kind
 * the field doesn't apply to are skipped by the server and counted.
 */
export function useBulkSetField() {
  const tenant = useTenant()
  const bulkSetField = useMutation(api.contacts.mutations.bulkSetField)
  const [bulk, setBulk] = useState<BulkFieldState>({ state: 'idle' })

  async function run(
    chosen: Array<Id<'contacts'>>,
    field: FieldDefinition,
    optionId: Id<'contactFieldOptions'> | null,
  ) {
    const label = field.options.find((o) => o._id === optionId)?.label
    const ids = [...chosen]
    let changed = 0
    let skipped = 0
    const tally = () =>
      skipped > 0 ? `; skipped ${skipped} of a kind it doesn’t apply to` : ''
    setBulk({ state: 'running', done: 0, total: ids.length })
    try {
      for (let i = 0; i < ids.length; i += BULK_FIELD_LIMIT) {
        const batch = ids.slice(i, i + BULK_FIELD_LIMIT)
        const result = await bulkSetField({
          tenantId: tenant._id,
          contactIds: batch,
          fieldId: field._id,
          optionId,
        })
        changed += result.changed
        skipped += result.skipped
        setBulk({ state: 'running', done: i + batch.length, total: ids.length })
      }
      setBulk({
        state: 'done',
        message:
          (optionId === null
            ? `Cleared “${field.label}” on ${contacts(changed)}`
            : `Set “${field.label}” to “${label ?? '?'}” on ${contacts(changed)}`) +
          tally(),
      })
    } catch (err) {
      const soFar =
        changed > 0 || skipped > 0
          ? ` (before it stopped: ${contacts(changed)} changed${tally()})`
          : ''
      setBulk({
        state: 'failed',
        message: `${bulkFailure(err, 'Could not set the field')}${soFar}`,
      })
    }
  }

  return {
    bulk,
    run,
    dismiss: () => setBulk({ state: 'idle' }),
  }
}

/**
 * The field and value pickers and the button, for the selected rows. The
 * run itself is the page's (`useBulkSetField`).
 */
export function BulkFieldControls({
  chosen,
  fields,
  running,
  onRun,
}: {
  chosen: Array<Id<'contacts'>>
  /** Fields a value can be set on: active, not being retired. */
  fields: Array<FieldDefinition>
  running: boolean
  onRun: (
    chosen: Array<Id<'contacts'>>,
    field: FieldDefinition,
    optionId: Id<'contactFieldOptions'> | null,
  ) => void
}) {
  const [fieldId, setFieldId] = useState<Id<'contactFields'> | ''>('')
  // '' until chosen; CLEAR clears.
  const [optionId, setOptionId] = useState<string>('')
  const field = fields.find((f) => f._id === fieldId)
  const options = field?.options.filter((o) => o.isActive) ?? []
  return (
    <>
      <select
        aria-label="Field to set"
        value={fieldId}
        disabled={running}
        onChange={(e) => {
          setFieldId(e.target.value as Id<'contactFields'> | '')
          setOptionId('')
        }}
        className="rounded border border-neutral-300 px-2 py-1"
      >
        <option value="">choose field…</option>
        {fields.map((f) => (
          <option key={f._id} value={f._id}>
            {f.label}
          </option>
        ))}
      </select>
      {field && (
        <select
          aria-label={`Value for ${field.label}`}
          value={optionId}
          disabled={running}
          onChange={(e) => setOptionId(e.target.value)}
          className="rounded border border-neutral-300 px-2 py-1"
        >
          <option value="">choose value…</option>
          {options.map((o) => (
            <option key={o._id} value={o._id}>
              {o.label}
            </option>
          ))}
          <option value={CLEAR}>clear (not set)</option>
        </select>
      )}
      <button
        type="button"
        disabled={running || !field || !optionId}
        onClick={() =>
          field &&
          onRun(
            chosen,
            field,
            optionId === CLEAR ? null : (optionId as Id<'contactFieldOptions'>),
          )
        }
        className="rounded bg-neutral-900 px-2 py-1 text-white hover:bg-neutral-700 disabled:opacity-40"
      >
        Set field
      </button>
    </>
  )
}

/** The run's progress, result or failure, until dismissed. */
export function BulkFieldResult({
  bulk,
  onDismiss,
}: {
  bulk: BulkFieldState
  onDismiss: () => void
}) {
  if (bulk.state === 'idle') return null
  const dismiss = (
    <button type="button" onClick={onDismiss} className="ml-2 underline">
      Dismiss
    </button>
  )
  return bulk.state === 'failed' ? (
    <p role="alert" className="mt-2 text-sm text-red-700">
      {bulk.message}
      {dismiss}
    </p>
  ) : (
    <p role="status" className="mt-2 text-sm text-neutral-600">
      {bulk.state === 'running'
        ? `Setting… ${bulk.done} of ${bulk.total}`
        : bulk.message}
      {bulk.state === 'done' && dismiss}
    </p>
  )
}
