import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery } from 'convex/react'
import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { Id } from '../../convex/_generated/dataModel'
import { api } from '../../convex/_generated/api'
import {
  SOURCE_DESCRIPTION_MAX,
  SOURCE_NAME_MAX,
} from '../../convex/sources/rules'
import { ConfirmDialog } from '../components/confirm-dialog'
import { StaffListSwitch } from '../components/staff-list-switch'
import {
  archiveHides,
  childNoun,
  conflictsOf,
  dateRange,
  deleteBlocked,
  deleteCount,
  failureMessage,
  fieldsOf,
  openDraft,
  payload,
  rebase,
  shownParts,
} from '../lib/source-codes'
import type { Draft, Fields, Part } from '../lib/source-codes'
import { useCanManageList, useTenant } from '../lib/tenant'

export const Route = createFileRoute('/t/$slug/settings/sources')({
  component: SourceCodesPage,
  // Not ported yet: renders "being ported" (lib/data/ported.ts). Its
  // loader prewarmed Convex queries; the porting step writes a new one.
})

const INDENT = { category: '', detail: 'pl-6', version: 'pl-12' } as const

const LEVEL_NAME = {
  category: 'Category',
  detail: 'Detail',
  version: 'Version',
} as const

/**
 * The tenant's source codes (source-codes plan, step 3): a category →
 * detail → version tree, each row showing its full code. Admins, and staff
 * when the group allows it, add parts, edit a part's name, description and
 * dates, archive / reactivate it, and delete it while it has never been
 * used; everyone else reads. Archived parts, and everything under them,
 * are hidden unless "Show archived" is on, and then dimmed; a row with an
 * open editor or add form stays until it closes, whatever is archived
 * meanwhile.
 */
