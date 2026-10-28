import { Link } from '@tanstack/react-router'
import { useEffect, useMemo, useReducer, useRef } from 'react'
import type { Id } from '../lib/domain/ids'
import type { Payloads, FieldDefinition  } from '../lib/domain/contacts'
import { sortValues } from '../lib/domain/contacts'
import { contactWarnings } from '../lib/domain/warnings'
import type { Warning } from '../lib/domain/warnings'
import type {
  Counters,
  FormState,
  Problem,
  SliceName,
  Slices,
} from '../lib/contact-form-state'
import {
  initialState,
  newKey,
  reduce,
  submission,
  tornSlices,
  unsavedWork,
} from '../lib/contact-form-state'
import { useCanWrite, useTenant } from '../lib/tenant'
import { useReportUnsaved } from '../lib/unsaved'
import { holdOn } from '../lib/email-hold'
import type { Held } from '../lib/email-hold'
import {
  FEATURES,
  useEmailContext,
  useIdentifierTypes,
  useMembers,
  useSaveContactForm,
} from '../lib/data'
import type { ContactView } from '../lib/data'
import { EmailHold } from './email-hold'
import { ContactAcquisition } from './contact-acquisition'
import { ContactNumber } from './contact-number'
import { FindAddress } from './address-lookup'

type Data = ContactView
type Label = 'home' | 'work' | 'other'

const LABELS: Array<Label> = ['home', 'work', 'other']
const AUTOSAVE_MS = 700
// Built once: `toLocaleTimeString` with options makes one per call.
const SAVED_AT = new Intl.DateTimeFormat([], {
  hour: '2-digit',
  minute: '2-digit',
})

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
    identifiers: {
      identifiers: data.identifiers.map((r) => ({
        key: r.key,
        typeId: r.typeId,
        value: r.value,
      })),
    },
    fields: {
      values: sortValues(
        data.fields.map((f) => ({ fieldId: f.fieldId, optionId: f.optionId })),
      ),
    },
  }
}

function toCounters(data: Data): Counters {
  return {
    details: data.contact.detailsVersion,
    methods: data.contact.methodsVersion,
    addresses: data.contact.addressesVersion,
    identifiers: data.contact.identifiersVersion,
    fields: data.contact.fieldsVersion,
  }
}

