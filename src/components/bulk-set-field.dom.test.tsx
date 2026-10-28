// @vitest-environment happy-dom
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Id } from '../lib/domain/ids'
import type { FieldDefinition } from '../lib/domain/contacts'
import { useBulkSetField } from '../lib/data'
import { RustApiError } from '../lib/data/rust/client'
import type * as Client from '../lib/data/rust/client'
import { BulkFieldControls, BulkFieldResult } from './bulk-set-field'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const bulkSetField = vi.fn()
vi.mock('../lib/data/rust/client', async (original) => ({
  ...(await original<typeof Client>()),
  post: (_path: string, body: unknown) => bulkSetField(body),
}))
vi.mock('../lib/tenant', () => ({ useTenant: () => ({ slug: 'alpha' }) }))

const FIELD: FieldDefinition = {
  _id: 'fVol' as Id<'contactFields'>,
  label: 'Volunteer status',
  appliesTo: ['individual'],
  isActive: true,
  retiring: false,
  slot: 1,
  saveVersion: 0,
  deletable: false,
  options: [
    {
      _id: 'oActive' as Id<'contactFieldOptions'>,
      fieldId: 'fVol' as Id<'contactFields'>,
      label: 'Active',
      position: 0,
      isActive: true,
      used: true,
      saveVersion: 0,
    },
  ],
}

/** 1500 ids: two batches (1000, 500). */
const IDS = Array.from({ length: 1500 }, (_, i) => `c${i}` as Id<'contacts'>)

/**
 * The list page's shape: the controls show only while selected rows are
 * on screen, the result is the page's. Rows leave the list as the set
 * moves them out of its filter ("Volunteer status not set").
 */
let leave: (ids: Array<Id<'contacts'>>) => void
function Page() {
  const [rows, setRows] = useState(IDS)
  leave = (gone) => setRows((r) => r.filter((id) => !gone.includes(id)))
  const bulk = useBulkSetField()
  return (
    <div>
      {rows.length > 0 && (
        <BulkFieldControls
          chosen={rows}
          fields={[FIELD]}
          running={bulk.bulk.state === 'running'}
          onRun={(ids, field, optionId) => void bulk.run(ids, field, optionId)}
        />
      )}
      <BulkFieldResult bulk={bulk.bulk} onDismiss={bulk.dismiss} />
    </div>
  )
}

let root: Root
let el: HTMLDivElement
beforeEach(() => {
  bulkSetField.mockReset()
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
  act(() =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <Page />
      </QueryClientProvider>,
    ),
  )
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
})

const select = (label: string, value: string) =>
  act(() => {
    const s = document.querySelector<HTMLSelectElement>(
      `select[aria-label="${label}"]`,
    )!
    s.value = value
    s.dispatchEvent(new Event('change', { bubbles: true }))
  })

async function setActive() {
  select('Field to set', 'fVol')
  select('Value for Volunteer status', 'oActive')
  await act(async () => {
    document
      .querySelectorAll('button')
      .forEach((b) => b.textContent === 'Set field' && b.click())
  })
}

const text = (role: string) =>
  document.querySelector(`[role=${role}]`)?.textContent ?? null

test('the result shows after every selected row has left the list', async () => {
  // Each batch's changed rows leave the filtered list as it commits; a
  // tenth of each batch is organisations, skipped and left in place.
  bulkSetField.mockImplementation(
    async ({ contactIds }: { contactIds: Array<Id<'contacts'>> }) => {
      const skipped = contactIds.filter((_, i) => i % 10 === 0)
      const changed = contactIds.filter((_, i) => i % 10 !== 0)
      act(() => leave(contactIds))
      return { changed: changed.length, skipped: skipped.length, group: null }
    },
  )
  await setActive()
  expect(bulkSetField).toHaveBeenCalledTimes(2)
  expect(document.querySelector('select[aria-label="Field to set"]')).toBeNull()
  expect(text('status')).toBe(
    'Set “Volunteer status” to “Active” on 1350 contacts; skipped 150 of a kind it doesn’t apply to' +
      'Dismiss',
  )
})

test('a later batch failing still says what the run did, skipped included', async () => {
  bulkSetField
    .mockImplementationOnce(
      async ({ contactIds }: { contactIds: Array<Id<'contacts'>> }) => {
        act(() => leave(contactIds))
        return { changed: 90, skipped: 10, group: null }
      },
    )
    .mockRejectedValueOnce(
      new RustApiError(409, {
        kind: 'stale',
        contract: 'contacts.fields',
        counter: 3,
        current: null,
      }),
    )
  await setActive()
  expect(text('alert')).toBe(
    'Someone else changed one of these contacts just now; try again' +
      ' (before it stopped: 90 contacts changed; skipped 10 of a kind it doesn’t apply to)' +
      'Dismiss',
  )
  await act(async () => {
    document
      .querySelectorAll('button')
      .forEach((b) => b.textContent === 'Dismiss' && b.click())
  })
  expect(text('alert')).toBeNull()
})
