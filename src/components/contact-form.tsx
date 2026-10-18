import { useMutation, useQuery } from 'convex/react'
import type { FunctionReturnType } from 'convex/server'
import { ConvexError } from 'convex/values'
import { useEffect, useReducer, useRef } from 'react'
import type { Id } from '../../convex/_generated/dataModel'
import { api } from '../../convex/_generated/api'
import type { Payloads } from '../../convex/contacts/validators'
import type {
  Counters,
  FormState,
  SaveResult,
  SliceName,
  Slices,
} from '../lib/contact-form-state'
import {
  initialState,
  reduce,
  submission,
  unsavedWork,
} from '../lib/contact-form-state'
import { useCanWrite, useTenant } from '../lib/tenant'
import { useReportUnsaved } from '../lib/unsaved'

type Data = NonNullable<FunctionReturnType<typeof api.contacts.queries.get>>
type Problem = { field: string; message: string }
type Label = 'home' | 'work' | 'other'

const LABELS: Array<Label> = ['home', 'work', 'other']
const AUTOSAVE_MS = 700

function toSlices(data: Data): Slices {
  const c = data.contact
  return {
    details: {
      kind: c.kind,
      title: c.title,
      firstName: c.firstName,
      lastName: c.lastName,
      nickname: c.nickname,
      name: c.name,
      birthDate: c.birthDate,
      isDeceased: c.isDeceased,
      deceasedDate: c.deceasedDate,
    },
    methods: {
      emails: data.emails.map((e) => ({
        key: e.key,
        label: e.label,
        address: e.address,
        isPrimary: e.isPrimary,
      })),
      phones: data.phones.map((p) => ({
        key: p.key,
        label: p.label,
        number: p.number,
        isPrimary: p.isPrimary,
      })),
    },
    addresses: {
      addresses: data.addresses.map((a) => ({
        key: a.key,
        label: a.label,
        line1: a.line1,
        line2: a.line2,
        line3: a.line3,
        town: a.town,
        postcode: a.postcode,
        country: a.country,
        isPrimary: a.isPrimary,
      })),
    },
    tags: { tags: data.tags.map((t) => ({ key: t.key, tagId: t.tagId })) },
  }
}

function toCounters(data: Data): Counters {
  return {
    details: data.contact.detailsVersion,
    methods: data.contact.methodsVersion,
    addresses: data.contact.addressesVersion,
    tags: data.contact.tagsVersion,
  }
}