export function ContactForm({
  id,
  data,
  fields,
}: {
  id: Id<'contacts'>
  data: Data
  /** The tenant's field definitions (`api.contacts.fields.list`). */
  fields: Array<FieldDefinition>
}) {
  const tenant = useTenant()
  const canWrite = useCanWrite()
  const saveContactForm = useSaveContactForm(id)
  const members = useMembers()
  const { alsoUsedBy, held } = useEmailContext(id, data.emails)
  const warnings = useMemo(
    () => contactWarnings(data, alsoUsedBy),
    [data, alsoUsedBy],
  )
  // The picker offers active types only; a row of an archived one names
  // its type from `data.identifiers`.
  const allIdentifierTypes = useIdentifierTypes()
  const identifierTypes = useMemo(
    () => allIdentifierTypes?.filter((t) => t.isActive),
    [allIdentifierTypes],
  )
  const [state, dispatch] = useReducer(reduce, data, (d) =>
    initialState(toSlices(d), toCounters(d)),
  )
  const latest = useRef(state)
  latest.current = state
  // A field pick, or an identifier row finished or removed, is a whole edit
  // with nothing left to type: save it now, not after the autosave pause.
  const saveNow = useRef(false)

  // The live query: merge every server change per field (own saves are
  // recognised by counters inside the reducer and ignored).
  const delivered = useRef({
    slices: toSlices(data),
    counters: toCounters(data),
  })
  useEffect(() => {
    const now = { slices: toSlices(data), counters: toCounters(data) }
    const torn = tornSlices(delivered.current, now)
    delivered.current = now
    dispatch({ type: 'server', ...now, torn })
  }, [data])

  async function save() {
    saveNow.current = false
    const current = latest.current
    const submitted = submission(current)
    if (Object.keys(submitted).length === 0) {
      dispatch({ type: 'nothingToSave' })
      return
    }
    dispatch({ type: 'saving' })
    const actions = await saveContactForm(submitted, () => latest.current)
    // A stale slice came back merged (`server` after `saved`): the queued
    // retry is a whole edit already made, so it goes now, not after the
    // autosave pause.
    if (actions.some((a) => a.type === 'server')) saveNow.current = true
    for (const action of actions) dispatch(action)
  }

  useEffect(() => {
    // Nothing to save (say, an unfilled row removed): disarm it, or the
    // next unrelated edit would skip the pause.
    if (!state.needsSave && state.status !== 'saving') saveNow.current = false
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

  // Hidden until the group has a type to pick, unless the contact already
  // carries rows (of a since-archived type, say).
  const showIdentifiers =
    (identifierTypes?.length ?? 0) > 0 ||
    data.identifiers.length > 0 ||
    state.local.identifiers.identifiers.length > 0

  const generalWarnings = warnings.filter((w) => w.anchor === '')
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
        <ContactNumber sequence={data.contact.number} />
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
              Changed by both of you:{' '}
              {state.conflicts.map((c) => conflictName(c, fields)).join(', ')}.
              Your value is kept — check it.
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

        {FEATURES.sourceCodes && (
          <ContactAcquisition
            id={id}
            counter={data.contact.acquisitionVersion}
            codeId={data.contact.acquisitionCodeId}
            acquisition={data.acquisition}
            disabled={!canWrite}
          />
        )}

        <MethodsFields
          value={state.local.methods}
          onChange={(v) => edit('methods', v)}
          problems={state.problems.methods ?? []}
          warnings={warnings}
          held={held}
        />

        <AddressFields
          value={state.local.addresses}
          onChange={(v) => edit('addresses', v)}
          problems={state.problems.addresses ?? []}
          warnings={warnings}
        />

        {showIdentifiers && (
          <IdentifierFields
            value={state.local.identifiers}
            onChange={(v) => edit('identifiers', v)}
            onDone={() => {
              saveNow.current = true
            }}
            problems={state.problems.identifiers ?? []}
            saved={state.base.identifiers}
            known={data.identifiers}
            types={identifierTypes}
            slug={tenant.slug}
          />
        )}

        <FieldValues
          value={state.local.fields}
          onChange={(v) => {
            saveNow.current = true
            edit('fields', v)
          }}
          problems={state.problems.fields ?? []}
          conflicts={state.conflicts
            .filter((c) => c.startsWith('fields.'))
            .map((c) => c.slice(7))}
          known={data.fields}
          definitions={fields}
          kind={data.contact.kind}
        />
      </fieldset>

      {canWrite && (
        <SavePane
          state={state}
          problemCount={problemCount}
          warningCount={warnings.length}
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
            as="div"
            label=""
            message={problemFor(problems, 'isDeceased')}
            conflict={conflicts.includes('isDeceased')}
          >
            <label className="mt-6 flex w-fit items-center gap-2 text-sm">
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
  held,
}: {
  value: Payloads['methods']
  onChange: (v: Payloads['methods']) => void
  problems: Array<Problem>
  warnings: Array<Warning>
  held: Held | undefined
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
                    key: newKey(),
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
              footer={
                FEATURES.emailHolds ? (
                  <EmailHold
                    address={row.address}
                    hold={holdOn(row.address, held)}
                  />
                ) : undefined
              }
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
                    key: newKey(),
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
  warnings: Array<Warning>
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
                  key: newKey(),
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
              <div className="flex md:col-span-2">
                <FindAddress
                  postcode={row.postcode}
                  onPick={(a) =>
                    update(row, {
                      line1: a.line1,
                      line2: a.line2,
                      line3: a.line3,
                      town: a.town,
                      postcode: a.postcode,
                      country: 'GB',
                    })
                  }
                />
              </div>
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

type TypeInfo = { name: string; isActive?: boolean }

/** A conflict as the notice names it: a field value by its field's label. */
function conflictName(c: string, fields: Array<FieldDefinition>) {
  if (!c.startsWith('fields.')) return c
  return fields.find((f) => f._id === c.slice(7))?.label ?? 'a field'
}

/**
 * The dropdown fields, one select per field, in slot order. A field shows
 * when it is active, not being retired and applies to the contact's
 * (saved) kind, or when the contact holds a value in it anyway; then the
 * value can be kept or cleared, but no other option is offered. Archived
 * options leave the list except the one the contact holds, marked.
 */
function FieldValues({
  value,
  onChange,
  problems,
  conflicts,
  known,
  definitions,
  kind,
}: {
  value: Payloads['fields']
  onChange: (v: Payloads['fields']) => void
  problems: Array<Problem>
  /** Field ids changed both here and elsewhere. */
  conflicts: Array<string>
  known: Data['fields']
  definitions: Array<FieldDefinition>
  kind: Data['contact']['kind']
}) {
  const held = new Map<string, Id<'contactFieldOptions'>>(
    value.values.map((x) => [x.fieldId, x.optionId]),
  )
  const shown = [...definitions]
    .sort((a, b) => a.slot - b.slot)
    .filter(
      (f) =>
        held.has(f._id) ||
        (f.isActive && !f.retiring && f.appliesTo.includes(kind)),
    )
  if (shown.length === 0) return null
  const set = (
    fieldId: Id<'contactFields'>,
    optionId: Id<'contactFieldOptions'> | null,
  ) => {
    const rest = value.values.filter((x) => x.fieldId !== fieldId)
    onChange({
      values: sortValues(optionId ? [...rest, { fieldId, optionId }] : rest),
    })
  }
  return (
    <section>
      <h2 className="mb-3 text-lg font-medium">Fields</h2>
      <Message
        message={
          problems.find((p) => !shown.some((f) => f._id === p.key))?.message
        }
        tone="error"
      />
      <div className="grid gap-3 sm:grid-cols-2">
        {shown.map((f) => {
          const current = held.get(f._id)
          const settable =
            f.isActive && !f.retiring && f.appliesTo.includes(kind)
          const options = f.options.filter(
            (o) => o._id === current || (settable && o.isActive),
          )
          // The held option, when the definitions don't list it (it should
          // never happen; `known` names it as the server last saw it).
          const unlisted =
            current && !options.some((o) => o._id === current)
              ? (known.find((k) => k.optionId === current)?.optionLabel ?? '?')
              : null
          const note = f.retiring
            ? ' (being retired)'
            : !f.isActive
              ? ' (archived)'
              : !f.appliesTo.includes(kind)
                ? ' (not for this kind)'
                : ''
          return (
            <Field
              key={f._id}
              label={`${f.label}${note}`}
              message={problems.find((p) => p.key === f._id)?.message}
              conflict={conflicts.includes(f._id)}
            >
              <select
                value={current ?? ''}
                onChange={(e) =>
                  set(
                    f._id,
                    (e.target.value as Id<'contactFieldOptions'>) || null,
                  )
                }
                className="rounded border border-neutral-300 px-2 py-1.5"
              >
                <option value="">not set</option>
                {options.map((o) => (
                  <option key={o._id} value={o._id}>
                    {o.isActive ? o.label : `${o.label} (archived)`}
                  </option>
                ))}
                {unlisted !== null && current && (
                  <option value={current}>{unlisted}</option>
                )}
              </select>
            </Field>
          )
        })}
      </div>
    </section>
  )
}

/**
 * External identifiers: a saved row's type and value are read-only (change
 * = remove + add); a new row picks an active type and saves once its value
 * is filled in. A clash names and links the contact holding the value.
 */
function IdentifierFields({
  value,
  onChange,
  onDone,
  problems,
  saved,
  known,
  types,
  slug,
}: {
  value: Payloads['identifiers']
  onChange: (v: Payloads['identifiers']) => void
  /** The row is complete: save now rather than after the pause. */
  onDone: () => void
  problems: Array<Problem>
  saved: Payloads['identifiers']
  known: Data['identifiers']
  types: Array<{ _id: Id<'identifierTypes'>; name: string }> | undefined
  slug: string
}) {
  const savedKeys = new Set(saved.identifiers.map((r) => r.key))
  const info = new Map<string, TypeInfo>(
    known.map((r) => [r.typeId, { name: r.typeName, isActive: r.typeActive }]),
  )
  for (const t of types ?? []) info.set(t._id, { name: t.name, isActive: true })
  const update = (
    row: Payloads['identifiers']['identifiers'][number],
    patch: Partial<typeof row>,
  ) =>
    onChange({
      identifiers: value.identifiers.map((r) =>
        r === row ? { ...r, ...patch } : r,
      ),
    })
  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-lg font-medium">Identifiers</h2>
        {(types?.length ?? 0) > 0 && (
          <AddButton
            onClick={() =>
              onChange({
                identifiers: [
                  ...value.identifiers,
                  {
                    key: newKey(),
                    typeId: '' as Id<'identifierTypes'>,
                    value: '',
                  },
                ],
              })
            }
          />
        )}
      </div>
      <Message
        message={problems.find((p) => p.key === undefined)?.message}
        tone="error"
      />
      {value.identifiers.length === 0 && (
        <p className="text-sm text-neutral-500">No identifiers.</p>
      )}
      <ul className="flex flex-col gap-2">
        {value.identifiers.map((row) => {
          const type = info.get(row.typeId)
          const clash = problems.find((p) => p.key === row.key)
          // Not submitted without a type, but typed work all the same:
          // it counts as unsaved (`unsavedWork`), so leaving asks first.
          const needsType =
            (row.typeId as string) === '' && row.value.trim() !== ''
          const remove = () => {
            onDone()
            onChange({
              identifiers: value.identifiers.filter((r) => r !== row),
            })
          }
          return (
            <li
              key={row.key}
              className="flex flex-col gap-1 rounded border border-neutral-200 bg-white p-2"
            >
              <div className="flex items-center gap-2">
                {row.key !== undefined && savedKeys.has(row.key) ? (
                  <>
                    <span className="w-48 text-sm text-neutral-600">
                      {type?.name ?? '…'}
                      {type?.isActive === false && (
                        <span className="ml-1 text-xs">(archived type)</span>
                      )}
                    </span>
                    <span className="flex-1 px-3 py-1.5">{row.value}</span>
                  </>
                ) : (
                  <>
                    <select
                      aria-label="Identifier type"
                      value={row.typeId}
                      onChange={(e) => {
                        if (row.value.trim()) onDone()
                        update(row, {
                          typeId: e.target.value as Id<'identifierTypes'>,
                        })
                      }}
                      className="w-48 rounded border border-neutral-300 px-2 py-1.5 text-sm"
                    >
                      <option value="">type…</option>
                      {(types ?? []).map((t) => (
                        <option key={t._id} value={t._id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                    <input
                      type="text"
                      aria-label="Identifier value"
                      placeholder="identifier"
                      value={row.value}
                      onChange={(e) => update(row, { value: e.target.value })}
                      onBlur={() => {
                        if (row.typeId && row.value.trim()) onDone()
                      }}
                      className="flex-1 rounded border border-neutral-300 px-3 py-1.5"
                    />
                  </>
                )}
                <button
                  type="button"
                  aria-label={`remove identifier ${row.value}`}
                  onClick={remove}
                  className="text-xs text-neutral-500 underline"
                >
                  remove
                </button>
              </div>
              {needsType && !clash && (
                <Message message="Choose a type to save this" tone="error" />
              )}
              {clash &&
                (clash.contactId ? (
                  <Link
                    to="/t/$slug/contacts/$contactId"
                    params={{ slug, contactId: clash.contactId }}
                    className="text-xs text-red-700 underline"
                  >
                    {clash.message}
                  </Link>
                ) : (
                  <Message message={clash.message} tone="error" />
                ))}
            </li>
          )
        })}
      </ul>
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
  warnings: Array<Warning>,
  anchors: Array<string>,
): Array<RowMessage> {
  if (problem) return [{ text: problem, tone: 'error' }]
  return warnings
    .filter((w) => anchors.includes(w.anchor))
    .map((w) => ({ text: w.message, tone: 'warning' }))
}

function Field({
  as: Wrapper = 'label',
  label,
  message,
  conflict,
  children,
}: {
  /** `div` when the control brings its own label, as a checkbox does: a
      wrapping label would make the whole cell click it. */
  as?: 'label' | 'div'
  label: string
  message?: string
  conflict: boolean
  children: React.ReactNode
}) {
  return (
    <Wrapper className="flex flex-col gap-1 text-sm">
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
    </Wrapper>
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
  footer,
  children,
}: {
  messages: Array<RowMessage>
  primary: boolean
  onPrimary: () => void
  onRemove: () => void
  label: Label
  onLabel: (label: Label) => void
  /** Under the row's messages: an email row's hold. */
  footer?: React.ReactNode
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
      {footer}
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
              ? `All changes saved ${SAVED_AT.format(state.savedAt)}`
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
