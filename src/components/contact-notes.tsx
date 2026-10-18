import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import type { Doc, Id } from '../../convex/_generated/dataModel'
import { api } from '../../convex/_generated/api'
import { useCanWrite, useTenant } from '../lib/tenant'
import type { Draft, Gone } from '../lib/notes'
import {
  budget,
  budgetMessage,
  composerBlur,
  composerUnsaved,
  edited,
  editorBlur,
  editorUnsaved,
  failureMessage,
  openDraft,
  rebase,
  withOpenEdits,
} from '../lib/notes'
import { useReportUnsaved } from '../lib/unsaved'
import { ConfirmDialog } from './confirm-dialog'

type Note = Doc<'contactNotes'>
type NameOf = (userId: Id<'users'> | undefined) => string
type Entry = { note: Note; gone: Gone | null }

/** Live notes (pinned first, then newest), plus the archived ones on demand. */
export function ContactNotes({ contactId }: { contactId: Id<'contacts'> }) {
  const tenant = useTenant()
  const canWrite = useCanWrite()
  const [showArchived, setShowArchived] = useState(false)
  // Open editors, by note id, with the note as it was when opened. Held
  // here so an editor outlives its note leaving the live list.
  const [open, setOpen] = useState<Record<string, Note>>({})
  const live = useQuery(api.contacts.notes.forContact, {
    tenantId: tenant._id,
    id: contactId,
  })
  const liveIds = new Set(live?.notes.map((n) => n._id))
  const orphaned = Object.keys(open).some((id) => !liveIds.has(id as never))
  const archived = useQuery(
    api.contacts.notes.archivedForContact,
    showArchived || (live && orphaned)
      ? { tenantId: tenant._id, id: contactId }
      : 'skip',
  )
  const members = useQuery(api.platform.tenants.members, {
    tenantId: tenant._id,
  })
  const nameOf: NameOf = (userId) =>
    userId === undefined
      ? 'system'
      : (members?.find((m) => m.userId === userId)?.name ?? 'someone')
  const setEditing = (note: Note, on: boolean) =>
    setOpen(({ [note._id]: _, ...rest }) =>
      on ? { ...rest, [note._id]: note } : rest,
    )
  const entries = live ? withOpenEdits(live.notes, open, archived?.notes) : []

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-medium">Notes</h2>
        <label className="flex items-center gap-1 text-xs text-neutral-600">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          show archived
        </label>
      </div>
      {canWrite && <Composer contactId={contactId} />}
      {live === undefined ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-neutral-500">No notes yet.</p>
      ) : (
        <NoteList
          entries={entries}
          truncated={live.truncated}
          nameOf={nameOf}
          editing={(n) => n._id in open}
          setEditing={setEditing}
        />
      )}
      {showArchived && (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium text-neutral-600">Archived</h3>
          {archived === undefined ? (
            <p className="text-sm text-neutral-500">Loading…</p>
          ) : archived.notes.length === 0 ? (
            <p className="text-sm text-neutral-500">No archived notes.</p>
          ) : (
            <NoteList
              entries={archived.notes.map((note) => ({ note, gone: null }))}
              truncated={archived.truncated}
              nameOf={nameOf}
              editing={() => false}
              setEditing={setEditing}
            />
          )}
        </div>
      )}
    </section>
  )
}

/** One keyed list, so an editor whose note leaves it stays mounted. */
function NoteList({
  entries,
  truncated,
  nameOf,
  editing,
  setEditing,
}: {
  entries: Array<Entry>
  truncated: boolean
  nameOf: NameOf
  editing: (note: Note) => boolean
  setEditing: (note: Note, on: boolean) => void
}) {
  const listed = entries.filter((e) => e.gone === null).length
  return (
    <>
      <ul className="flex flex-col gap-2">
        {entries.map(({ note, gone }) => (
          <NoteItem
            key={note._id}
            note={note}
            gone={gone}
            nameOf={nameOf}
            editing={editing(note)}
            setEditing={(on) => setEditing(note, on)}
          />
        ))}
      </ul>
      {truncated && (
        <p className="text-xs text-neutral-500">
          Showing the {listed} most recent; older notes aren't listed.
        </p>
      )}
    </>
  )
}