function SourceCodesPage() {
  const tenant = useTenant()
  const canManage = useCanManageList('sourceCodes')
  const parts = useQuery(api.sources.queries.tree, { tenantId: tenant._id })
  const [showArchived, setShowArchived] = useState(false)
  // Rows with an editor or add form open, which stay shown (shownParts).
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const markOpen = useCallback((id: string, isOpen: boolean) => {
    setOpen((prev) => {
      if (prev.has(id) === isOpen) return prev
      const next = new Set(prev)
      if (isOpen) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])
  const shown = parts ? shownParts(parts, showArchived, open) : []
  const hidden = parts ? parts.length - shown.length : 0

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold">Source codes</h2>
        <p className="mt-1 text-sm text-neutral-600">
          Where supporters and gifts came from, in three parts: a category (how
          we reached them), a detail (which agency, event or appeal) and a
          version (which run). Only a full code, such as Street-Wesser-001, goes
          on a contact or a gift.
        </p>
      </div>
      <StaffListSwitch kind="sourceCodes" />
      {canManage && <AddPart parentId={undefined} noun="category" />}
      {parts === undefined ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : (
        <section className="flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <h3 className="flex-1 font-medium">Codes</h3>
            <label className="flex items-center gap-2 text-sm text-neutral-600">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)}
              />
              Show archived
              {!showArchived && hidden > 0 && ` (${hidden})`}
            </label>
          </div>
          {shown.length === 0 ? (
            <p className="text-sm text-neutral-500">No source codes yet.</p>
          ) : (
            <ul className="divide-y divide-neutral-200 rounded border border-neutral-200 bg-white">
              {shown.map((p) => (
                <PartRow
                  key={p._id}
                  part={p}
                  all={parts}
                  kept={!showArchived && !p.visible}
                  markOpen={markOpen}
                />
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  )
}

/** A name field and an Add button: a new category, or a part under `parentId`. */
function AddPart({
  parentId,
  noun,
  under,
  onDone,
}: {
  parentId: Id<'sourceCodes'> | undefined
  noun: 'category' | 'detail' | 'version'
  /** The parent's full code, for the field's label. */
  under?: string
  onDone?: () => void
}) {
  const tenant = useTenant()
  const create = useMutation(api.sources.mutations.create)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const label = under ? `New ${noun} under ${under}` : `New ${noun}`

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await create({ tenantId: tenant._id, parentId, name, isActive: true })
      setName('')
      onDone?.()
    } catch (err) {
      setError(failureMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-1">
      <div className="flex gap-2">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={label}
          aria-label={label}
          maxLength={SOURCE_NAME_MAX}
          autoFocus={!!under}
          disabled={busy}
          className="min-w-0 flex-1 rounded border border-neutral-300 px-3 py-1.5"
        />
        <button
          type="submit"
          disabled={busy || !name.trim()}
          className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-40"
        >
          Add {noun}
        </button>
        {onDone && (
          <button
            type="button"
            onClick={onDone}
            className="text-xs text-neutral-500 underline"
          >
            cancel
          </button>
        )}
      </div>
      {noun === 'detail' && (
        <span className="text-xs text-neutral-500">
          Its first version, 001, is added with it.
        </span>
      )}
      {error && (
        <span role="alert" className="text-sm text-red-700">
          {error}
        </span>
      )}
    </form>
  )
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`

/** What archiving a category takes out of the picker, as a sentence. */
function hiddenUnder({
  details,
  versions,
}: {
  details: number
  versions: number
}): string {
  if (versions === 0)
    return 'Nothing under it is in the source code picker now.'
  return `This hides its ${plural(versions, 'version')}, in ${plural(details, 'detail')}, from the source code picker.`
}

function PartRow({
  part,
  all,
  kept,
  markOpen,
}: {
  part: Part
  all: Array<Part>
  /** Archived (or under an archived part) and shown only while open. */
  kept: boolean
  markOpen: (id: string, isOpen: boolean) => void
}) {
  const tenant = useTenant()
  const canManage = useCanManageList('sourceCodes')
  const save = useMutation(api.sources.mutations.save)
  const remove = useMutation(api.sources.mutations.remove)
  const [editing, setEditing] = useState(false)
  const [adding, setAdding] = useState(false)
  const [confirming, setConfirming] = useState(false)
  // The counter the archive confirm opened on; null while it is closed.
  // Confirming archives against it, so an archive or reactivate made
  // meanwhile refuses as stale rather than being flipped back.
  const [archiving, setArchiving] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const child = childNoun(part.level)
  const blocked = deleteBlocked(part)
  const dates = dateRange(part)
  const dim = part.visible ? '' : 'opacity-60'
  const isOpen = editing || adding

  useEffect(() => {
    if (!isOpen) return
    markOpen(part._id, true)
    return () => markOpen(part._id, false)
  }, [isOpen, part._id, markOpen])

  async function setActive(isActive: boolean, expected: number) {
    setArchiving(null)
    setError(null)
    setBusy(true)
    try {
      await save({
        tenantId: tenant._id,
        id: part._id,
        expected,
        ...payload(fieldsOf(part), isActive),
      })
    } catch (err) {
      setError(failureMessage(err, 'row'))
    } finally {
      setBusy(false)
    }
  }

  async function confirmDelete() {
    setConfirming(false)
    setError(null)
    setBusy(true)
    try {
      await remove({
        tenantId: tenant._id,
        id: part._id,
        expected: part.saveVersion,
      })
    } catch (err) {
      setError(failureMessage(err, 'row'))
      setBusy(false)
    }
  }

  const under = deleteCount(all, part._id) - 1
  const hides = archiveHides(all, part._id)

  return (
    <li
      data-level={part.level}
      className={`flex flex-col gap-1 px-4 py-2 ${INDENT[part.level]}`}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className={`flex min-w-0 flex-1 items-baseline gap-2 ${dim}`}>
          <span className="sr-only">{LEVEL_NAME[part.level]}</span>
          <code
            data-testid="source-code"
            className={`font-mono text-sm break-all ${part.level === 'version' ? '' : 'font-medium'}`}
          >
            {part.code}
          </code>
          {!part.isActive ? (
            <span className="rounded bg-neutral-200 px-1.5 text-xs text-neutral-700">
              archived
            </span>
          ) : (
            !part.visible && (
              <span className="text-xs text-neutral-500">
                hidden: a part above it is archived
              </span>
            )
          )}
        </span>
        {canManage && !editing && (
          <span className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="text-xs text-neutral-600 underline"
            >
              edit
            </button>
            {child && (
              <button
                type="button"
                onClick={() => setAdding((a) => !a)}
                className="text-xs text-neutral-600 underline"
              >
                add {child}
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              // Archiving a category hides everything under it from the
              // picker, so it asks first; the rest are one click.
              onClick={() =>
                part.level === 'category' && part.isActive
                  ? setArchiving(part.saveVersion)
                  : void setActive(!part.isActive, part.saveVersion)
              }
              className="text-xs text-neutral-600 underline"
            >
              {part.isActive ? 'archive' : 'reactivate'}
            </button>
            {/* A disabled button gets no hover in every browser, so the
                reason's tooltip sits on a wrapper. */}
            <span title={blocked ?? undefined}>
              <button
                type="button"
                disabled={busy || blocked !== null}
                aria-describedby={blocked ? `${part._id}-blocked` : undefined}
                onClick={() => setConfirming(true)}
                className="text-xs text-red-700 underline disabled:text-neutral-400 disabled:no-underline"
              >
                delete
              </button>
            </span>
            {blocked && (
              <span id={`${part._id}-blocked`} className="sr-only">
                {blocked}
              </span>
            )}
          </span>
        )}
      </div>
      {!editing && (part.description || dates) && (
        <div className={`text-sm text-neutral-600 ${dim}`}>
          {dates && <span className="mr-3 text-neutral-500">{dates}</span>}
          {part.description && (
            <span className="whitespace-pre-line">{part.description}</span>
          )}
        </div>
      )}
      {kept && (
        <span role="status" className="text-xs text-amber-700">
          Archived while this was open. It stays here until you close it, then
          hides with the other archived codes.
        </span>
      )}
      {editing && <EditPart part={part} onDone={() => setEditing(false)} />}
      {adding && child && (
        <AddPart
          parentId={part._id}
          noun={child}
          under={part.code}
          onDone={() => setAdding(false)}
        />
      )}
      {error && (
        <span role="alert" className="text-xs text-red-700">
          {error}
        </span>
      )}
      <ConfirmDialog
        open={confirming}
        title={`Delete ${part.code}?`}
        description={
          under > 0
            ? `This also deletes the ${under} code part${under === 1 ? '' : 's'} under it. None has been used.`
            : 'It has never been used.'
        }
        confirm="Delete"
        cancel="Keep it"
        onConfirm={() => void confirmDelete()}
        onCancel={() => setConfirming(false)}
      />
      {part.level === 'category' && (
        <ConfirmDialog
          open={archiving !== null}
          title={`Archive ${part.code}?`}
          description={`${hiddenUnder(hides)} You can reactivate it later.`}
          confirm="Archive"
          cancel="Keep it"
          onConfirm={() => void setActive(false, archiving ?? part.saveVersion)}
          onCancel={() => setArchiving(null)}
        />
      )}
    </li>
  )
}

/**
 * The inline editor: name, description, and dates on details and versions.
 * A save someone else makes meanwhile is merged in (`rebase`), and the
 * next save goes against it.
 */
function EditPart({ part, onDone }: { part: Part; onDone: () => void }) {
  const tenant = useTenant()
  const save = useMutation(api.sources.mutations.save)
  const [draft, setDraft] = useState<Draft>(() => openDraft(part))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const dated = part.level !== 'category'

  useEffect(() => {
    setDraft((d) => rebase(d, part))
  }, [part])

  const set = (field: keyof Fields) => (value: string) =>
    setDraft((d) =>
      conflictsOf({ ...d, fields: { ...d.fields, [field]: value } }),
    )

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await save({
        tenantId: tenant._id,
        id: part._id,
        expected: draft.baseVersion,
        ...payload(draft.fields, part.isActive),
      })
      onDone()
    } catch (err) {
      setError(failureMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const flag = (field: keyof Fields) =>
    draft.conflicts.includes(field) ? (
      <span className="text-xs text-amber-700">
        changed by someone else to “{draft.base[field] || 'blank'}”; yours is
        kept
      </span>
    ) : null

  return (
    <form onSubmit={submit} className="flex flex-col gap-2 py-1">
      {/* Disabled while saving: typing then would be lost when the
          editor closes on the save it isn't part of. */}
      <fieldset disabled={busy} className="flex min-w-0 flex-col gap-2">
        <label className="flex flex-col gap-1 text-sm">
          <span>Name</span>
          <input
            type="text"
            value={draft.fields.name}
            onChange={(e) => set('name')(e.target.value)}
            aria-label={`Name of ${part.code}`}
            maxLength={SOURCE_NAME_MAX}
            autoFocus
            className="rounded border border-neutral-300 px-2 py-1"
          />
          {flag('name')}
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span>Description</span>
          <textarea
            value={draft.fields.description}
            onChange={(e) => set('description')(e.target.value)}
            maxLength={SOURCE_DESCRIPTION_MAX}
            rows={2}
            className="rounded border border-neutral-300 px-2 py-1"
          />
          {flag('description')}
        </label>
        {dated && (
          <div className="flex flex-wrap gap-4">
            <label className="flex flex-col gap-1 text-sm">
              <span>Start date</span>
              <input
                type="date"
                value={draft.fields.startDate}
                onChange={(e) => set('startDate')(e.target.value)}
                className="rounded border border-neutral-300 px-2 py-1"
              />
              {flag('startDate')}
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span>End date</span>
              <input
                type="date"
                value={draft.fields.endDate}
                onChange={(e) => set('endDate')(e.target.value)}
                className="rounded border border-neutral-300 px-2 py-1"
              />
              {flag('endDate')}
            </label>
          </div>
        )}
        {dated && (
          <span className="text-xs text-neutral-500">
            Dates guide the picker (codes in date come first); they never stop a
            code being used.
          </span>
        )}
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={busy}
            className="rounded bg-neutral-900 px-2 py-1 text-xs text-white hover:bg-neutral-700"
          >
            Save
          </button>
          <button
            type="button"
            onClick={onDone}
            className="text-xs text-neutral-500 underline"
          >
            cancel
          </button>
        </div>
        {error && (
          <span role="alert" className="text-xs text-red-700">
            {error}
          </span>
        )}
      </fieldset>
    </form>
  )
}
