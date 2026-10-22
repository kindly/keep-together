import { Link, createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery } from 'convex/react'
import type { FunctionReturnType } from 'convex/server'
import { ConvexError } from 'convex/values'
import { useEffect, useState } from 'react'
import type { Id } from '../../convex/_generated/dataModel'
import { api } from '../../convex/_generated/api'
import { BULK_FIELD_LIMIT, BULK_TAG_LIMIT } from '../../convex/contacts/rules'
import type { FieldDefinition } from '../../convex/contacts/fieldTypes'
import { fieldArgs, fieldShown } from '../lib/field-filters'
import type { FieldPick } from '../lib/field-filters'
import { cachedTenant, useCanWrite, useTenant } from '../lib/tenant'
import { holdList, releaseList } from '../lib/list-hold'
import { usePagedList } from '../lib/paged-list'

export const Route = createFileRoute('/t/$slug/contacts/')({
  component: ContactList,
  // Subscribe as the navigation starts, not once the list has mounted.
  loader: ({ context: { convex }, params }) => {
    const tenant = cachedTenant(convex, params.slug)
    if (!tenant) return
    holdList(convex, { tenantId: tenant._id, includeArchived: false })
    convex.prewarmQuery({
      query: api.contacts.queries.tags,
      args: { tenantId: tenant._id, includeInactive: true },
    })
    convex.prewarmQuery({
      query: api.sources.queries.filterOptions,
      args: { tenantId: tenant._id },
    })
    convex.prewarmQuery({
      query: api.contacts.fields.list,
      args: { tenantId: tenant._id },
    })
  },
})

type Part = FunctionReturnType<typeof api.sources.queries.filterOptions>[number]

/** The source filter's choice per level; '' is "all". */
type SourcePick = {
  category: Id<'sourceCodes'> | ''
  detail: Id<'sourceCodes'> | ''
  version: Id<'sourceCodes'> | ''
}

const NO_SOURCE: SourcePick = { category: '', detail: '', version: '' }

/** The deepest level picked, as `list`'s `source` argument. */
function sourceArg(pick: SourcePick) {
  if (pick.version) return { level: 'version' as const, id: pick.version }
  if (pick.detail) return { level: 'detail' as const, id: pick.detail }
  if (pick.category) return { level: 'category' as const, id: pick.category }
  return undefined
}

// 'household' is a valid kind but dormant: nothing creates one, so no chip.
type Kind = 'individual' | 'organization'

const KINDS: Array<{ value: Kind | ''; label: string }> = [
  { value: '', label: 'everyone' },
  { value: 'individual', label: 'people' },
  { value: 'organization', label: 'organisations' },
]

/** "not set" in a field filter's select ('' is "any"). */
const NOT_SET = 'none'

type Bulk =
  | { state: 'idle' }
  | { state: 'running'; op: 'add' | 'remove'; done: number; total: number }
  | { state: 'done'; message: string }
  | { state: 'failed'; message: string }

