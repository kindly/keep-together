// @vitest-environment happy-dom
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { TenantContext } from '../../tenant'
import type { Tenant } from '../../tenant'
import { deliver } from '../events'
import type { NoteSaved } from '../rust-types/NoteSaved'
import type { NoteView } from '../rust-types/NoteView'
import type { OrgEvent } from '../rust-types/OrgEvent'
import type { Group } from '../rust-types/Group'
import { get } from './client'
import {
  useEmailContext,
  useIdentifierTypes,
  useNoteActions,
  useNotes,
  useRelease,
  useSaveIdentifierType,
} from './contact-extras'
import { useBatch, useBatchWrites } from './batches'
import { useHmrcDetails, useSaveHmrcDetails } from './claims'
import { useFieldWrites } from './fields'
import { useDeclarations, useGiftAidWrites } from './gifts'
import { queryClient, useFields } from './hooks'
import { keys } from './keys'
import { useLine, useMatchWrites } from './matching'
import { useSetStaffCanManage } from './platform'
import { useScanInbox, useScanWrites } from './scans'
import { useSourceTree, useSourceWrites } from './sources'

// One round trip per save (brief one-trip-saves, 2026-11-02): a write's
// answer lands in the cache and its own events refetch nothing it showed.
// Before, the echo's refetch was cancelled and restarted by the hook's
// own invalidation, and the screen waited for the second GET: three
// round trips. Each flow here fails on any list fetch after its write,
// whichever comes first of the answer and its echo; someone else's later
// event still refetches; a refused write changes nothing.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

type Sent = { method: string; url: string; body: unknown }
type Answer = { status: number; body: unknown; seq?: number }

let sent: Array<Sent>
/** A request's path after `/api/t/<slug>/` (or `/api/`), no query. */
const pathOf = (url: string) =>
  url.replace(/^\/api\/(t\/[^/]+\/)?/, '').split('?')[0]
/** Reads answer from here, by path (after `/api/t/<slug>/`). */
let reads: Record<string, unknown>
/** The next write's answer; a write waits for it until it's given. */
let pending: Array<(a: Answer) => void>

let root: Root
let el: HTMLDivElement
let qc: QueryClient
let slug: string
let tenants = 0
beforeEach(() => {
  sent = []
  reads = {}
  pending = []
  // Each test its own tenant: events.ts keeps its holds per tenant.
  slug = `one-trip-${++tenants}`
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      sent.push({
        method,
        url,
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      })
      const path = pathOf(url)
      const respond = ({ status, body, seq }: Answer) =>
        new Response(JSON.stringify(body), {
          status,
          headers: seq === undefined ? {} : { 'keep-seq': String(seq) },
        })
      if (method === 'GET') {
        if (!(path in reads))
          return Promise.resolve(respond({ status: 404, body: {} }))
        return Promise.resolve(respond({ status: 200, body: reads[path] }))
      }
      return new Promise<Response>((resolve) =>
        pending.push((a) => resolve(respond(a))),
      )
    }),
  )
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
  vi.unstubAllGlobals()
})

function mount<T>(hook: () => T): () => T {
  let value: T | undefined
  function Probe() {
    value = hook()
    return null
  }
  act(() =>
    root.render(
      <QueryClientProvider client={qc}>
        <TenantContext.Provider value={{ slug } as unknown as Tenant}>
          <Probe />
        </TenantContext.Provider>
      </QueryClientProvider>,
    ),
  )
  return () => value!
}

/** Let fetches answer and the cache settle: a few macrotasks. */
const settle = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
  })

/** GETs of `path` since `from`. */
const getsOf = (path: string, from = 0) =>
  sent.slice(from).filter((c) => c.method === 'GET' && pathOf(c.url) === path)
    .length

/** Answer the write in flight. */
async function answer(a: Answer) {
  await act(async () => {
    const next = pending.shift()
    if (!next) throw new Error('no write in flight')
    next(a)
    await new Promise((r) => setTimeout(r, 0))
  })
}

const event = (seq: number, over: Partial<OrgEvent>): OrgEvent => ({
  seq,
  entity: 'contacts',
  id: 'x',
  contract: 'x',
  counter: 0,
  ...over,
})

/**
 * The shared shape of every flow: `write` starts the save, `echo` is its
 * own event, `other` someone else's later one. Each returns what the
 * screen shows, read through `shown`.
 */
