import { useState } from 'react'
import type { Id } from '../../convex/_generated/dataModel'
import type { BulkFieldState, FieldDefinition } from '../lib/data'

/** "clear" in the value select ('' is "not chosen yet"). */
const CLEAR = 'none'

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