export function ContactForm({ id, data }: { id: Id<'contacts'>; data: Data }) {
  const tenant = useTenant()
  const canWrite = useCanWrite()
  const saveForm = useMutation(api.contacts.mutations.saveForm)
  const members = useQuery(api.platform.tenants.members, {
    tenantId: tenant._id,
  })
  // Every tag, archived too: an archived tag a contact still carries needs
  // its name. One subscription shared with the list and the tags page.
  const allTags = useQuery(api.contacts.queries.tags, {
    tenantId: tenant._id,
    includeInactive: true,
  })
  const [state, dispatch] = useReducer(reduce, data, (d) =>
    initialState(toSlices(d), toCounters(d)),
  )
  const latest = useRef(state)
  latest.current = state
  // A tag pick is a whole edit with nothing left to type: save it now, not
  // after the autosave pause.
  const saveNow = useRef(false)

  // The live query: merge every server change per field (own saves are
  // recognised by counters inside the reducer and ignored).
  useEffect(() => {
    dispatch({
      type: 'server',
      slices: toSlices(data),
      counters: toCounters(data),
    })
  }, [data])

  async function save() {
    saveNow.current = false
    const current = latest.current
    const submitted = submission(current)
    if (Object.keys(submitted).length === 0) return
    dispatch({ type: 'saving' })
    const args: Record<string, unknown> = {
      tenantId: tenant._id,
      id,
      source: 'autosave',
    }
    for (const [slice, payload] of Object.entries(submitted)) {
      args[slice] = {
        expected: current.counters[slice as SliceName],
        ...payload,
      }
    }
    try {
      // The server knows the identifiers slice too; this form never sends
      // it (until X4b), so it never comes back saved, stale or invalid.
      const result = (await saveForm(args as never)) as SaveResult
      dispatch({ type: 'saved', submitted, result, at: Date.now() })
    } catch (err) {
      const detail =
        err instanceof ConvexError
          ? (err.data as Record<string, unknown>)
          : null
      dispatch({
        type: 'failed',
        message: detail
          ? String(detail.message ?? detail.kind)
          : 'Could not save',
      })
    }
  }

  useEffect(() => {
    if (!state.needsSave || state.status === 'saving') return
    // Straight away, as the Save button does: effects from a discrete input
    // run in the input's own task, so the mutation leaves before the next
    // frame instead of after it.
    if (saveNow.current) {
      void save()
      return
    }
    const timer = setTimeout(() => void save(), AUTOSAVE_MS)
    return () => clearTimeout(timer)
  }, [state.needsSave, state.status, state.local])

  // Leaving the page starts a queued save now instead of after the pause.
  useReportUnsaved(unsavedWork(state), () => {
    const current = latest.current
    if (current.needsSave && current.status !== 'saving') void save()
  })

  const edit = <TSlice extends SliceName>(
    slice: TSlice,
    value: Slices[TSlice],
  ) => dispatch({ type: 'edit', slice, value })
  const commit = () => dispatch({ type: 'commit' })

  const memberName = (userId: Id<'users'> | null) =>
    members?.find((m) => m.userId === userId)?.name ?? 'someone'

  const generalWarnings = data.warnings.filter((w) => w.anchor === '')
  const problemCount = Object.values(state.problems).reduce(
    (n, p) => n + p.length,
    0,
  )

  return (
    <form
      noValidate
      onBlur={commit}
      // Selects, checkboxes, radios and the row buttons are complete edits
      // in themselves: commit right after the child's own handler ran.
      onChange={(e) => {
        const t = e.target as unknown as HTMLInputElement
        if (
          t.tagName === 'SELECT' ||
          t.type === 'checkbox' ||
          t.type === 'radio'
        )
          commit()
      }}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('button[type="button"]')) commit()
      }}
      onSubmit={(e) => {
        e.preventDefault()
        commit()
        void save()
      }}
      className="flex flex-col gap-8"
    >
      <header>
        <h1 className="text-2xl font-semibold">
          {data.contact.displayName || 'New contact'}
        </h1>
        <p className="text-sm text-neutral-500">{data.contact.kind}</p>
      </header>

      {(generalWarnings.length > 0 ||
        Object.keys(state.stale).length > 0 ||
        state.conflicts.length > 0 ||
        state.error) && (
        <div className="flex flex-col gap-2" id="form-notices">
          {state.error && <Notice tone="error">{state.error}</Notice>}
          {Object.entries(state.stale).map(([slice]) => (
            <Notice key={slice} tone="error">
              {slice} changed by{' '}
              {memberName(latestActor(data, slice as SliceName))} while you were
              editing — their change has been merged; your edits will be saved
              against it.
            </Notice>
          ))}
          {state.conflicts.length > 0 && (
            <Notice tone="error">
              Changed by both of you: {state.conflicts.join(', ')}. Your value
              is kept — check it.
            </Notice>
          )}
          {generalWarnings.map((w) => (
            <Notice key={w.message} tone="warning">
              {w.message}
            </Notice>
          ))}
        </div>
      )}

      {/* Viewers see the same form, every control disabled (ADR 0020). */}
      <fieldset disabled={!canWrite} className="flex min-w-0 flex-col gap-8">
        <section>
          <h2 className="mb-3 text-lg font-medium">Details</h2>
          <DetailsFields
            value={state.local.details}
            onChange={(v) => edit('details', v)}
            problems={state.problems.details ?? []}
            conflicts={state.conflicts
              .filter((c) => c.startsWith('details.'))
              .map((c) => c.slice(8))}
          />
        </section>

        <MethodsFields
          value={state.local.methods}
          onChange={(v) => edit('methods', v)}
          problems={state.problems.methods ?? []}
          warnings={data.warnings}
        />

        <AddressFields
          value={state.local.addresses}
          onChange={(v) => edit('addresses', v)}
          problems={state.problems.addresses ?? []}
          warnings={data.warnings}
        />

        <TagFields
          value={state.local.tags}
          onChange={(v) => {
            saveNow.current = true
            edit('tags', v)
          }}
          problems={state.problems.tags ?? []}
          known={data.tags}
          allTags={allTags}
        />
      </fieldset>

      {canWrite && (
        <SavePane
          state={state}
          problemCount={problemCount}
          warningCount={data.warnings.length}
        />
      )}
    </form>
  )
}