function ContactList() {
  const tenant = useTenant()
  const canWrite = useCanWrite()
  const [search, setSearch] = useState('')
  const [includeArchived, setIncludeArchived] = useState(false)
  const [tagFilter, setTagFilter] = useState<Id<'tags'> | ''>('')
  const [kind, setKind] = useState<Kind | ''>('')
  const [sourcePick, setSourcePick] = useState<SourcePick>(NO_SOURCE)
  const source = sourceArg(sourcePick)
  const fields = useQuery(api.contacts.fields.list, { tenantId: tenant._id })
  const [fieldPicks, setFieldPicks] = useState<Array<FieldPick>>([])
  const fieldFilters = fieldArgs(fieldPicks, fields, kind)
  // Search text or a tag: one window (`search`). Otherwise browse a page at
  // a time (`list`).
  const searching = search.trim() !== '' || tagFilter !== ''
  const listed = useQuery(
    api.contacts.queries.search,
    searching
      ? {
          tenantId: tenant._id,
          search,
          includeArchived,
          ...(tagFilter && { tagId: tagFilter }),
          ...(kind && { kind }),
          ...(source && { source }),
          ...(fieldFilters.length > 0 && { fields: fieldFilters }),
        }
      : 'skip',
  )
  const paged = usePagedList(
    searching
      ? 'skip'
      : {
          tenantId: tenant._id,
          includeArchived,
          ...(kind && { kind }),
          ...(source && { source }),
          ...(fieldFilters.length > 0 && { fields: fieldFilters }),
        },
  )
  // After the queries above: their subscriptions are in place by now. After
  // every render, not just the first: navigating to the list from the list
  // runs the loader (a new hold) without remounting the page.
  useEffect(releaseList)
  const contacts = searching ? listed?.rows : paged.rows
  // More may match than the rows on screen: beyond the window, or not
  // loaded yet.
  const partial = searching
    ? (listed?.truncated ?? false)
    : paged.status === 'more'
  const tags = useQuery(api.contacts.queries.tags, {
    tenantId: tenant._id,
    includeInactive: true,
  })
  const tagName = new Map((tags ?? []).map((t) => [t._id as string, t]))
  // Each option's chip: its field's label and its own, read live.
  const chipOf = new Map(
    (fields ?? []).flatMap((f) =>
      f.options.map((o) => [
        o._id as string,
        {
          text: `${f.label}: ${o.label}`,
          active: f.isActive && o.isActive,
        },
      ]),
    ),
  )

  const [selected, setSelected] = useState<ReadonlySet<Id<'contacts'>>>(
    new Set(),
  )
  // Only rows on screen count: a selection never acts on hidden contacts.
  const chosen = (contacts ?? []).filter((c) => selected.has(c._id))
  const allChosen =
    contacts !== undefined &&
    contacts.length > 0 &&
    chosen.length === contacts.length
  const toggle = (id: Id<'contacts'>) =>
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <main className="mx-auto max-w-5xl p-6">
      <div className="flex flex-wrap items-center gap-4">
        <h1 className="text-xl font-semibold">Contacts</h1>
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search contacts"
          aria-label="Search contacts"
          aria-describedby="search-hint"
          className="rounded border border-neutral-300 px-3 py-1.5"
        />
        <div
          role="group"
          aria-label="Filter by kind"
          className="flex overflow-hidden rounded-full border border-neutral-300 text-sm"
        >
          {KINDS.map((k) => (
            <button
              key={k.value}
              type="button"
              aria-pressed={kind === k.value}
              onClick={() => setKind(k.value)}
              className={`px-2.5 py-1 ${kind === k.value ? 'bg-neutral-900 text-white' : 'hover:bg-neutral-50'}`}
            >
              {k.label}
            </button>
          ))}
        </div>
        <select
          aria-label="Filter by tag"
          value={tagFilter}
          onChange={(e) => setTagFilter(e.target.value as Id<'tags'> | '')}
          className="rounded border border-neutral-300 px-2 py-1.5 text-sm"
        >
          <option value="">all tags</option>
          {(tags ?? []).map((t) => (
            <option key={t._id} value={t._id}>
              {t.isActive ? t.name : `${t.name} (archived)`}
            </option>
          ))}
        </select>
        <SourceFilter value={sourcePick} onChange={setSourcePick} />
        {(fields ?? [])
          .filter((f) => fieldShown(f, kind))
          .sort((a, b) => a.slot - b.slot)
          .map((f) => (
            <FieldFilter
              key={f._id}
              field={f}
              value={fieldPicks.find((p) => p.fieldId === f._id)}
              onChange={(pick) =>
                setFieldPicks((picks) => {
                  const rest = picks.filter((p) => p.fieldId !== f._id)
                  if (pick === undefined) return rest
                  // A changed pick keeps its place in the order.
                  const at = picks.findIndex((p) => p.fieldId === f._id)
                  return at === -1
                    ? [...rest, pick]
                    : [...rest.slice(0, at), pick, ...rest.slice(at)]
                })
              }
            />
          ))}
        <label className="flex items-center gap-2 text-sm text-neutral-600">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(e) => setIncludeArchived(e.target.checked)}
          />
          show archived
        </label>
        {canWrite && (
          <Link
            to="/t/$slug/contacts/new"
            params={{ slug: tenant.slug }}
            className="ml-auto rounded bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700"
          >
            New contact
          </Link>
        )}
      </div>
      <p id="search-hint" className="mt-1 text-xs text-neutral-500">
        Search by name, email, phone, postcode, street or reference
      </p>
      {canWrite && contacts !== undefined && contacts.length > 0 && (
        <BulkBar
          chosen={chosen.map((c) => c._id)}
          allChosen={allChosen}
          shown={contacts.length}
          beyond={
            !partial
              ? ''
              : searching
                ? ' (not the ones beyond)'
                : ' (more not loaded yet)'
          }
          onAll={(all) =>
            setSelected(new Set(all ? contacts.map((c) => c._id) : []))
          }
          tags={(tags ?? []).filter((t) => t.isActive)}
          allTags={tags ?? []}
          fields={(fields ?? []).filter((f) => f.isActive && !f.retiring)}
        />
      )}
      {searching && listed?.truncated && (contacts?.length ?? 0) > 0 && (
        <p className="mt-3 text-sm text-amber-800">
          Showing the first {contacts?.length} contacts
          {tagFilter ? ' with this tag' : ''}
          {source ? ' with this source code' : ''}
          {fieldFilters.length > 0 ? ' with these field values' : ''}; there are
          more. Narrow the search to see them.
        </p>
      )}
      {contacts === undefined ? (
        <p className="mt-6 text-sm text-neutral-500">Loading…</p>
      ) : contacts.length === 0 ? (
        <p className="mt-6 text-sm text-neutral-500">
          {searching && listed?.tooBroad
            ? search.trim()
              ? `No match in the first ${listed.checked} results; there may be more. Add another word.`
              : `None of the first ${listed.checked} contacts checked match; there may be more. Add a search word to narrow it.`
            : paged.status !== 'done' && !searching
              ? 'None among the contacts checked so far; there may be more.'
              : search.trim()
                ? 'No contacts match.'
                : fieldFilters.length > 0
                  ? 'No contacts with these field values.'
                  : source
                    ? 'No contacts with this source code.'
                    : tagFilter
                      ? 'No contacts with this tag.'
                      : kind
                        ? 'No contacts of this kind.'
                        : 'No contacts yet.'}
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-neutral-200 rounded border border-neutral-200 bg-white">
          {contacts.map((c) => (
            <li key={c._id} className="flex items-center">
              {canWrite && (
                <input
                  type="checkbox"
                  aria-label={`select ${c.displayName}`}
                  checked={selected.has(c._id)}
                  onChange={() => toggle(c._id)}
                  className="ml-4"
                />
              )}
              <Link
                to="/t/$slug/contacts/$contactId"
                params={{ slug: tenant.slug, contactId: c._id }}
                className="flex flex-1 items-baseline justify-between gap-4 px-4 py-2 hover:bg-neutral-50"
              >
                <span>
                  {c.displayName}
                  {c.archived && (
                    <span className="ml-2 rounded bg-neutral-200 px-1.5 text-xs">
                      archived
                    </span>
                  )}
                  {c.tagIds.map((id) => {
                    const t = tagName.get(id)
                    return t ? (
                      <span
                        key={id}
                        className={`ml-2 rounded-full border px-2 text-xs ${t.isActive ? 'border-neutral-300' : 'border-dashed border-neutral-300 text-neutral-500'}`}
                      >
                        {t.name}
                      </span>
                    ) : null
                  })}
                  {c.fieldOptionIds.map((id) => {
                    const chip = chipOf.get(id)
                    return chip ? (
                      <span
                        key={id}
                        className={`ml-2 rounded border px-1.5 text-xs ${chip.active ? 'border-sky-200 bg-sky-50 text-sky-900' : 'border-dashed border-neutral-300 text-neutral-500'}`}
                      >
                        {chip.text}
                      </span>
                    ) : null
                  })}
                </span>
                <span className="text-sm text-neutral-500">
                  {c.email ?? c.kind}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {!searching && contacts !== undefined && paged.status !== 'done' && (
        <button
          type="button"
          disabled={paged.status === 'loading'}
          onClick={paged.loadMore}
          className="mt-3 rounded border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 disabled:opacity-40"
        >
          {paged.status === 'loading' ? 'Loading more…' : 'Load more'}
        </button>
      )}
    </main>
  )
}

/**
 * One field's filter: any, "not set", or one of its options (archived ones
 * too, marked: contacts keep them).
 */
function FieldFilter({
  field,
  value,
  onChange,
}: {
  field: FieldDefinition
  value: FieldPick | undefined
  onChange: (pick: FieldPick | undefined) => void
}) {
  return (
    <select
      aria-label={`Filter by ${field.label}`}
      value={value === undefined ? '' : (value.optionId ?? NOT_SET)}
      onChange={(e) => {
        const v = e.target.value
        onChange(
          v === ''
            ? undefined
            : {
                fieldId: field._id,
                optionId:
                  v === NOT_SET ? null : (v as Id<'contactFieldOptions'>),
              },
        )
      }}
      className="rounded border border-neutral-300 px-2 py-1.5 text-sm"
    >
      <option value="">{`any ${field.label}`}</option>
      <option value={NOT_SET}>{`${field.label} not set`}</option>
      {field.options.map((o) => (
        <option key={o._id} value={o._id}>
          {o.isActive ? o.label : `${o.label} (archived)`}
        </option>
      ))}
    </select>
  )
}

/**
 * The source filter: category, then one of its details, then one of that
 * detail's versions, each "all" until picked; a pick clears the levels
 * below it. Archived parts are offered (marked): contacts keep codes
 * archived since.
 */
function SourceFilter({
  value,
  onChange,
}: {
  value: SourcePick
  onChange: (pick: SourcePick) => void
}) {
  const tenant = useTenant()
  const parts = useQuery(api.sources.queries.filterOptions, {
    tenantId: tenant._id,
  })
  const under = (level: Part['level'], parentId: Id<'sourceCodes'> | '') =>
    (parts ?? []).filter(
      (p) => p.level === level && (p.parentId ?? '') === parentId,
    )
  const select = (
    level: keyof SourcePick,
    label: string,
    all: string,
    options: Array<Part>,
    pick: (id: Id<'sourceCodes'> | '') => SourcePick,
  ) => (
    <select
      aria-label={label}
      value={value[level]}
      onChange={(e) => onChange(pick(e.target.value as Id<'sourceCodes'> | ''))}
      className="rounded border border-neutral-300 px-2 py-1.5 text-sm"
    >
      <option value="">{all}</option>
      {options.map((p) => (
        <option key={p._id} value={p._id}>
          {p.isActive ? p.name : `${p.name} (archived)`}
        </option>
      ))}
    </select>
  )
  return (
    <div role="group" aria-label="Filter by source code" className="flex gap-2">
      {select(
        'category',
        'Filter by source category',
        'all sources',
        under('category', ''),
        (category) => ({ ...NO_SOURCE, category }),
      )}
      {value.category &&
        select(
          'detail',
          'Filter by source detail',
          'all details',
          under('detail', value.category),
          (detail) => ({ ...value, detail, version: '' }),
        )}
      {value.detail &&
        select(
          'version',
          'Filter by source version',
          'all versions',
          under('version', value.detail),
          (version) => ({ ...value, version }),
        )}
    </div>
  )
}

/** A user-facing line for a failed `bulkTag` or `bulkSetField`. */
function bulkFailure(err: unknown, fallback = 'Could not change tags'): string {
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

/**
 * Add or remove one tag on the selected rows. Each batch is one
 * all-or-nothing `bulkTag` (one command group); the bar shows progress
 * while batches run and what changed when they finish.
 */
function BulkBar({
  chosen,
  allChosen,
  shown,
  beyond,
  onAll,
  tags,
  allTags,
  fields,
}: {
  chosen: Array<Id<'contacts'>>
  allChosen: boolean
  shown: number
  /** What "select all" leaves out, '' when it covers every match. */
  beyond: string
  onAll: (all: boolean) => void
  tags: Array<{ _id: Id<'tags'>; name: string }>
  allTags: Array<{ _id: Id<'tags'>; name: string }>
  /** Fields a value can be set on: active, not being retired. */
  fields: Array<FieldDefinition>
}) {
  const tenant = useTenant()
  const bulkTag = useMutation(api.contacts.mutations.bulkTag)
  const [tagId, setTagId] = useState<Id<'tags'> | ''>('')
  const [bulk, setBulk] = useState<Bulk>({ state: 'idle' })
  const running = bulk.state === 'running'
  // Removing may name an archived tag; adding only an active one.
  const removable = tagId !== '' && allTags.some((t) => t._id === tagId)
  const addable = tags.some((t) => t._id === tagId)

  async function run(op: 'add' | 'remove') {
    if (!tagId) return
    const name = allTags.find((t) => t._id === tagId)?.name ?? 'tag'
    const ids = [...chosen]
    let changed = 0
    setBulk({ state: 'running', op, done: 0, total: ids.length })
    try {
      for (let i = 0; i < ids.length; i += BULK_TAG_LIMIT) {
        const batch = ids.slice(i, i + BULK_TAG_LIMIT)
        const result = await bulkTag({
          tenantId: tenant._id,
          contactIds: batch,
          tagId,
          op,
        })
        changed += result.changed
        setBulk({
          state: 'running',
          op,
          done: i + batch.length,
          total: ids.length,
        })
      }
      const n = `${changed} contact${changed === 1 ? '' : 's'}`
      setBulk({
        state: 'done',
        message:
          op === 'add'
            ? `Added “${name}” to ${n}`
            : `Removed “${name}” from ${n}`,
      })
    } catch (err) {
      const soFar = changed > 0 ? ` (${changed} changed before it stopped)` : ''
      setBulk({ state: 'failed', message: `${bulkFailure(err)}${soFar}` })
    }
  }

  return (
    <div className="mt-6 flex flex-wrap items-center gap-3 text-sm">
      <label className="flex items-center gap-2 text-neutral-600">
        <input
          type="checkbox"
          checked={allChosen}
          disabled={running}
          onChange={(e) => onAll(e.target.checked)}
        />
        select all {shown} shown{beyond}
      </label>
      {chosen.length > 0 && (
        <>
          <span className="font-medium">{chosen.length} selected</span>
          <select
            aria-label="Tag to change"
            value={tagId}
            disabled={running}
            onChange={(e) => setTagId(e.target.value as Id<'tags'> | '')}
            className="rounded border border-neutral-300 px-2 py-1"
          >
            <option value="">choose tag…</option>
            {allTags.map((t) => (
              <option key={t._id} value={t._id}>
                {tags.some((a) => a._id === t._id)
                  ? t.name
                  : `${t.name} (archived)`}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={running || !addable}
            onClick={() => void run('add')}
            className="rounded bg-neutral-900 px-2 py-1 text-white hover:bg-neutral-700 disabled:opacity-40"
          >
            Add tag
          </button>
          <button
            type="button"
            disabled={running || !removable}
            onClick={() => void run('remove')}
            className="rounded border border-neutral-300 px-2 py-1 hover:bg-neutral-50 disabled:opacity-40"
          >
            Remove tag
          </button>
        </>
      )}
      {chosen.length > 0 && fields.length > 0 && (
        <BulkField chosen={chosen} fields={fields} />
      )}
      <span role="status" className="text-neutral-600">
        {bulk.state === 'running' &&
          `${bulk.op === 'add' ? 'Adding' : 'Removing'}… ${bulk.done} of ${bulk.total}`}
        {bulk.state === 'done' && bulk.message}
      </span>
      {bulk.state === 'failed' && (
        <span role="alert" className="text-red-700">
          {bulk.message}
        </span>
      )}
    </div>
  )
}

type BulkFieldState =
  | { state: 'idle' }
  | { state: 'running'; done: number; total: number }
  | { state: 'done'; message: string }
  | { state: 'failed'; message: string }

/**
 * Set one field to an option, or clear it, on the selected rows: each
 * batch of BULK_FIELD_LIMIT is one all-or-nothing `bulkSetField` (one
 * command group). Contacts of a kind the field doesn't apply to are
 * skipped by the server and counted in the result.
 */
function BulkField({
  chosen,
  fields,
}: {
  chosen: Array<Id<'contacts'>>
  fields: Array<FieldDefinition>
}) {
  const tenant = useTenant()
  const bulkSetField = useMutation(api.contacts.mutations.bulkSetField)
  const [fieldId, setFieldId] = useState<Id<'contactFields'> | ''>('')
  // '' until chosen; NOT_SET clears.
  const [optionId, setOptionId] = useState<string>('')
  const [bulk, setBulk] = useState<BulkFieldState>({ state: 'idle' })
  const running = bulk.state === 'running'
  const field = fields.find((f) => f._id === fieldId)
  const options = field?.options.filter((o) => o.isActive) ?? []

  async function run() {
    if (!field || !optionId) return
    const option =
      optionId === NOT_SET ? null : (optionId as Id<'contactFieldOptions'>)
    const label = options.find((o) => o._id === option)?.label
    const ids = [...chosen]
    let changed = 0
    let skipped = 0
    setBulk({ state: 'running', done: 0, total: ids.length })
    try {
      for (let i = 0; i < ids.length; i += BULK_FIELD_LIMIT) {
        const batch = ids.slice(i, i + BULK_FIELD_LIMIT)
        const result = await bulkSetField({
          tenantId: tenant._id,
          contactIds: batch,
          fieldId: field._id,
          optionId: option,
        })
        changed += result.changed
        skipped += result.skipped
        setBulk({ state: 'running', done: i + batch.length, total: ids.length })
      }
      const n = `${changed} contact${changed === 1 ? '' : 's'}`
      const done =
        option === null
          ? `Cleared “${field.label}” on ${n}`
          : `Set “${field.label}” to “${label ?? '?'}” on ${n}`
      setBulk({
        state: 'done',
        message:
          skipped > 0
            ? `${done}; skipped ${skipped} of a kind it doesn’t apply to`
            : done,
      })
    } catch (err) {
      const soFar = changed > 0 ? ` (${changed} changed before it stopped)` : ''
      setBulk({
        state: 'failed',
        message: `${bulkFailure(err, 'Could not set the field')}${soFar}`,
      })
    }
  }

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
          <option value={NOT_SET}>clear (not set)</option>
        </select>
      )}
      <button
        type="button"
        disabled={running || !field || !optionId}
        onClick={() => void run()}
        className="rounded bg-neutral-900 px-2 py-1 text-white hover:bg-neutral-700 disabled:opacity-40"
      >
        Set field
      </button>
      <span role="status" className="text-neutral-600">
        {bulk.state === 'running' && `Setting… ${bulk.done} of ${bulk.total}`}
        {bulk.state === 'done' && bulk.message}
      </span>
      {bulk.state === 'failed' && (
        <span role="alert" className="text-red-700">
          {bulk.message}
        </span>
      )}
    </>
  )
}