/**
 * Adds a note on "Add note", or when focus leaves the composer with text
 * in it (`composerBlur`), pinned if the box is ticked. Moving between its
 * own controls is not leaving it.
 */
function Composer({ contactId }: { contactId: Id<'contacts'> }) {
  const tenant = useTenant()
  const create = useMutation(api.contacts.notes.create)
  const [text, setText] = useState('')
  const [pinned, setPinned] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A blur and the click that caused it can both ask; one create.
  const inFlight = useRef(false)
  const b = budget(text)
  useReportUnsaved(composerUnsaved(text, saving))

  const add = async () => {
    if (inFlight.current) return
    inFlight.current = true
    setSaving(true)
    setError(null)
    try {
      await create({ tenantId: tenant._id, contactId, body: text, pinned })
      setText('')
      setPinned(false)
    } catch (err) {
      setError(failureMessage(err))
    } finally {
      inFlight.current = false
      setSaving(false)
    }
  }

  return (
    <form
      className="flex flex-col gap-1"
      onSubmit={(e) => {
        e.preventDefault()
        void add()
      }}
      onBlur={(e) => {
        if (leavesForm(e) && composerBlur(text, { saving }) === 'create')
          void add()
      }}
    >
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        readOnly={saving}
        placeholder="Add a note…"
        rows={3}
        className="w-full rounded border border-neutral-300 px-3 py-1.5 text-sm"
      />
      <BudgetLine body={text} />
      {error && <p className="text-xs text-red-700">{error}</p>}
      <div
        className="flex items-center justify-end gap-3"
        onMouseDown={keepFocus}
      >
        <label className="flex items-center gap-1 text-xs text-neutral-600">
          <input
            type="checkbox"
            checked={pinned}
            onChange={(e) => setPinned(e.target.checked)}
          />
          pin
        </label>
        <button
          type="submit"
          disabled={saving || b.bytes === 0 || b.level === 'over'}
          className="rounded bg-neutral-900 px-2 py-1 text-xs text-white hover:bg-neutral-700 disabled:opacity-50"
        >
          {saving ? 'Adding…' : 'Add note'}
        </button>
      </div>
    </form>
  )
}

