/**
 * Dropdown fields on the Rust API (`/api/t/{slug}/fields…`): the Settings
 * tab's writes and the contacts list's bulk set. The definitions are read
 * through `useFields` (hooks.tsx), shared with the form and the filters;
 * every write here answers the server's state, and the caller waits for
 * it and for the definitions' refetch. A field's events (another tab's
 * edit, a retire's progress) refetch them too (`../events.ts`).
 */
import { useQueryClient } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import type { Id } from '../../domain/ids'
import type { FieldDefinition } from '../types'
import { useTenant } from '../../tenant'
import type { BulkSetResult } from '../rust-types/BulkSetResult'
import type { ContactKind } from '../rust-types/ContactKind'
import type { DeletedFieldPart } from '../rust-types/DeletedFieldPart'
import type { Executed } from '../rust-types/Executed'
import type { ReorderedOptions } from '../rust-types/ReorderedOptions'
import type { FieldRetirePayload } from '../rust-types/FieldRetirePayload'
import { RustApiError, post, tenantPath } from './client'
import { keys } from './keys'

type FieldId = Id<'contactFields'>
type OptionId = Id<'contactFieldOptions'>

/** A field's editable slice. */
export type FieldPayload = {
  label: string
  appliesTo: Array<ContactKind>
  isActive: boolean
}

/** An option's editable slice; its field is fixed. */
export type OptionPayload = {
  fieldId: FieldId
  label: string
  position: number
  isActive: boolean
}

/** The definitions, and every contact (a label shows on each holder). */
function fieldsChanged(qc: QueryClient, slug: string) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: keys.fields(slug) }),
    qc.invalidateQueries({ queryKey: keys.contacts(slug) }),
  ])
}

/**
 * Create, save, delete, reorder and retire. Each resolves once the server
 * has answered and the definitions have been refetched, and throws
 * `RustApiError` when refused (`stale` on a counter that moved).
 */
export function useFieldWrites() {
  const { slug } = useTenant()
  const qc = useQueryClient()
  const path = (...parts: Array<string>) => tenantPath(slug, 'fields', ...parts)
  const after = async <T,>(write: Promise<T>): Promise<T> => {
    try {
      return await write
    } finally {
      await fieldsChanged(qc, slug)
    }
  }
  return {
    createField: (payload: FieldPayload) =>
      after(post<Executed>(path(), payload)),
    saveField: (id: FieldId, expected: number, payload: FieldPayload) =>
      after(post<Executed>(path(), { id, expected, ...payload })),
    deleteField: (id: FieldId, expected: number) =>
      after(post<DeletedFieldPart>(path(id, 'delete'), { expected })),
    /** A new option at the end of the field's list. */
    addOption: (fieldId: FieldId, label: string) =>
      after(
        post<Executed>(path('options'), {
          fieldId,
          label,
          position: 0,
          isActive: true,
        }),
      ),
    saveOption: (id: OptionId, expected: number, payload: OptionPayload) =>
      after(post<Executed>(path('options'), { id, expected, ...payload })),
    deleteOption: (id: OptionId, expected: number) =>
      after(
        post<DeletedFieldPart>(path('options', id, 'delete'), { expected }),
      ),
    /** Every option of the field, archived ones included, in order. */
    reorder: (fieldId: FieldId, order: Array<OptionId>) =>
      after(post<ReorderedOptions>(path(fieldId, 'reorder'), { order })),
    /**
     * Answers once the retire has started (`retiring`); the values clear
     * in the background, and the field leaves the definitions when it
     * ends (`useFollowRetires`).
     */
    retire: (id: FieldId) =>
      after(post<FieldRetirePayload>(path(id, 'retire'))),
  }
}

/** How often the definitions are fetched again while a field retires. */
export const RETIRE_POLL_MS = 2_000

/**
 * While any field is retiring, fetch the definitions again every
 * RETIRE_POLL_MS: the retire's end is an event too, and this is the
 * backstop if the stream missed it (reconnecting, a proxy).
 */
export function useFollowRetires(fields: Array<FieldDefinition> | undefined) {
  const { slug } = useTenant()
  const qc = useQueryClient()
  const retiring = fields?.some((f) => f.retiring) ?? false
  useEffect(() => {
    if (!retiring) return
    const poll = setInterval(
      () => void qc.invalidateQueries({ queryKey: keys.fields(slug) }),
      RETIRE_POLL_MS,
    )
    return () => clearInterval(poll)
  }, [retiring, qc, slug])
}

// ── bulk set ───────────────────────────────────────────────────────────────

/** The most contacts one bulk request sets (the server's limit). */
export const BULK_FIELD_LIMIT = 1000

export type BulkFieldState =
  | { state: 'idle' }
  | { state: 'running'; done: number; total: number }
  | { state: 'done'; message: string }
  | { state: 'failed'; message: string }

/** A user-facing line for a failed bulk set. */
export function bulkFailure(err: unknown, fallback: string): string {
  if (!(err instanceof RustApiError)) return fallback
  if (err.error.kind === 'stale')
    return 'Someone else changed one of these contacts just now; try again'
  if (err.error.kind === 'internal') return fallback
  return err.message
}

const contacts = (n: number) => `${n} contact${n === 1 ? '' : 's'}`

/**
 * A bulk "set field" run and its result, held by the list page itself:
 * setting a value moves the changed rows out of a list filtered on that
 * field, so the selection (and the bar showing it) can empty mid-run. The
 * run carries on over the ids it started with, and its result stays until
 * dismissed or the next run. Each batch of BULK_FIELD_LIMIT is one
 * all-or-nothing request (one command group); contacts of a kind the
 * field doesn't apply to are skipped by the server and counted. Never
 * optimistic: the list shows what the server answered.
 */
export function useBulkSetField() {
  const { slug } = useTenant()
  const qc = useQueryClient()
  const [bulk, setBulk] = useState<BulkFieldState>({ state: 'idle' })

  async function run(
    chosen: Array<Id<'contacts'>>,
    field: FieldDefinition,
    optionId: OptionId | null,
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
        const result = await post<BulkSetResult>(
          tenantPath(slug, 'contacts', 'bulk-set-field'),
          { contactIds: batch, fieldId: field._id, optionId },
        )
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
    } finally {
      // The rows, their filters and every changed contact; an option's
      // first use also turns its delete into archive.
      void fieldsChanged(qc, slug)
    }
  }

  return {
    bulk,
    run,
    dismiss: () => setBulk({ state: 'idle' }),
  }
}