async function oneTrip<T>(f: {
  list: string
  /** What the list's read answers once the write has committed. */
  now: unknown
  start: () => Promise<unknown>
  answer: Answer & { seq: number }
  echo: Array<OrgEvent>
  other: OrgEvent
  shown: () => T
  before: T
  after: T
  echoFirst: boolean
}) {
  await settle()
  expect(f.shown()).toEqual(f.before)
  const from = sent.length
  let done!: Promise<unknown>
  act(() => {
    done = f.start()
  })
  if (f.echoFirst) for (const e of f.echo) act(() => deliver(qc, slug, e))
  await settle()
  // Nothing before the answer: not optimistic, and the echo is held.
  expect(f.shown()).toEqual(f.before)
  expect(getsOf(f.list, from)).toBe(0)
  reads[f.list] = f.now
  await answer(f.answer)
  await act(() => done)
  if (!f.echoFirst) for (const e of f.echo) act(() => deliver(qc, slug, e))
  await settle()
  expect(f.shown()).toEqual(f.after)
  // The whole save: one request.
  expect(sent.slice(from).map((c) => c.method)).toEqual(['POST'])
  // Someone else's change still refetches.
  act(() => deliver(qc, slug, f.other))
  await settle()
  expect(getsOf(f.list, from)).toBe(1)
}

/** A refused write: nothing on screen changes. */
async function refused<T>(f: {
  start: () => Promise<unknown>
  shown: () => T
  before: T
}) {
  await settle()
  let failed: unknown
  act(() => {
    f.start().catch((e: unknown) => (failed = e))
  })
  await answer({
    status: 409,
    body: { kind: 'stale', contract: 'x', counter: 0, current: {} },
  })
  await settle()
  expect(failed).toBeDefined()
  expect(f.shown()).toEqual(f.before)
}

// ── notes ──────────────────────────────────────────────────────────────────

const CONTACT = 'c0000000000000000000000000000001'
const note = (id: string, body: string, over: Partial<NoteView> = {}) =>
  ({
    id,
    contactId: CONTACT,
    body,
    pinned: false,
    archived: false,
    createdBy: 1,
    createdAt: 1,
    editedBy: null,
    editedAt: 1,
    bodyVersion: 0,
    flagsVersion: 0,
    ...over,
  }) satisfies NoteView
const page = (notes: Array<NoteView>) => ({ notes, truncated: false })

describe('notes', () => {
  const LIVE = `contacts/${CONTACT}/notes`
  function setup() {
    reads[LIVE] = page([note('n1', 'first')])
    reads[`${LIVE}/archived`] = page([])
    return mount(() => ({
      live: useNotes(CONTACT as never, 'live'),
      act: useNoteActions(),
    }))
  }
  const bodies = (h: ReturnType<typeof setup>) => () =>
    h().live?.notes.map((x) => `${x.body}${x.pinned ? '*' : ''}`)
  const saved = (live: Array<NoteView>, n: NoteView): NoteSaved => ({
    note: n,
    live: page(live),
    archived: page([]),
  })
  const other = event(99, { entity: 'contact_notes', id: 'n9' })

  for (const echoFirst of [true, false])
    describe(echoFirst ? 'echo before the answer' : 'echo after it', () => {
      test('add', async () => {
        const h = setup()
        const n2 = note('n2', 'second')
        await oneTrip({
          list: LIVE,
          echoFirst,
          start: () =>
            h().act.create({
              contactId: CONTACT as never,
              body: 'second',
              pinned: false,
            }),
          now: page([n2, note('n1', 'first')]),
          answer: {
            status: 200,
            body: saved([n2, note('n1', 'first')], n2),
            seq: 7,
          },
          echo: [
            event(7, {
              entity: 'contact_notes',
              id: 'n2',
              contract: 'contacts.note',
            }),
          ],
          other,
          shown: bodies(h),
          before: ['first'],
          after: ['second', 'first'],
        })
      })

      test('save, pin', async () => {
        const h = setup()
        const n1 = note('n1', 'edited', { bodyVersion: 1 })
        await oneTrip({
          list: LIVE,
          echoFirst,
          start: () =>
            h().act.save({ id: 'n1' as never, expected: 0, body: 'edited' }),
          now: page([n1]),
          answer: { status: 200, body: saved([n1], n1), seq: 8 },
          echo: [event(8, { entity: 'contact_notes', id: 'n1', counter: 1 })],
          other,
          shown: bodies(h),
          before: ['first'],
          after: ['edited'],
        })
        const p = note('n1', 'edited', { pinned: true, flagsVersion: 1 })
        await oneTrip({
          list: LIVE,
          echoFirst,
          start: () => h().act.setPinned({ id: 'n1' as never, pinned: true }),
          now: page([p]),
          answer: { status: 200, body: saved([p], p), seq: 100 },
          echo: [event(100, { entity: 'contact_notes', id: 'n1' })],
          other: event(101, { entity: 'contact_notes', id: 'n9' }),
          shown: bodies(h),
          before: ['edited'],
          after: ['edited*'],
        })
      })

      test('archive', async () => {
        const h = setup()
        const gone = note('n1', 'first', { archived: true, flagsVersion: 1 })
        await oneTrip({
          list: LIVE,
          echoFirst,
          start: () =>
            h().act.setArchived({ id: 'n1' as never, archived: true }),
          now: page([]),
          answer: {
            status: 200,
            body: { note: gone, live: page([]), archived: page([gone]) },
            seq: 9,
          },
          echo: [event(9, { entity: 'contact_notes', id: 'n1' })],
          other,
          shown: bodies(h),
          before: ['first'],
          after: [],
        })
      })
    })

  test('a refused save changes nothing', async () => {
    const h = setup()
    await refused({
      start: () => h().act.save({ id: 'n1' as never, expected: 0, body: 'x' }),
      shown: bodies(h),
      before: ['first'],
    })
  })
})