function latestActor(_data: Data, _slice: SliceName): Id<'users'> | null {
  // The history query knows; the form only names the slice. Kept simple:
  // the history panel beside the form shows who, with the moment.
  return null
}

// ── fields ─────────────────────────────────────────────────────────────────

export function DetailsFields({
  value,
  onChange,
  problems,
  conflicts,
}: {
  value: Payloads['details']
  onChange: (v: Payloads['details']) => void
  problems: Array<Problem>
  conflicts: Array<string>
}) {
  const set = <TKey extends keyof Payloads['details']>(
    key: TKey,
    v: Payloads['details'][TKey],
  ) => onChange({ ...value, [key]: v })
  const text = (
    key: 'title' | 'firstName' | 'lastName' | 'nickname' | 'name',
    label: string,
  ) => (
    <Field
      label={label}
      message={problemFor(problems, key)}
      conflict={conflicts.includes(key)}
    >
      <input
        type="text"
        value={value[key]}
        onChange={(e) => set(key, e.target.value)}
        className="w-full rounded border border-neutral-300 px-3 py-1.5"
      />
    </Field>
  )
  const date = (key: 'birthDate' | 'deceasedDate', label: string) => (
    <Field
      label={label}
      message={problemFor(problems, key)}
      conflict={conflicts.includes(key)}
    >
      <input
        type="date"
        value={value[key] ?? ''}
        onChange={(e) => set(key, e.target.value || undefined)}
        className="rounded border border-neutral-300 px-3 py-1.5"
      />
    </Field>
  )
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {value.kind === 'individual' ? (
        <>
          {text('title', 'Title')}
          {text('firstName', 'First name')}
          {text('lastName', 'Last name')}
          {text('nickname', 'Known as')}
          {date('birthDate', 'Date of birth')}
          <Field
            label=""
            message={problemFor(problems, 'isDeceased')}
            conflict={conflicts.includes('isDeceased')}
          >
            <label className="flex items-center gap-2 pt-6 text-sm">
              <input
                type="checkbox"
                checked={value.isDeceased}
                onChange={(e) => set('isDeceased', e.target.checked)}
              />
              Deceased
            </label>
          </Field>
          {value.isDeceased && date('deceasedDate', 'Date of death')}
        </>
      ) : (
        text('name', 'Name')
      )}
    </div>
  )
}

