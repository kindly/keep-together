import { createFileRoute } from '@tanstack/react-router'
import { useAction, useMutation, useQuery } from 'convex/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { api } from '../../convex/_generated/api'
import {
  CONTACT_KINDS,
  FIELD_LABEL_MAX,
} from '../../convex/contacts/fieldTypes'
import type { ContactKind } from '../../convex/contacts/fieldTypes'
import { FIELD_SLOTS } from '../../convex/lib/fieldSlots'
import { ConfirmDialog } from '../components/confirm-dialog'
import { StaffListSwitch } from '../components/staff-list-switch'
import {
  KIND_LABEL,
  conflictsOf,
  failureMessage,
  fieldDeleteBlocked,
  fieldFieldsOf,
  kindsText,
  moveOption,
  openDraft,
  optionDeleteBlocked,
  optionFieldsOf,
  rebase,
  shownFields,
  shownOptions,
  toggleKind,
} from '../lib/field-settings'
import type {
  Draft,
  Field,
  FieldFields,
  Option,
  OptionFields,
} from '../lib/field-settings'
import { cachedTenant, useCanManageList, useTenant } from '../lib/tenant'

export const Route = createFileRoute('/t/$slug/settings/fields')({
  component: FieldsPage,
  loader: ({ context: { convex }, params }) => {
    const tenant = cachedTenant(convex, params.slug)
    if (!tenant) return
    convex.prewarmQuery({
      query: api.contacts.fields.list,
      args: { tenantId: tenant._id },
    })
  },
})

type MarkOpen = (id: string, isOpen: boolean) => void

/** Rows with an editor open, which stay shown when archived meanwhile. */
function useOpenRows(): [ReadonlySet<string>, MarkOpen] {
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
  return [open, markOpen]
}