// ── the settings lists ─────────────────────────────────────────────────────

describe('settings lists', () => {
  test('identifier types: create, rename, archive', async () => {
    const type = (id: string, name: string, isActive = true, v = 0) => ({
      id,
      name,
      isActive,
      saveVersion: v,
    })
    reads['identifier-types'] = [type('t1', 'Member')]
    const h = mount(() => ({
      types: useIdentifierTypes(),
      save: useSaveIdentifierType(),
    }))
    const names = () =>
      h().types?.map((t) => `${t.name}${t.isActive ? '' : ' (archived)'}`)
    const echo = (seq: number, id: string) =>
      event(seq, { entity: 'identifier_types', id })
    const other = (seq: number) =>
      event(seq, { entity: 'identifier_types', id: 't9' })
    const now = [type('t1', 'Member'), type('t2', 'Payroll')]
    await oneTrip({
      list: 'identifier-types',
      now,
      echoFirst: true,
      start: () => h().save({ name: 'Payroll', isActive: true }),
      answer: {
        status: 200,
        body: { id: 't2', counter: 0, types: now },
        seq: 3,
      },
      echo: [echo(3, 't2')],
      other: other(4),
      shown: names,
      before: ['Member'],
      after: ['Member', 'Payroll'],
    })
    const renamed = [type('t1', 'Member no.', true, 1), type('t2', 'Payroll')]
    await oneTrip({
      list: 'identifier-types',
      now: renamed,
      echoFirst: false,
      start: () =>
        h().save({
          id: 't1' as never,
          expected: 0,
          name: 'Member no.',
          isActive: true,
        }),
      answer: {
        status: 200,
        body: { id: 't1', counter: 1, types: renamed },
        seq: 5,
      },
      echo: [echo(5, 't1')],
      other: other(6),
      shown: names,
      before: ['Member', 'Payroll'],
      after: ['Member no.', 'Payroll'],
    })
    const archived = [type('t1', 'Member no.', false, 2), type('t2', 'Payroll')]
    await oneTrip({
      list: 'identifier-types',
      now: archived,
      echoFirst: true,
      start: () =>
        h().save({
          id: 't1' as never,
          expected: 1,
          name: 'Member no.',
          isActive: false,
        }),
      answer: {
        status: 200,
        body: { id: 't1', counter: 2, types: archived },
        seq: 7,
      },
      echo: [echo(7, 't1')],
      other: other(8),
      shown: names,
      before: ['Member no.', 'Payroll'],
      after: ['Member no. (archived)', 'Payroll'],
    })
    await refused({
      start: () => h().save({ name: 'X', isActive: true }),
      shown: names,
      before: ['Member no. (archived)', 'Payroll'],
    })
  })

  test('fields: create, add an option, archive', async () => {
    const field = (
      id: string,
      label: string,
      options: Array<string> = [],
      isActive = true,
    ) => ({
      id,
      label,
      appliesTo: ['individual'],
      isActive,
      retiring: false,
      saveVersion: 0,
      deletable: true,
      options: options.map((o, i) => ({
        id: `${id}o${i}`,
        fieldId: id,
        label: o,
        position: i,
        isActive: true,
        used: false,
        saveVersion: 0,
      })),
    })
    reads.fields = [field('f1', 'Region')]
    const h = mount(() => ({ fields: useFields(), w: useFieldWrites() }))
    const shown = () =>
      h().fields?.map(
        (f) =>
          `${f.label}${f.isActive ? '' : ' (archived)'}:${f.options.map((o) => o.label).join('/')}`,
      )
    const echo = (seq: number, id: string) =>
      event(seq, { entity: 'contact_fields', id })
    const other = (seq: number) =>
      event(seq, { entity: 'contact_fields', id: 'f9' })
    const payload = { label: 'Status', appliesTo: [], isActive: true }
    let now = [field('f1', 'Region'), field('f2', 'Status')]
    await oneTrip({
      list: 'fields',
      now,
      echoFirst: true,
      start: () => h().w.createField(payload as never),
      answer: {
        status: 200,
        body: { id: 'f2', counter: 0, fields: now },
        seq: 3,
      },
      echo: [echo(3, 'f2')],
      other: other(4),
      shown,
      before: ['Region:'],
      after: ['Region:', 'Status:'],
    })
    now = [field('f1', 'Region'), field('f2', 'Status', ['Active'])]
    await oneTrip({
      list: 'fields',
      now,
      echoFirst: false,
      start: () => h().w.addOption('f2' as never, 'Active'),
      answer: {
        status: 200,
        body: { id: 'f2o0', counter: 0, fields: now },
        seq: 5,
      },
      echo: [event(5, { entity: 'contact_field_options', id: 'f2o0' })],
      other: other(6),
      shown,
      before: ['Region:', 'Status:'],
      after: ['Region:', 'Status:Active'],
    })
    now = [field('f1', 'Region', [], false), field('f2', 'Status', ['Active'])]
    await oneTrip({
      list: 'fields',
      now,
      echoFirst: true,
      start: () =>
        h().w.saveField('f1' as never, 0, {
          label: 'Region',
          appliesTo: ['individual'],
          isActive: false,
        }),
      answer: {
        status: 200,
        body: { id: 'f1', counter: 1, fields: now },
        seq: 7,
      },
      echo: [echo(7, 'f1')],
      other: other(8),
      shown,
      before: ['Region:', 'Status:Active'],
      after: ['Region (archived):', 'Status:Active'],
    })
    await refused({
      start: () => h().w.createField(payload as never),
      shown,
      before: ['Region (archived):', 'Status:Active'],
    })
  })

  test('source codes: add a detail, rename, archive', async () => {
    const part = (
      id: string,
      name: string,
      parentId?: string,
      isActive = true,
    ) => ({
      id,
      name,
      code: name,
      level: parentId ? 'detail' : 'category',
      ...(parentId && { parentId }),
      isActive,
      visible: true,
      used: false,
      saveVersion: 0,
    })
    const tree = (...parts: Array<ReturnType<typeof part>>) => ({
      parts,
      canManage: true,
    })
    reads.sources = tree(part('c1', 'Street'))
    const h = mount(() => ({ tree: useSourceTree(), w: useSourceWrites() }))
    const shown = () =>
      h().tree?.parts.map((p) => `${p.name}${p.isActive ? '' : ' (archived)'}`)
    const echo = (seq: number, id: string) =>
      event(seq, { entity: 'source_codes', id })
    const other = (seq: number) =>
      event(seq, { entity: 'source_codes', id: 'c9' })
    let now = tree(part('c1', 'Street'), part('d1', 'Wesser', 'c1'))
    await oneTrip({
      list: 'sources',
      now,
      echoFirst: true,
      start: () =>
        h().w.create({ parentId: 'c1', name: 'Wesser', isActive: true }),
      answer: {
        status: 200,
        body: { id: 'd1', versionId: 'v1', tree: now },
        seq: 3,
      },
      // A detail comes with its first version: two events.
      echo: [echo(3, 'd1'), echo(3, 'v1')].map((e, i) => ({
        ...e,
        seq: 2 + i,
      })),
      other: other(4),
      shown,
      before: ['Street'],
      after: ['Street', 'Wesser'],
    })
    now = tree(part('c1', 'Street'), part('d1', 'Wessex', 'c1'))
    await oneTrip({
      list: 'sources',
      now,
      echoFirst: false,
      start: () =>
        h().w.save('d1' as never, 0, { name: 'Wessex', isActive: true }),
      answer: {
        status: 200,
        body: { id: 'd1', counter: 1, tree: now },
        seq: 5,
      },
      echo: [echo(5, 'd1')],
      other: other(6),
      shown,
      before: ['Street', 'Wesser'],
      after: ['Street', 'Wessex'],
    })
    now = tree(part('c1', 'Street'), part('d1', 'Wessex', 'c1', false))
    await oneTrip({
      list: 'sources',
      now,
      echoFirst: true,
      start: () =>
        h().w.save('d1' as never, 1, { name: 'Wessex', isActive: false }),
      answer: {
        status: 200,
        body: { id: 'd1', counter: 2, tree: now },
        seq: 7,
      },
      echo: [echo(7, 'd1')],
      other: other(8),
      shown,
      before: ['Street', 'Wessex'],
      after: ['Street', 'Wessex (archived)'],
    })
    await refused({
      start: () => h().w.save('d1' as never, 0, { name: 'X', isActive: true }),
      shown,
      before: ['Street', 'Wessex (archived)'],
    })
  })

  test('staff switches: the groups show the answer', async () => {
    // The switch writes through the app's one query client.
    qc = queryClient
    const group = (on: boolean, v: number | null): Group =>
      ({
        slug,
        name: slug,
        role: 'admin',
        lastUsedAt: null,
        staffCanManageIdentifierTypes: false,
        identifierTypesVersion: null,
        staffCanManageSourceCodes: false,
        sourceCodesVersion: null,
        staffCanManageFields: on,
        fieldsVersion: v,
        canManageIdentifierTypes: true,
        canManageSourceCodes: true,
        canManageFields: true,
      }) satisfies Group
    reads.groups = [group(false, null)]
    const h = mount(() => {
      const groups = useQuery({
        queryKey: keys.groups,
        queryFn: () => get<Array<Group>>('groups'),
      }).data
      return {
        on: groups?.[0]?.staffCanManageFields,
        set: useSetStaffCanManage({
          slug,
          fieldsVersion: groups?.[0]?.fieldsVersion ?? null,
        } as never),
      }
    })
    const {
      slug: _s,
      name: _n,
      role: _r,
      lastUsedAt: _l,
      ...switches
    } = group(true, 0)
    await oneTrip({
      list: 'groups',
      now: [group(true, 0)],
      echoFirst: true,
      start: () => h().set('fields', true),
      answer: {
        status: 200,
        body: { id: 'p', counter: 0, switches },
        seq: 3,
      },
      echo: [event(3, { entity: 'tenant_preferences', id: 'p' })],
      other: event(4, { entity: 'tenant_preferences', id: 'p' }),
      shown: () => h().on,
      before: false,
      after: true,
    })
    queryClient.clear()
  })
})