function MethodsFields({
  value,
  onChange,
  problems,
  warnings,
}: {
  value: Payloads['methods']
  onChange: (v: Payloads['methods']) => void
  problems: Array<Problem>
  warnings: Data['warnings']
}) {
  return (
    <>
      <section>
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-lg font-medium">Emails</h2>
          <AddButton
            onClick={() =>
              onChange({
                ...value,
                emails: [
                  ...value.emails,
                  {
                    key: crypto.randomUUID(),
                    label: 'home',
                    address: '',
                    isPrimary: value.emails.length === 0,
                  },
                ],
              })
            }
          />
        </div>
        <Message message={problemFor(problems, 'emails', true)} tone="error" />
        <ul className="flex flex-col gap-2">
          {value.emails.map((row, i) => (
            <RowShell
              key={row.key}
              messages={rowMessages(
                problemFor(problems, `emails.${i}`),
                warnings,
                [`emails.${i}`, `emails#${row.key}`],
              )}
              primary={row.isPrimary}
              onPrimary={() =>
                onChange({
                  ...value,
                  emails: value.emails.map((e) => ({
                    ...e,
                    isPrimary: e === row,
                  })),
                })
              }
              onRemove={() =>
                onChange({
                  ...value,
                  emails: value.emails.filter((e) => e !== row),
                })
              }
              label={row.label}
              onLabel={(label) =>
                onChange({
                  ...value,
                  emails: value.emails.map((e) =>
                    e === row ? { ...e, label } : e,
                  ),
                })
              }
            >
              <input
                type="text"
                inputMode="email"
                placeholder="email address"
                value={row.address}
                onChange={(e) =>
                  onChange({
                    ...value,
                    emails: value.emails.map((r) =>
                      r === row ? { ...r, address: e.target.value } : r,
                    ),
                  })
                }
                className="flex-1 rounded border border-neutral-300 px-3 py-1.5"
              />
            </RowShell>
          ))}
        </ul>
      </section>
      <section>
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-lg font-medium">Phones</h2>
          <AddButton
            onClick={() =>
              onChange({
                ...value,
                phones: [
                  ...value.phones,
                  {
                    key: crypto.randomUUID(),
                    label: 'home',
                    number: '',
                    isPrimary: value.phones.length === 0,
                  },
                ],
              })
            }
          />
        </div>
        <Message message={problemFor(problems, 'phones', true)} tone="error" />
        <ul className="flex flex-col gap-2">
          {value.phones.map((row, i) => (
            <RowShell
              key={row.key}
              messages={rowMessages(
                problemFor(problems, `phones.${i}`),
                warnings,
                [],
              )}
              primary={row.isPrimary}
              onPrimary={() =>
                onChange({
                  ...value,
                  phones: value.phones.map((p) => ({
                    ...p,
                    isPrimary: p === row,
                  })),
                })
              }
              onRemove={() =>
                onChange({
                  ...value,
                  phones: value.phones.filter((p) => p !== row),
                })
              }
              label={row.label}
              onLabel={(label) =>
                onChange({
                  ...value,
                  phones: value.phones.map((p) =>
                    p === row ? { ...p, label } : p,
                  ),
                })
              }
            >
              <input
                type="text"
                inputMode="tel"
                placeholder="phone number"
                value={row.number}
                onChange={(e) =>
                  onChange({
                    ...value,
                    phones: value.phones.map((r) =>
                      r === row ? { ...r, number: e.target.value } : r,
                    ),
                  })
                }
                className="flex-1 rounded border border-neutral-300 px-3 py-1.5"
              />
            </RowShell>
          ))}
        </ul>
      </section>
    </>
  )
}

function AddressFields({
  value,
  onChange,
  problems,
  warnings,
}: {
  value: Payloads['addresses']
  onChange: (v: Payloads['addresses']) => void
  problems: Array<Problem>
  warnings: Data['warnings']
}) {
  const update = (
    row: Payloads['addresses']['addresses'][number],
    patch: Partial<typeof row>,
  ) =>
    onChange({
      addresses: value.addresses.map((a) =>
        a === row ? { ...a, ...patch } : a,
      ),
    })
  const input = (
    row: Payloads['addresses']['addresses'][number],
    key: 'line1' | 'line2' | 'line3' | 'town' | 'postcode' | 'country',
    placeholder: string,
    className = '',
  ) => (
    <input
      type="text"
      placeholder={placeholder}
      value={row[key]}
      onChange={(e) => update(row, { [key]: e.target.value })}
      className={`rounded border border-neutral-300 px-3 py-1.5 ${className}`}
    />
  )
  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-lg font-medium">Addresses</h2>
        <AddButton
          onClick={() =>
            onChange({
              addresses: [
                ...value.addresses,
                {
                  key: crypto.randomUUID(),
                  label: 'home',
                  line1: '',
                  line2: '',
                  line3: '',
                  town: '',
                  postcode: '',
                  country: 'GB',
                  isPrimary: value.addresses.length === 0,
                },
              ],
            })
          }
        />
      </div>
      <Message message={problemFor(problems, 'addresses', true)} tone="error" />
      <ul className="flex flex-col gap-3">
        {value.addresses.map((row, i) => (
          <RowShell
            key={row.key}
            messages={rowMessages(
              problemFor(problems, `addresses.${i}`),
              warnings,
              [`addresses.${i}`],
            )}
            primary={row.isPrimary}
            onPrimary={() =>
              onChange({
                addresses: value.addresses.map((a) => ({
                  ...a,
                  isPrimary: a === row,
                })),
              })
            }
            onRemove={() =>
              onChange({ addresses: value.addresses.filter((a) => a !== row) })
            }
            label={row.label}
            onLabel={(label) => update(row, { label })}
          >
            <div className="grid flex-1 gap-2 md:grid-cols-2">
              {input(row, 'line1', 'Address line 1', 'md:col-span-2')}
              {input(row, 'line2', 'Line 2')}
              {input(row, 'line3', 'Line 3')}
              {input(row, 'town', 'Town')}
              <div className="flex gap-2">
                {input(row, 'postcode', 'Postcode', 'flex-1')}
                {input(row, 'country', 'GB', 'w-16')}
              </div>
            </div>
          </RowShell>
        ))}
      </ul>
    </section>
  )
}