/** Keep `id` in the open set while `isOpen`. */
function useMarkOpen(id: string, isOpen: boolean, markOpen: MarkOpen) {
  useEffect(() => {
    if (!isOpen) return
    markOpen(id, true)
    return () => markOpen(id, false)
  }, [id, isOpen, markOpen])
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`

/**
 * The tenant's dropdown fields (dropdown fields plan, step 3): at most
 * FIELD_SLOTS, each applying to the kinds of contact chosen for it, with
 * options in the admin's order. Admins, and staff when the group allows
 * it, add and edit fields and options, archive them, delete them while
 * never used, and retire a field (a background clear of every value that
 * frees its slot); everyone else reads. Archived fields and options are
 * hidden unless "Show archived" is on; a row with an open editor stays
 * until it closes, whatever is archived meanwhile.
 */
function FieldsPage() {
  const tenant = useTenant()
  const canManage = useCanManageList('fields')
  const fields = useQuery(api.contacts.fields.list, { tenantId: tenant._id })
  const [showArchived, setShowArchived] = useState(false)
  const [open, markOpen] = useOpenRows()
  // What a finished retire did: one this tab ran, or one that ended
  // elsewhere while this tab showed the field.
  const [retired, setRetired] = useState<string | null>(null)
  // Fields this tab is retiring: their own message says how it went.
  const retiringHere = useRef(new Set<string>())
  const seen = useRef<ReadonlyArray<Field> | undefined>(undefined)
  useEffect(() => {
    if (!fields) return
    const before = seen.current
    seen.current = fields
    if (!before) return
    const now = new Set<string>(fields.map((f) => f._id))
    const gone = before.filter(
      (f) => f.retiring && !now.has(f._id) && !retiringHere.current.has(f._id),
    )
    if (gone.length) {
      setRetired(
        gone
          .map(
            (f) =>
              `${f.label} has been retired: its values are cleared and its place is free for a new field.`,
          )
          .join(' '),
      )
    }
  }, [fields])
  const onRetireStart = useCallback((id: string) => {
    retiringHere.current.add(id)
  }, [])
  const shown = fields ? shownFields(fields, showArchived, open) : []
  // Archived fields left out, and archived options of the fields shown.
  const hidden =
    (fields?.length ?? 0) -
    shown.length +
    shown.reduce((n, f) => n + f.options.filter((o) => !o.isActive).length, 0)
  const full = (fields?.length ?? 0) >= FIELD_SLOTS

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold">Fields</h2>
        <p className="mt-1 text-sm text-neutral-600">
          Dropdowns your group defines for its contacts, such as “Volunteer
          status: Active / Lapsed”. Each contact holds one option per field, or
          none, and the contacts list can be filtered by any field. A group can
          have up to {FIELD_SLOTS}.
        </p>
        <p className="mt-1 text-sm text-neutral-600">
          A field is not consent: whether someone wants the newsletter belongs
          in their communication preferences, not here.
        </p>
      </div>
      <StaffListSwitch kind="fields" />
      {retired && (
        <p
          role="status"
          className="flex items-baseline gap-3 rounded border border-green-200 bg-green-50 px-4 py-2 text-sm text-green-900"
        >
          <span className="flex-1">{retired}</span>
          <button
            type="button"
            onClick={() => setRetired(null)}
            className="text-xs underline"
          >
            dismiss
          </button>
        </p>
      )}
      {canManage && fields !== undefined && <AddField full={full} />}
      {fields === undefined ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : (
        <section className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <h3 className="flex-1 font-medium">
              Fields{' '}
              <span className="text-sm font-normal text-neutral-500">
                ({fields.length} of {FIELD_SLOTS} in use)
              </span>
            </h3>
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
            <p className="text-sm text-neutral-500">
              {fields.length === 0 ? 'No fields yet.' : 'No active fields.'}
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {shown.map((f) => (
                <FieldCard
                  key={f._id}
                  field={f}
                  showArchived={showArchived}
                  kept={!showArchived && !f.isActive && !f.retiring}
                  markOpen={markOpen}
                  onRetireStart={onRetireStart}
                  onRetired={setRetired}
                />
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  )
}

/** One checkbox per kind of contact; at least one stays on. */
function KindsChooser({
  value,
  onChange,
  name,
}: {
  value: ReadonlyArray<ContactKind>
  onChange: (kinds: Array<ContactKind>) => void
  /** The field's label, for the group's accessible name. */
  name: string
}) {
  return (
    <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
      <legend className="sr-only">Applies to ({name})</legend>
      <span aria-hidden className="text-neutral-600">
        Applies to
      </span>
      {CONTACT_KINDS.map((k) => (
        <label key={k} className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={value.includes(k)}
            // The last one can't go: a field applies to at least one kind.
            disabled={value.length === 1 && value.includes(k)}
            onChange={(e) => onChange(toggleKind(value, k, e.target.checked))}
          />
          {KIND_LABEL[k]}
        </label>
      ))}
    </fieldset>
  )
}

/** A label, the kinds it applies to, and an Add button. */
function AddField({ full }: { full: boolean }) {
  const tenant = useTenant()
  const create = useMutation(api.contacts.fields.createField)
  const [label, setLabel] = useState('')
  const [appliesTo, setAppliesTo] = useState<Array<ContactKind>>([
    ...CONTACT_KINDS,
  ])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await create({ tenantId: tenant._id, label, appliesTo, isActive: true })
      setLabel('')
      setAppliesTo([...CONTACT_KINDS])
    } catch (err) {
      setError(failureMessage(err))
    } finally {
      setBusy(false)
    }
  }

  if (full) {
    return (
      <p className="rounded border border-neutral-200 bg-neutral-50 px-4 py-2 text-sm text-neutral-600">
        All {FIELD_SLOTS} fields are in use. Retire one to free its place for a
        new field.
      </p>
    )
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <fieldset disabled={busy} className="flex min-w-0 flex-col gap-2">
        <div className="flex gap-2">
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="New field, e.g. Volunteer status"
            aria-label="New field"
            maxLength={FIELD_LABEL_MAX}
            className="min-w-0 flex-1 rounded border border-neutral-300 px-3 py-1.5"
          />
          <button
            type="submit"
            disabled={busy || !label.trim()}
            className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-40"
          >
            Add field
          </button>
        </div>
        <KindsChooser
          value={appliesTo}
          onChange={setAppliesTo}
          name="new field"
        />
      </fieldset>
      {error && (
        <span role="alert" className="text-sm text-red-700">
          {error}
        </span>
      )}
    </form>
  )
}

function FieldCard({
  field,
  showArchived,
  kept,
  markOpen,
  onRetireStart,
  onRetired,
}: {
  field: Field
  showArchived: boolean
  /** Archived and shown only while an editor in it is open. */
  kept: boolean
  markOpen: MarkOpen
  onRetireStart: (id: string) => void
  onRetired: (message: string) => void
}) {
  const tenant = useTenant()
  const canManage = useCanManageList('fields')
  const save = useMutation(api.contacts.fields.saveField)
  const remove = useMutation(api.contacts.fields.deleteField)
  const reorder = useMutation(api.contacts.fields.reorderOptions)
  const retire = useAction(api.contacts.fields.retireField)
  const [editing, setEditing] = useState(false)
  // The counter each confirm opened on; null while it is closed. Confirming
  // acts against it, so a change made meanwhile refuses as stale.
  const [archiving, setArchiving] = useState<number | null>(null)
  const [deleting, setDeleting] = useState<number | null>(null)
  const [confirmRetire, setConfirmRetire] = useState(false)
  // A retire this tab started and is waiting on.
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [open, markOptionOpen] = useOpenRows()
  // An option's open rename keeps the whole card shown too.
  useMarkOpen(field._id, editing || open.size > 0, markOpen)
  // The option last moved here and its index before the move, until the
  // move shows: its row then takes focus back (see OptionRow's `refocus`).
  const [moved, setMoved] = useState<{
    id: Option['_id']
    by: -1 | 1
    from: number
  } | null>(null)
  // The polite announcement of where it went.
  const [position, setPosition] = useState('')

  const options = shownOptions(field.options, showArchived, open)
  const hiddenOptions = field.options.length - options.length
  const blocked = fieldDeleteBlocked(field)
  const retiring = running || field.retiring
  const manage = canManage && !retiring
  const dim = field.isActive ? '' : 'opacity-60'
  // The retire refuses every edit to the field, so an open editor closes.
  const [closed, setClosed] = useState(false)
  useEffect(() => {
    if (!retiring || !editing) return
    setEditing(false)
    setClosed(true)
  }, [retiring, editing])

  const movedTo = moved ? options.findIndex((o) => o._id === moved.id) : -1
  const landed = moved !== null && movedTo !== -1 && movedTo !== moved.from
  useEffect(() => {
    if (!landed) return
    const o = options[movedTo]
    setPosition(`${o.label}, position ${movedTo + 1} of ${options.length}`)
  }, [landed, movedTo, options])

  async function setActive(isActive: boolean, expected: number) {
    setArchiving(null)
    setError(null)
    setBusy(true)
    try {
      await save({
        tenantId: tenant._id,
        id: field._id,
        expected,
        ...fieldFieldsOf(field),
        isActive,
      })
    } catch (err) {
      setError(failureMessage(err, 'row'))
    } finally {
      setBusy(false)
    }
  }

  async function confirmDelete(expected: number) {
    setDeleting(null)
    setError(null)
    setBusy(true)
    try {
      await remove({ tenantId: tenant._id, id: field._id, expected })
    } catch (err) {
      setError(failureMessage(err, 'row'))
      setBusy(false)
    }
  }

  async function runRetire() {
    setConfirmRetire(false)
    setError(null)
    setRunning(true)
    onRetireStart(field._id)
    try {
      const { cleared } = await retire({ tenantId: tenant._id, id: field._id })
      // The field has left the list (its slot is free), so this card is
      // about to go: the page says what happened.
      onRetired(
        `Retired ${field.label}: cleared from ${plural(cleared, 'contact')}. Its place is free for a new field.`,
      )
    } catch (err) {
      setError(failureMessage(err, 'row'))
      setRunning(false)
    }
  }

  // Ignored while a move is in flight rather than disabling the buttons,
  // which would drop keyboard focus.
  const moving = useRef(false)
  async function move(id: Option['_id'], by: -1 | 1) {
    if (moving.current) return
    const order = moveOption(field.options, options, id, by)
    if (!order) return
    moving.current = true
    setError(null)
    setMoved({ id, by, from: options.findIndex((o) => o._id === id) })
    try {
      await reorder({ tenantId: tenant._id, fieldId: field._id, order })
    } catch (err) {
      setMoved(null)
      setError(failureMessage(err, 'row'))
    } finally {
      moving.current = false
    }
  }

  const optionCount = field.options.length

  return (
    <li
      data-testid="field"
      className="flex flex-col gap-2 rounded border border-neutral-200 bg-white px-4 py-3"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span
          className={`flex min-w-0 flex-1 flex-wrap items-baseline gap-2 ${dim}`}
        >
          <span className="font-medium break-words">{field.label}</span>
          <span className="text-xs text-neutral-500">
            for {kindsText(field.appliesTo)}
          </span>
          {field.retiring ? (
            <span className="rounded bg-amber-100 px-1.5 text-xs text-amber-900">
              retiring
            </span>
          ) : (
            !field.isActive && (
              <span className="rounded bg-neutral-200 px-1.5 text-xs text-neutral-700">
                archived
              </span>
            )
          )}
        </span>
        {manage && !editing && (
          <span className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="text-xs text-neutral-600 underline"
            >
              edit
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                field.isActive
                  ? setArchiving(field.saveVersion)
                  : void setActive(true, field.saveVersion)
              }
              className="text-xs text-neutral-600 underline"
            >
              {field.isActive ? 'archive' : 'reactivate'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirmRetire(true)}
              className="text-xs text-red-700 underline"
            >
              retire
            </button>
            {/* A disabled button gets no hover in every browser, so the
                reason's tooltip sits on a wrapper. */}
            <span title={blocked ?? undefined}>
              <button
                type="button"
                disabled={busy || blocked !== null}
                aria-describedby={blocked ? `${field._id}-blocked` : undefined}
                onClick={() => setDeleting(field.saveVersion)}
                className="text-xs text-red-700 underline disabled:text-neutral-400 disabled:no-underline"
              >
                delete
              </button>
            </span>
            {blocked && (
              <span id={`${field._id}-blocked`} className="sr-only">
                {blocked}
              </span>
            )}
          </span>
        )}
      </div>
      {kept && (
        <span role="status" className="text-xs text-amber-700">
          Archived while this was open. It stays here until you close it, then
          hides with the other archived fields.
        </span>
      )}
      {retiring && (
        <RetireProgress
          label={field.label}
          running={running}
          canManage={canManage}
          onResume={() => void runRetire()}
        />
      )}
      {closed && (
        <span role="status" className="text-xs text-amber-700">
          Your edit was closed unsaved: this field is being retired, so it can’t
          be changed.
        </span>
      )}
      {editing && <EditField field={field} onDone={() => setEditing(false)} />}
      {error && (
        <span role="alert" className="text-xs text-red-700">
          {error}
        </span>
      )}
      <div className={`flex flex-col gap-2 ${dim}`}>
        {options.length === 0 ? (
          <p className="text-sm text-neutral-500">
            {optionCount === 0
              ? 'No options yet.'
              : `No active options (${plural(hiddenOptions, 'archived option')}).`}
          </p>
        ) : (
          <ol
            aria-label={`Options of ${field.label}`}
            className="divide-y divide-neutral-100 rounded border border-neutral-100"
          >
            {options.map((o, i) => (
              <OptionRow
                key={o._id}
                option={o}
                fieldLabel={field.label}
                manage={manage}
                busy={busy}
                retiring={retiring}
                first={i === 0}
                last={i === options.length - 1}
                kept={!showArchived && !o.isActive}
                markOpen={markOptionOpen}
                onMove={(by) => void move(o._id, by)}
                refocus={landed && moved.id === o._id ? moved.by : null}
                onRefocused={() => setMoved(null)}
              />
            ))}
          </ol>
        )}
        <span role="status" aria-live="polite" className="sr-only">
          {position}
        </span>
        {manage && <AddOption field={field} />}
      </div>
      <ConfirmDialog
        open={archiving !== null}
        title={`Archive ${field.label}?`}
        description="It leaves the contact form and the contacts list’s filters. Contacts keep their values, and you can reactivate it later."
        confirm="Archive"
        cancel="Keep it"
        onConfirm={() => void setActive(false, archiving ?? field.saveVersion)}
        onCancel={() => setArchiving(null)}
      />
      <ConfirmDialog
        open={deleting !== null}
        title={`Delete ${field.label}?`}
        description={
          optionCount > 0
            ? `This also deletes its ${plural(optionCount, 'option')}. None has been used on a contact.`
            : 'It has no options yet.'
        }
        confirm="Delete"
        cancel="Keep it"
        onConfirm={() => void confirmDelete(deleting ?? field.saveVersion)}
        onCancel={() => setDeleting(null)}
      />
      <ConfirmDialog
        open={confirmRetire}
        title={`Retire ${field.label}?`}
        description={`This clears ${field.label} from every contact that has a value in it, and frees its place for a new field. Each change is recorded in the contact’s history, but it can’t be undone: restoring an old version of a contact won’t bring the value back. It runs in the background and can take a few minutes in a large group; contacts can’t be given a value meanwhile.`}
        confirm="Retire field"
        cancel="Keep it"
        onConfirm={() => void runRetire()}
        onCancel={() => setConfirmRetire(false)}
      />
    </li>
  )
}

/**
 * A retire under way. `running`: this tab started it and is waiting for it
 * to end. Otherwise the field is marked retiring by a retire run elsewhere,
 * still going or stopped part way, and running it again carries on.
 */
function RetireProgress({
  label,
  running,
  canManage,
  onResume,
}: {
  label: string
  running: boolean
  canManage: boolean
  onResume: () => void
}) {
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
    >
      {running ? (
        <>
          <span
            aria-hidden
            className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-amber-300 border-t-amber-800"
          />
          <span className="flex-1">
            Retiring {label}: clearing its value from every contact. It carries
            on if you leave this page.
          </span>
        </>
      ) : (
        <>
          <span className="flex-1">
            {label} is being retired: its values are being cleared, or a retire
            stopped part way. Contacts can’t be given a value meanwhile.
          </span>
          {canManage && (
            <button
              type="button"
              onClick={onResume}
              className="rounded border border-amber-400 px-2 py-0.5 text-xs hover:bg-amber-100"
            >
              Continue retiring
            </button>
          )}
        </>
      )}
    </div>
  )
}

/** Small markers on an edited field that someone else changed meanwhile. */
function conflictNote(changedTo: string) {
  return (
    <span className="text-xs text-amber-700">
      changed by someone else to “{changedTo}”; yours is kept
    </span>
  )
}

/**
 * The field's inline editor: label and kinds. A save someone else makes
 * meanwhile is merged in (`rebase`), and the next save goes against it.
 */
function EditField({ field, onDone }: { field: Field; onDone: () => void }) {
  const tenant = useTenant()
  const save = useMutation(api.contacts.fields.saveField)
  const [draft, setDraft] = useState<Draft<FieldFields>>(() =>
    openDraft(fieldFieldsOf(field), field.saveVersion),
  )
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setDraft((d) => rebase(d, fieldFieldsOf(field), field.saveVersion))
  }, [field])

  const set = <TKey extends keyof FieldFields>(
    key: TKey,
    value: FieldFields[TKey],
  ) =>
    setDraft((d) =>
      conflictsOf({ ...d, fields: { ...d.fields, [key]: value } }),
    )

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await save({
        tenantId: tenant._id,
        id: field._id,
        expected: draft.baseVersion,
        ...draft.fields,
        isActive: field.isActive,
      })
      onDone()
    } catch (err) {
      setError(failureMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2 py-1">
      {/* Disabled while saving: typing then would be lost when the
          editor closes on the save it isn't part of. */}
      <fieldset disabled={busy} className="flex min-w-0 flex-col gap-2">
        <label className="flex flex-col gap-1 text-sm">
          <span>Label</span>
          <input
            type="text"
            value={draft.fields.label}
            onChange={(e) => set('label', e.target.value)}
            aria-label={`Label of ${field.label}`}
            maxLength={FIELD_LABEL_MAX}
            autoFocus
            className="rounded border border-neutral-300 px-2 py-1"
          />
          {draft.conflicts.includes('label') &&
            conflictNote(draft.base.label || 'blank')}
        </label>
        <div className="flex flex-col gap-1">
          <KindsChooser
            value={draft.fields.appliesTo}
            onChange={(kinds) => set('appliesTo', kinds)}
            name={field.label}
          />
          {draft.conflicts.includes('appliesTo') &&
            conflictNote(kindsText(draft.base.appliesTo))}
          <span className="text-xs text-neutral-500">
            Taking a kind away keeps the values contacts of that kind already
            have; they just can’t be given new ones.
          </span>
        </div>
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

function OptionRow({
  option,
  fieldLabel,
  manage,
  busy: fieldBusy,
  retiring,
  first,
  last,
  kept,
  markOpen,
  onMove,
  refocus,
  onRefocused,
}: {
  option: Option
  fieldLabel: string
  manage: boolean
  /** A field-level change is in flight. */
  busy: boolean
  /** The field is being retired: no edits. */
  retiring: boolean
  first: boolean
  last: boolean
  /** Archived and shown only while its editor is open. */
  kept: boolean
  markOpen: MarkOpen
  onMove: (by: -1 | 1) => void
  /**
   * This option was just moved this way and the move now shows: focus
   * goes back to the same arrow, or the other one at the end of the list.
   */
  refocus: -1 | 1 | null
  onRefocused: () => void
}) {
  const tenant = useTenant()
  const save = useMutation(api.contacts.fields.saveOption)
  const remove = useMutation(api.contacts.fields.deleteOption)
  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState<number | null>(null)
  // The counter the archive confirm opened on; null while it is closed.
  const [archiving, setArchiving] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [closed, setClosed] = useState(false)
  useMarkOpen(option._id, editing, markOpen)
  const blocked = optionDeleteBlocked(option)
  const off = busy || fieldBusy
  const up = useRef<HTMLButtonElement>(null)
  const down = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!retiring || !editing) return
    setEditing(false)
    setClosed(true)
  }, [retiring, editing])

  useEffect(() => {
    if (refocus === null) return
    const target =
      (refocus === -1 && !first) || last ? up.current : down.current
    target?.focus()
    onRefocused()
  }, [refocus, first, last, onRefocused])

  async function setActive(isActive: boolean, expected: number) {
    setArchiving(null)
    setError(null)
    setBusy(true)
    try {
      await save({
        tenantId: tenant._id,
        id: option._id,
        expected,
        label: option.label,
        isActive,
      })
    } catch (err) {
      setError(failureMessage(err, 'row'))
    } finally {
      setBusy(false)
    }
  }

  async function confirmDelete(expected: number) {
    setDeleting(null)
    setError(null)
    setBusy(true)
    try {
      await remove({ tenantId: tenant._id, id: option._id, expected })
    } catch (err) {
      setError(failureMessage(err, 'row'))
      setBusy(false)
    }
  }

  return (
    <li data-testid="field-option" className="flex flex-col gap-1 px-3 py-1.5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {editing ? (
          <EditOption option={option} onDone={() => setEditing(false)} />
        ) : (
          <span
            className={`flex min-w-0 flex-1 items-baseline gap-2 text-sm ${option.isActive ? '' : 'opacity-60'}`}
          >
            <span className="break-words">{option.label}</span>
            {!option.isActive && (
              <span className="rounded bg-neutral-200 px-1.5 text-xs text-neutral-700">
                archived
              </span>
            )}
          </span>
        )}
        {manage && !editing && (
          <span className="flex flex-wrap items-baseline gap-3">
            <button
              ref={up}
              type="button"
              disabled={first}
              aria-label={`Move ${option.label} up`}
              onClick={() => onMove(-1)}
              className="text-xs text-neutral-600 disabled:text-neutral-300"
            >
              ↑
            </button>
            <button
              ref={down}
              type="button"
              disabled={last}
              aria-label={`Move ${option.label} down`}
              onClick={() => onMove(1)}
              className="text-xs text-neutral-600 disabled:text-neutral-300"
            >
              ↓
            </button>
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="text-xs text-neutral-600 underline"
            >
              rename
            </button>
            <button
              type="button"
              disabled={off}
              onClick={() =>
                option.isActive
                  ? setArchiving(option.saveVersion)
                  : void setActive(true, option.saveVersion)
              }
              className="text-xs text-neutral-600 underline"
            >
              {option.isActive ? 'archive' : 'reactivate'}
            </button>
            <span title={blocked ?? undefined}>
              <button
                type="button"
                disabled={off || blocked !== null}
                aria-describedby={blocked ? `${option._id}-blocked` : undefined}
                onClick={() => setDeleting(option.saveVersion)}
                className="text-xs text-red-700 underline disabled:text-neutral-400 disabled:no-underline"
              >
                delete
              </button>
            </span>
            {blocked && (
              <span id={`${option._id}-blocked`} className="sr-only">
                {blocked}
              </span>
            )}
          </span>
        )}
      </div>
      {kept && (
        <span role="status" className="text-xs text-amber-700">
          Archived while this was open. It stays here until you close it.
        </span>
      )}
      {closed && (
        <span role="status" className="text-xs text-amber-700">
          Your rename was closed unsaved: {fieldLabel} is being retired, so its
          options can’t be changed.
        </span>
      )}
      {error && (
        <span role="alert" className="text-xs text-red-700">
          {error}
        </span>
      )}
      <ConfirmDialog
        open={deleting !== null}
        title={`Delete ${option.label}?`}
        description={`It leaves ${fieldLabel} for good. It has never been used on a contact.`}
        confirm="Delete"
        cancel="Keep it"
        onConfirm={() => void confirmDelete(deleting ?? option.saveVersion)}
        onCancel={() => setDeleting(null)}
      />
      <ConfirmDialog
        open={archiving !== null}
        title={`Archive ${option.label}?`}
        description={`It leaves the ${fieldLabel} dropdown. Contacts that have it keep it, and you can reactivate it later.`}
        confirm="Archive"
        cancel="Keep it"
        onConfirm={() => void setActive(false, archiving ?? option.saveVersion)}
        onCancel={() => setArchiving(null)}
      />
    </li>
  )
}

/** An option's inline rename, merging a rename made meanwhile. */
function EditOption({
  option,
  onDone,
}: {
  option: Option
  onDone: () => void
}) {
  const tenant = useTenant()
  const save = useMutation(api.contacts.fields.saveOption)
  const [draft, setDraft] = useState<Draft<OptionFields>>(() =>
    openDraft(optionFieldsOf(option), option.saveVersion),
  )
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setDraft((d) => rebase(d, optionFieldsOf(option), option.saveVersion))
  }, [option])

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await save({
        tenantId: tenant._id,
        id: option._id,
        expected: draft.baseVersion,
        label: draft.fields.label,
        isActive: option.isActive,
      })
      onDone()
    } catch (err) {
      setError(failureMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="flex min-w-0 flex-1 flex-col gap-1">
      <fieldset disabled={busy} className="flex min-w-0 flex-col gap-1">
        <div className="flex gap-2">
          <input
            type="text"
            value={draft.fields.label}
            onChange={(e) =>
              setDraft((d) =>
                conflictsOf({ ...d, fields: { label: e.target.value } }),
              )
            }
            aria-label={`Rename ${option.label}`}
            maxLength={FIELD_LABEL_MAX}
            autoFocus
            className="min-w-0 flex-1 rounded border border-neutral-300 px-2 py-0.5 text-sm"
          />
          <button
            type="submit"
            disabled={busy}
            className="rounded bg-neutral-900 px-2 py-0.5 text-xs text-white hover:bg-neutral-700"
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
        {draft.conflicts.includes('label') &&
          conflictNote(draft.base.label || 'blank')}
        {error && (
          <span role="alert" className="text-xs text-red-700">
            {error}
          </span>
        )}
      </fieldset>
    </form>
  )
}

/** A new option at the end of the field's list. */
function AddOption({ field }: { field: Field }) {
  const tenant = useTenant()
  const add = useMutation(api.contacts.fields.addOption)
  const [label, setLabel] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const name = `New option for ${field.label}`

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await add({ tenantId: tenant._id, fieldId: field._id, label })
      setLabel('')
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
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="New option"
          aria-label={name}
          maxLength={FIELD_LABEL_MAX}
          disabled={busy}
          className="min-w-0 flex-1 rounded border border-neutral-300 px-2 py-1 text-sm"
        />
        <button
          type="submit"
          disabled={busy || !label.trim()}
          className="rounded border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-50 disabled:opacity-40"
        >
          Add option
        </button>
      </div>
      {error && (
        <span role="alert" className="text-xs text-red-700">
          {error}
        </span>
      )}
    </form>
  )
}