// ── Gift Aid ───────────────────────────────────────────────────────────────

describe('Gift Aid', () => {
  test('the panel: cancel, void, details', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 10, 2, 12))
    const TODAY = '2026-11-02'
    const C = 'c0000000000000000000000000000002'
    const row = (id: string, over: Record<string, unknown> = {}) => ({
      id,
      contactId: C,
      contributionId: null,
      cancelledFrom: null as string | null,
      cancellationNote: null,
      voidReason: null,
      voidedAt: null,
      voidedBy: null,
      enteredBy: 1,
      addressLine1: '',
      warnings: [],
      ...over,
    })
    const panel = (...rows: Array<ReturnType<typeof row>>) => ({
      declarations: rows,
      currentId: rows.find((r) => r.cancelledFrom === null)?.id ?? null,
    })
    const LIST = `contacts/${C}/giftaid`
    reads[LIST] = panel(row('d2'), row('d1'))
    const h = mount(() => ({
      panel: useDeclarations(C, TODAY),
      w: useGiftAidWrites(C),
    }))
    const shown = () =>
      h().panel?.declarations.map(
        (d) =>
          `${d._id}${d.cancelledFrom ? ' cancelled' : ''}${d.voidReason ? ' void' : ''}${(d as { addressLine1?: string }).addressLine1 ? ` ${(d as { addressLine1?: string }).addressLine1}` : ''}`,
      )
    const echo = (seq: number, id: string) =>
      event(seq, { entity: 'gift_aid_declarations', id })
    const other = (seq: number) =>
      event(seq, { entity: 'gift_aid_declarations', id: 'd9' })
    let now = panel(
      row('d2', { cancelledFrom: '2026-11-01' }),
      row('d1', { cancelledFrom: '2026-11-01' }),
    )
    await oneTrip({
      list: LIST,
      now,
      echoFirst: true,
      start: () => h().w.cancel('2026-11-01'),
      answer: {
        status: 200,
        body: { done: { cancelled: ['d2', 'd1'] }, declarations: now },
        seq: 4,
      },
      // One event per declaration it cancelled.
      echo: [echo(3, 'd2'), echo(4, 'd1')],
      other: other(5),
      shown,
      before: ['d2', 'd1'],
      after: ['d2 cancelled', 'd1 cancelled'],
    })
    expect(sent.at(-2)?.url).toBe(
      `/api/t/${slug}/contacts/${C}/giftaid/cancel?today=${TODAY}`,
    )
    now = panel(
      row('d2', { cancelledFrom: '2026-11-01', voidReason: 'oops' }),
      row('d1', { cancelledFrom: '2026-11-01' }),
    )
    await oneTrip({
      list: LIST,
      now,
      echoFirst: false,
      start: () => h().w.voidDeclaration('d2', 'oops'),
      answer: {
        status: 200,
        body: { done: { id: 'd2', counter: 1 }, declarations: now },
        seq: 6,
      },
      echo: [echo(6, 'd2')],
      other: other(7),
      shown,
      before: ['d2 cancelled', 'd1 cancelled'],
      after: ['d2 cancelled void', 'd1 cancelled'],
    })
    now = panel(
      row('d2', { cancelledFrom: '2026-11-01', voidReason: 'oops' }),
      row('d1', { cancelledFrom: '2026-11-01', addressLine1: '3 Mill Lane' }),
    )
    await oneTrip({
      list: LIST,
      now,
      echoFirst: true,
      start: () =>
        h().w.saveDetails('d1', 0, {
          firstName: 'Jo',
          lastName: 'B',
          addressLine1: '3 Mill Lane',
          postcode: 'LS1 1AA',
        }),
      answer: {
        status: 200,
        body: { done: { id: 'd1', counter: 1 }, declarations: now },
        seq: 8,
      },
      echo: [echo(8, 'd1')],
      other: other(9),
      shown,
      before: ['d2 cancelled void', 'd1 cancelled'],
      after: ['d2 cancelled void', 'd1 cancelled 3 Mill Lane'],
    })
    await refused({
      start: () => h().w.saveDetails('d1', 0, {} as never),
      shown,
      before: ['d2 cancelled void', 'd1 cancelled 3 Mill Lane'],
    })
    vi.useRealTimers()
  })

  test('HMRC details', async () => {
    const view = (ref: string, version: number | null) => ({
      hmrcReference: ref,
      version,
      warnings: [],
    })
    reads['giftaid/hmrc-details'] = view('', null)
    const h = mount(() => ({
      details: useHmrcDetails(),
      save: useSaveHmrcDetails(),
    }))
    const now = view('AB12345', 0)
    await oneTrip({
      list: 'giftaid/hmrc-details',
      now,
      echoFirst: true,
      start: () => h().save(null, { hmrcReference: 'AB12345' } as never),
      answer: {
        status: 200,
        body: { id: 'h', counter: 0, details: now },
        seq: 3,
      },
      echo: [event(3, { entity: 'gift_aid_hmrc_details', id: 'h' })],
      other: event(4, { entity: 'gift_aid_hmrc_details', id: 'h' }),
      shown: () => h().details.data?.hmrcReference,
      before: '',
      after: 'AB12345',
    })
    await refused({
      start: () => h().save(5, {} as never),
      shown: () => h().details.data?.hmrcReference,
      before: 'AB12345',
    })
  })
})