function NoteItem({
  note,
  gone,
  nameOf,
  editing,
  setEditing,
}: {
  note: Note
  gone: Gone | null
  nameOf: NameOf
  editing: boolean
  setEditing: (on: boolean) => void
}) {
  const tenant = useTenant()
  const canWrite = useCanWrite()
  const setPinned = useMutation(api.contacts.notes.setPinned)
  const setArchived = useMutation(api.contacts.notes.setArchived)
  const [error, setError] = useState<string | null>(null)

  const run = async (op: Promise<unknown>) => {
    setError(null)
    try {
      await op
    } catch (err) {
      setError(failureMessage(err))
    }
  }

  return (
    <li
      className={`flex flex-col gap-1 rounded border p-2 text-sm ${note.archived ? 'border-neutral-200 bg-neutral-50 text-neutral-600' : note.pinned ? 'border-amber-300 bg-amber-50' : 'border-neutral-200 bg-white'}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-xs text-neutral-500">
        <span>
          {note.pinned && !note.archived && (
            <span className="mr-1 rounded bg-amber-200 px-1 text-amber-900">
              pinned
            </span>
          )}
          {nameOf(note.createdBy)} · {when(note._creationTime)}
          {note.bodyVersion > 0 && (
            <>
              {' '}
              · edited {when(note.editedAt)}
              {note.editedBy !== note.createdBy &&
                ` by ${nameOf(note.editedBy)}`}
            </>
          )}
        </span>
        {!editing && canWrite && (
          <span className="flex gap-2">
            {!note.archived && (
              <>
                <TextButton onClick={() => setEditing(true)}>edit</TextButton>
                <TextButton
                  onClick={() =>
                    void run(
                      setPinned({
                        tenantId: tenant._id,
                        id: note._id,
                        pinned: !note.pinned,
                      }),
                    )
                  }
                >
                  {note.pinned ? 'unpin' : 'pin'}
                </TextButton>
              </>
            )}
            <TextButton
              onClick={() =>
                void run(
                  setArchived({
                    tenantId: tenant._id,
                    id: note._id,
                    archived: !note.archived,
                  }),
                )
              }
            >
              {note.archived ? 'restore' : 'archive'}
            </TextButton>
          </span>
        )}
      </div>
      {editing ? (
        <Editor
          note={note}
          gone={gone}
          nameOf={nameOf}
          onDone={() => setEditing(false)}
        />
      ) : (
        <p className="whitespace-pre-wrap break-words">{note.body}</p>
      )}
      {error && <p className="text-xs text-red-700">{error}</p>}
    </li>
  )
}

/**
 * Edits one note's body against the `bodyVersion` it was opened at. A
 * newer body arriving meanwhile is merged by `rebase`: untouched text
 * follows it, diverging text is kept and flagged with theirs on offer.
 * If the note leaves the live list (`gone`), the draft stays here with a
 * notice: an archived note can be restored and saved in one go.
 *
 * Focus leaving the editor saves a plain edit (`editorBlur`) and closes
 * it if focus is still elsewhere when the save lands. Cancel and Escape
 * discard, asking first when the text differs from the note.
 */
function Editor({
  note,
  gone,
  nameOf,
  onDone,
}: {
  note: Note
  gone: Gone | null
  nameOf: NameOf
  onDone: () => void
}) {
  const tenant = useTenant()
  const save = useMutation(api.contacts.notes.save)
  const setArchived = useMutation(api.contacts.notes.setArchived)
  const [copied, setCopied] = useState(false)
  const [draft, setDraft] = useState<Draft>(() => openDraft(note))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  // Read by the blur handler in the same event that opens the dialog.
  const confirmingRef = useRef(false)
  const inFlight = useRef(false)
  useReportUnsaved(editorUnsaved(draft, saving))

  // While a save is in flight its own echo is on the way; the editor
  // closes on success, so only follow other people's changes.
  useEffect(() => {
    if (!saving) setDraft((d) => rebase(d, note))
  }, [note.body, note.bodyVersion, saving])

  const b = budget(draft.text)

  /**
   * `form` is given for a blur: the editor then stays open if focus has
   * come back into it by the time the save lands (a window switch, or a
   * click back in), rebased onto what was saved.
   */
  const submit = async (form?: HTMLFormElement) => {
    if (inFlight.current) return
    if (!edited(draft) && gone !== 'archived') return onDone()
    inFlight.current = true
    setSaving(true)
    setError(null)
    try {
      // Edits to an archived note are refused, so restore it first. Its
      // body can't have changed while archived, so the draft's base holds.
      if (gone === 'archived')
        await setArchived({
          tenantId: tenant._id,
          id: note._id,
          archived: false,
        })
      const saved = edited(draft)
        ? await save({
            tenantId: tenant._id,
            id: note._id,
            expected: draft.baseVersion,
            body: draft.text,
          })
        : null
      if (form?.contains(document.activeElement)) {
        if (saved)
          setDraft((d) => ({
            ...d,
            base: d.text.trim(),
            baseVersion: saved.counter,
          }))
      } else onDone()
    } catch (err) {
      setError(failureMessage(err))
    } finally {
      inFlight.current = false
      setSaving(false)
    }
  }

  const close = () => {
    if (!edited(draft)) return onDone()
    confirmingRef.current = true
    setConfirming(true)
  }

  return (
    <>
      <form
        className="flex flex-col gap-1"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
        onBlur={(e) => {
          if (confirmingRef.current || !leavesForm(e)) return
          if (editorBlur(draft, { gone, saving }) === 'save')
            void submit(e.currentTarget)
        }}
      >
        {gone !== null && (
          <p className="rounded border border-red-300 bg-red-50 px-2 py-1 text-xs text-red-800">
            {gone === 'archived'
              ? 'Someone archived this note while you were editing. Your text is kept here: restore and save it, or copy it and discard.'
              : 'This note has left the list while you were editing (archived, or pushed out by newer notes). Your text is kept here: save it, or copy it and discard.'}{' '}
            <TextButton
              onClick={() =>
                void navigator.clipboard
                  .writeText(draft.text)
                  .then(() => setCopied(true))
              }
            >
              {copied ? 'copied' : 'copy text'}
            </TextButton>
          </p>
        )}
        {draft.theirs !== null && (
          <p className="rounded border border-red-300 bg-red-50 px-2 py-1 text-xs text-red-800">
            {nameOf(note.editedBy)} changed this note while you were editing.
            Your text is kept and saving will replace theirs.{' '}
            <TextButton
              onClick={() =>
                setDraft((d) => ({ ...d, text: d.base, theirs: null }))
              }
            >
              use their version
            </TextButton>
          </p>
        )}
        <textarea
          value={draft.text}
          onChange={(e) => setDraft((d) => ({ ...d, text: e.target.value }))}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return
            e.preventDefault()
            close()
          }}
          readOnly={saving}
          rows={Math.min(12, Math.max(3, draft.text.split('\n').length + 1))}
          className="w-full rounded border border-neutral-300 px-3 py-1.5 text-sm"
          autoFocus
        />
        <BudgetLine body={draft.text} />
        {error && <p className="text-xs text-red-700">{error}</p>}
        <div className="flex justify-end gap-3" onMouseDown={keepFocus}>
          <TextButton onClick={close}>
            {gone === null ? 'cancel' : 'discard'}
          </TextButton>
          <button
            type="submit"
            disabled={saving || b.bytes === 0 || b.level === 'over'}
            className="rounded bg-neutral-900 px-2 py-1 text-xs text-white hover:bg-neutral-700 disabled:opacity-50"
          >
            {saving
              ? 'Saving…'
              : gone === 'archived'
                ? 'Restore and save'
                : 'Save'}
          </button>
        </div>
      </form>
      {/* Outside the form: its events must not reach the form's onBlur. */}
      <ConfirmDialog
        open={confirming}
        title="Discard your changes?"
        description="Your edits to this note haven't been saved."
        confirm="Discard"
        cancel="Keep editing"
        onConfirm={onDone}
        onCancel={() => {
          confirmingRef.current = false
          setConfirming(false)
        }}
      />
    </>
  )
}

/** Focus is moving out of the form, not between its own controls. */
function leavesForm(e: React.FocusEvent<HTMLFormElement>) {
  return !e.currentTarget.contains(e.relatedTarget)
}

/**
 * On a row of buttons: a press keeps focus where it is. Browsers that
 * don't focus a pressed button (Safari) would otherwise blur the text
 * first with nowhere to go, which reads as leaving the form.
 */
function keepFocus(e: React.MouseEvent) {
  e.preventDefault()
}

function BudgetLine({ body }: { body: string }) {
  const b = budget(body)
  const message = budgetMessage(b)
  if (!message) return null
  return (
    <p
      className={`text-xs ${b.level === 'over' ? 'text-red-700' : 'text-amber-700'}`}
    >
      {message}
    </p>
  )
}

function TextButton({
  onClick,
  children,
}: {
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-xs text-neutral-600 underline"
    >
      {children}
    </button>
  )
}

function when(at: number) {
  return new Date(at).toLocaleString([], {
    dateStyle: 'short',
    timeStyle: 'short',
  })
}