type TagInfo = { name: string; isActive: boolean }

/**
 * The contact's tags as chips, and a picker of the active tags it doesn't
 * carry. An archived tag it still carries shows (marked) and can be
 * removed, but is never offered.
 */
function TagFields({
  value,
  onChange,
  problems,
  known,
  allTags,
}: {
  value: Payloads['tags']
  onChange: (v: Payloads['tags']) => void
  problems: Array<Problem>
  known: Data['tags']
  allTags:
    Array<{ _id: Id<'tags'>; name: string; isActive: boolean }> | undefined
}) {
  const info = new Map<string, TagInfo>(
    known.map((t) => [t.tagId, { name: t.name, isActive: t.isActive }]),
  )
  for (const t of allTags ?? []) info.set(t._id, t)
  const carried = new Set(value.tags.map((t) => t.tagId))
  const offered = (allTags ?? []).filter(
    (t) => t.isActive && !carried.has(t._id),
  )
  return (
    <section>
      <h2 className="mb-3 text-lg font-medium">Tags</h2>
      <Message message={problemFor(problems, 'tags')} tone="error" />
      <div className="flex flex-wrap items-center gap-2">
        {value.tags.length === 0 && (
          <span className="text-sm text-neutral-500">No tags.</span>
        )}
        <ul className="contents">
          {value.tags.map((row) => {
            const tag = info.get(row.tagId)
            const name = tag?.name ?? '…'
            return (
              <li
                key={row.key ?? row.tagId}
                className={`flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-sm ${tag?.isActive === false ? 'border-dashed border-neutral-300 text-neutral-500' : 'border-neutral-300 bg-white'}`}
              >
                <span>{name}</span>
                {tag?.isActive === false && (
                  <span className="text-xs">(archived)</span>
                )}
                <button
                  type="button"
                  aria-label={`remove tag ${name}`}
                  onClick={() =>
                    onChange({
                      tags: value.tags.filter((t) => t !== row),
                    })
                  }
                  className="ml-0.5 text-neutral-500 hover:text-neutral-900"
                >
                  ×
                </button>
              </li>
            )
          })}
        </ul>
        {offered.length > 0 && (
          <select
            aria-label="Add tag"
            value=""
            onChange={(e) => {
              const tagId = e.target.value as Id<'tags'>
              if (!tagId) return
              onChange({
                tags: [...value.tags, { key: crypto.randomUUID(), tagId }],
              })
            }}
            className="rounded border border-neutral-300 px-2 py-1 text-sm"
          >
            <option value="">add tag…</option>
            {offered.map((t) => (
              <option key={t._id} value={t._id}>
                {t.name}
              </option>
            ))}
          </select>
        )}
      </div>
    </section>
  )
}

// ── chrome ─────────────────────────────────────────────────────────────────

function problemFor(
  problems: Array<Problem>,
  field: string,
  exact = false,
): string | undefined {
  return problems.find((p) =>
    exact
      ? p.field === field
      : p.field === field || p.field.startsWith(`${field}.`),
  )?.message
}

type RowMessage = { text: string; tone: 'error' | 'warning' }