// ── the rest ───────────────────────────────────────────────────────────────

describe('holds, batches, lines and scans', () => {
  test('a hold released from a contact page', async () => {
    const C = 'c0000000000000000000000000000003'
    const LIST = `contacts/${C}/email-context`
    const hold = { reason: 'bounce', since: 1, saveVersion: 0 }
    reads[LIST] = { alsoUsedBy: {}, held: { 'ann@x.org': hold } }
    const emails = [{ address: 'ann@x.org' }] as never
    const h = mount(() => ({
      ctx: useEmailContext(C as never, emails),
      release: useRelease(C as never),
    }))
    const shown = () => Object.keys(h().ctx.held ?? {})
    const now = { alsoUsedBy: {}, held: {} }
    await oneTrip({
      list: LIST,
      now,
      echoFirst: true,
      start: () =>
        h().release({ address: 'ann@x.org', expected: 0, note: 'ok' }),
      answer: {
        status: 200,
        body: { id: 's1', counter: 1, context: now },
        seq: 3,
      },
      echo: [event(3, { entity: 'email_suppressions', id: 's1' })],
      other: event(4, { entity: 'email_suppressions', id: 's2' }),
      shown,
      before: ['ann@x.org'],
      after: [],
    })
    expect(sent.find((c) => c.method === 'POST')?.url).toBe(
      `/api/t/${slug}/comms/release?contact=${C}`,
    )
  })

  test('a batch closed', async () => {
    const B = 'b1'
    const batch = (status: string, v: number) => ({
      id: B,
      accountId: 'a1',
      accountName: 'Current',
      slipNumber: '7',
      status,
      bankedOn: status === 'closed' ? '2026-11-03' : null,
      total: status === 'closed' ? 1000 : null,
      giftsTotal: 0,
      figures: {
        receivedTotal: 0,
        pendingCount: 0,
        pendingTotal: 0,
        bouncedCount: 0,
        bouncedTotal: 0,
      },
      line: null,
      saveVersion: v,
    })
    const LIST = `bank/batches/${B}`
    reads[LIST] = { batch: batch('open', 0), gifts: [] }
    const h = mount(() => ({ page: useBatch(B).data, w: useBatchWrites() }))
    const shown = () => h().page?.batch.status
    const now = { batch: batch('closed', 1), gifts: [] }
    await oneTrip({
      list: LIST,
      now,
      echoFirst: true,
      start: () => h().w.close(B, 0, '2026-11-03', 1000n),
      answer: { status: 200, body: { id: B, counter: 1, detail: now }, seq: 3 },
      echo: [event(3, { entity: 'paying_in_batches', id: B })],
      other: event(4, { entity: 'paying_in_batches', id: B }),
      shown,
      before: 'open',
      after: 'closed',
    })
    await refused({
      start: () => h().w.reopen(B, 0),
      shown,
      before: 'closed',
    })
  })

  test('a line marked not a donation', async () => {
    const L = 'l1'
    const detail = (state: string) => ({
      line: { id: L, amount: 500, state },
      gifts: [],
      batchId: null,
      suggestions: [],
    })
    const LIST = `bank/lines/${L}`
    reads[LIST] = detail('unmatched')
    const h = mount(() => ({ line: useLine(L).data, w: useMatchWrites() }))
    const shown = () =>
      (h().line?.line as { state?: string } | undefined)?.state
    const now = detail('notDonation')
    await oneTrip({
      list: LIST,
      now,
      echoFirst: false,
      start: () => h().w.notDonation(L, 0, 'A grant'),
      answer: { status: 200, body: now, seq: 3 },
      echo: [event(3, { entity: 'bank_lines', id: L })],
      other: event(4, { entity: 'bank_lines', id: L }),
      shown,
      before: 'unmatched',
      after: 'notDonation',
    })
  })

  test('a scan accepted: the inbox it goes back to', async () => {
    const scan = (id: string, status: string) =>
      ({ id, status, reviewVersion: 0 }) as never
    reads.scans = [scan('s1', 'draft'), scan('s2', 'draft')]
    const h = mount(() => ({ inbox: useScanInbox().data, w: useScanWrites() }))
    const shown = () => h().inbox?.map((x) => x.id)
    const now = [scan('s2', 'draft')]
    await oneTrip({
      list: 'scans',
      now,
      echoFirst: true,
      start: () =>
        h().w.accept(scan('s1', 'draft'), 'c1', {
          kind: 'existing',
          declarationId: 'd1',
        }),
      answer: {
        status: 200,
        body: {
          declarationId: 'd1',
          scan: scan('s1', 'accepted'),
          inbox: now,
        },
        seq: 4,
      },
      echo: [
        event(3, { entity: 'declaration_scans', id: 's1' }),
        event(4, { entity: 'gift_aid_declarations', id: 'd1' }),
      ],
      other: event(5, { entity: 'declaration_scans', id: 's9' }),
      shown,
      before: ['s1', 's2'],
      after: ['s2'],
    })
  })
})