/**
 * A row's inline messages: its blocking problem alone, or else every
 * advisory warning on any of its anchors (a malformed address that another
 * contact also uses shows both).
 */
function rowMessages(
  problem: string | undefined,
  warnings: Data['warnings'],
  anchors: Array<string>,
): Array<RowMessage> {
  if (problem) return [{ text: problem, tone: 'error' }]
  return warnings
    .filter((w) => anchors.includes(w.anchor))
    .map((w) => ({ text: w.message, tone: 'warning' }))
}

function Field({
  label,
  message,
  conflict,
  children,
}: {
  label: string
  message?: string
  conflict: boolean
  children: React.ReactNode
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-neutral-600">
        {label}
        {conflict && (
          <span className="ml-2 rounded bg-red-100 px-1 text-xs text-red-800">
            changed by someone else too
          </span>
        )}
      </span>
      {children}
      <Message message={message} tone="error" />
    </label>
  )
}

/** One inline message; a row's error hides its warnings (`rowMessages`). */
function Message({
  message,
  tone,
}: {
  message?: string
  tone: 'error' | 'warning'
}) {
  if (!message) return null
  return (
    <span
      className={`text-xs ${tone === 'error' ? 'text-red-700' : 'text-amber-700'}`}
    >
      {message}
    </span>
  )
}

function Notice({
  tone,
  children,
}: {
  tone: 'error' | 'warning'
  children: React.ReactNode
}) {
  return (
    <p
      className={`rounded border px-3 py-2 text-sm ${tone === 'error' ? 'border-red-300 bg-red-50 text-red-800' : 'border-amber-300 bg-amber-50 text-amber-800'}`}
    >
      {children}
    </p>
  )
}

function AddButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-sm text-neutral-600 underline"
    >
      add
    </button>
  )
}

function RowShell({
  messages,
  primary,
  onPrimary,
  onRemove,
  label,
  onLabel,
  children,
}: {
  messages: Array<RowMessage>
  primary: boolean
  onPrimary: () => void
  onRemove: () => void
  label: Label
  onLabel: (label: Label) => void
  children: React.ReactNode
}) {
  return (
    <li className="flex flex-col gap-1 rounded border border-neutral-200 bg-white p-2">
      <div className="flex items-start gap-2">
        <select
          value={label}
          onChange={(e) => onLabel(e.target.value as Label)}
          className="rounded border border-neutral-300 px-2 py-1.5 text-sm"
        >
          {LABELS.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
        {children}
        <label className="flex items-center gap-1 self-center text-xs text-neutral-600">
          <input type="radio" checked={primary} onChange={onPrimary} /> primary
        </label>
        <button
          type="button"
          onClick={onRemove}
          className="self-center text-xs text-neutral-500 underline"
        >
          remove
        </button>
      </div>
      {messages.map((m) => (
        <Message key={m.text} message={m.text} tone={m.tone} />
      ))}
    </li>
  )
}

function SavePane({
  state,
  problemCount,
  warningCount,
}: {
  state: FormState
  problemCount: number
  warningCount: number
}) {
  const dirty = Object.values(state.dirty).some(Boolean)
  const text =
    state.status === 'saving'
      ? 'Saving…'
      : state.status === 'error'
        ? 'Not saved'
        : problemCount
          ? `${problemCount} to fix`
          : dirty
            ? 'Unsaved changes'
            : state.savedAt
              ? `All changes saved ${new Date(state.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
              : 'Up to date'
  return (
    <div
      className={`fixed right-4 bottom-4 flex items-center gap-3 rounded border bg-white px-3 py-2 text-sm shadow ${problemCount || state.status === 'error' ? 'border-red-300' : warningCount ? 'border-amber-300' : 'border-neutral-200'}`}
    >
      <span>{text}</span>
      {warningCount > 0 && !problemCount && (
        <span className="text-amber-700">{warningCount} to check</span>
      )}
      <button
        type="submit"
        className="rounded bg-neutral-900 px-2 py-1 text-xs text-white hover:bg-neutral-700"
        disabled={state.status === 'saving' || !dirty}
      >
        Save
      </button>
    </div>
  )
}
