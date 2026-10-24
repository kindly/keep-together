import { describe, expect, test } from 'vitest'
import type { Action, FormState, Slices } from '../../contact-form-state'
import { initialState, reduce, submission } from '../../contact-form-state'
import { saveActions, saveRequest } from './save'
import type { SaveFormResult } from '../rust-types/SaveFormResult'

// The Rust save's answers, run through the real form reducer (spike 04,
// unchanged): what the user sees after each.

const slices: Slices = {
  details: {
    kind: 'individual',
    title: '',
    firstName: 'Ada',
    lastName: 'Lovelace',
    nickname: '',
    name: '',
    isDeceased: false,
  },
  methods: {
    emails: [{ key: 'e1', label: 'home', address: 'a@x.com', isPrimary: true }],
    phones: [],
  },
  addresses: { addresses: [] },
  identifiers: { identifiers: [] },
  fields: { values: [] },
}
const counters = {
  details: 3,
  methods: 5,
  addresses: 0,
  identifiers: 0,
  fields: 0,
}

const run = (state: FormState, actions: Array<Action>) =>
  actions.reduce(reduce, state)

/** The form with `edits` typed and committed, its save in flight. */
function saving(edits: Partial<Slices>) {
  let s = initialState(slices, counters)
  for (const [slice, value] of Object.entries(edits))
    s = reduce(s, {
      type: 'edit',
      slice: slice as never,
      value: value as never,
    })
  s = reduce(s, { type: 'commit' })
  const submitted = submission(s)
  return { state: reduce(s, { type: 'saving' }), submitted }
}

/** An answer from `POST contacts/{id}/save`, Convex's shape plus `current`. */
const answer = (a: Partial<SaveFormResult>): SaveFormResult => ({
  saved: [],
  problems: {},
  stale: {},
  current: {},
  counters: {
    details: 3,
    methods: 5,
    addresses: 0,
    archive: 0,
    fields: 0,
    identifiers: 0,
    acquisition: 0,
  },
  ...a,
})

describe('rust save', () => {
  test('the request carries each slice with its expected counter, as Convex’s saveForm', () => {
    const { submitted, state } = saving({
      details: { ...slices.details, nickname: 'Countess' },
      methods: { ...slices.methods, phones: [] },
    })
    expect(saveRequest(submitted, state.counters)).toEqual({
      source: 'autosave',
      details: { expected: 3, ...slices.details, nickname: 'Countess' },
    })
  })

  test('a saved answer takes the new counters and leaves the form clean', () => {
    const { state, submitted } = saving({
      details: { ...slices.details, nickname: 'Countess' },
    })
    const s = run(
      state,
      saveActions(
        submitted,
        state,
        answer({
          saved: ['details'],
          counters: {
            details: 4,
            methods: 5,
            addresses: 0,
            archive: 0,
            fields: 0,
            identifiers: 0,
            acquisition: 0,
          },
        }),
        1,
      ),
    )
    expect(s.status).toBe('saved')
    expect(s.counters.details).toBe(4)
    expect(s.counters.identifiers).toBe(0)
    expect(s.dirty.details).toBe(false)
    expect(s.needsSave).toBe(false)
  })

  test('stale: the other tab’s change is merged and the save retried against its counter', () => {
    // We changed the nickname; the other tab changed the last name.
    const { state, submitted } = saving({
      details: { ...slices.details, nickname: 'Countess' },
    })
    const theirs = { ...slices.details, lastName: 'King' }
    const s = run(
      state,
      saveActions(
        submitted,
        state,
        answer({ stale: { details: 4 }, current: { details: theirs } }),
        1,
      ),
    )
    expect(s.local.details).toEqual({ ...theirs, nickname: 'Countess' })
    expect(s.base.details).toEqual(theirs)
    expect(s.counters.details).toBe(4)
    expect(s.conflicts).toEqual([])
    // Merged, so no notice left, and the retry is queued.
    expect(s.stale).toEqual({})
    expect(s.needsSave).toBe(true)
    expect(saveRequest(submission(s), s.counters)).toEqual({
      source: 'autosave',
      details: { expected: 4, ...theirs, nickname: 'Countess' },
    })
  })

  test('one slice stale, another saved: only the stale one is retried', () => {
    const { state, submitted } = saving({
      details: { ...slices.details, nickname: 'Countess' },
      methods: { ...slices.methods, emails: [] },
    })
    const s = run(
      state,
      saveActions(
        submitted,
        state,
        answer({
          saved: ['methods'],
          stale: { details: 4 },
          current: { details: slices.details },
          counters: {
            details: 3,
            methods: 6,
            addresses: 0,
            archive: 0,
            fields: 0,
            identifiers: 0,
            acquisition: 0,
          },
        }),
        1,
      ),
    )
    expect(s.dirty.methods).toBe(false)
    expect(s.counters.methods).toBe(6)
    expect(s.local.methods.emails).toEqual([])
    expect(Object.keys(submission(s))).toEqual(['details'])
    expect(s.counters.details).toBe(4)
  })

  test('stale with the same field changed on both sides: ours kept, flagged', () => {
    const { state, submitted } = saving({
      details: { ...slices.details, lastName: 'Byron' },
    })
    const s = run(
      state,
      saveActions(
        submitted,
        state,
        answer({
          stale: { details: 4 },
          current: { details: { ...slices.details, lastName: 'King' } },
        }),
        1,
      ),
    )
    expect(s.local.details.lastName).toBe('Byron')
    expect(s.conflicts).toEqual(['details.lastName'])
    expect(s.needsSave).toBe(true)
  })

  test('stale child rows merge by key: ours added, theirs kept', () => {
    const ours = {
      ...slices.methods,
      phones: [
        {
          key: 'p1',
          label: 'work' as const,
          number: '01632 960000',
          isPrimary: false,
        },
      ],
    }
    const { state, submitted } = saving({ methods: ours })
    const theirs = {
      emails: [
        ...slices.methods.emails,
        {
          key: 'e2',
          label: 'work' as const,
          address: 'ada@work',
          isPrimary: false,
        },
      ],
      phones: [],
    }
    const s = run(
      state,
      saveActions(
        submitted,
        state,
        answer({ stale: { methods: 6 }, current: { methods: theirs } }),
        1,
      ),
    )
    expect(s.local.methods).toEqual({
      emails: theirs.emails,
      phones: ours.phones,
    })
    expect(s.counters.methods).toBe(6)
    expect(s.needsSave).toBe(true)
  })

  test('problems: the refused slice shows them and waits for an edit', () => {
    const { state, submitted } = saving({
      details: { ...slices.details, firstName: '' },
    })
    const s = run(
      state,
      saveActions(
        submitted,
        state,
        answer({
          problems: {
            details: [{ field: 'firstName', message: 'A name is needed' }],
          },
        }),
        1,
      ),
    )
    expect(s.problems.details).toEqual([
      { field: 'firstName', message: 'A name is needed' },
    ])
    expect(s.dirty.details).toBe(true)
    expect(s.needsSave).toBe(false)
  })

  test('codex C1 #1: a save never adopts the counter of a slice it did not send', () => {
    // B adds a phone (methods 5 → 6); A, still showing no phone, saves a
    // nickname. The answer carries every counter, methods' at 6.
    const { state, submitted } = saving({
      details: { ...slices.details, nickname: 'Countess' },
    })
    const s = run(
      state,
      saveActions(
        submitted,
        state,
        answer({
          saved: ['details'],
          counters: {
            details: 4,
            methods: 6,
            addresses: 0,
            archive: 0,
            fields: 0,
            identifiers: 0,
            acquisition: 0,
          },
        }),
        1,
      ),
    )
    expect(s.counters.details).toBe(4)
    expect(s.counters.methods).toBe(5)
    // A edits methods before the refetch lands: the save is checked
    // against 5, so the server reports it stale instead of deleting B's
    // phone.
    const ownEmail = {
      key: 'e2',
      label: 'work' as const,
      address: 'ada@work',
      isPrimary: false,
    }
    const edited = reduce(
      reduce(s, {
        type: 'edit',
        slice: 'methods',
        value: {
          ...slices.methods,
          emails: [...slices.methods.emails, ownEmail],
        },
      }),
      { type: 'commit' },
    )
    expect(saveRequest(submission(edited), edited.counters)).toMatchObject({
      methods: { expected: 5 },
    })
    // The refetch (B's phone at 6) is not mistaken for an echo: merged in.
    const phone = {
      key: 'p1',
      label: 'home' as const,
      number: '07700 900000',
      isPrimary: true,
    }
    const fetched = { ...slices.methods, phones: [phone] }
    const merged = reduce(edited, {
      type: 'server',
      slices: { ...s.base, methods: fetched },
      counters: { ...s.counters, methods: 6 },
    })
    expect(merged.counters.methods).toBe(6)
    expect(merged.local.methods.phones).toEqual([phone])
    expect(saveRequest(submission(merged), merged.counters)).toEqual({
      source: 'autosave',
      methods: {
        expected: 6,
        emails: [...slices.methods.emails, ownEmail],
        phones: [phone],
      },
    })
  })

  test('codex C1 #1: a refused slice keeps its counter too', () => {
    // Validity is checked before staleness: a refused slice's counter may
    // be another tab's.
    const { state, submitted } = saving({
      details: { ...slices.details, firstName: '' },
    })
    const s = run(
      state,
      saveActions(
        submitted,
        state,
        answer({
          problems: {
            details: [{ field: 'firstName', message: 'A name is needed' }],
          },
          counters: {
            details: 9,
            methods: 5,
            addresses: 0,
            archive: 0,
            fields: 0,
            identifiers: 0,
            acquisition: 0,
          },
        }),
        1,
      ),
    )
    expect(s.counters.details).toBe(3)
  })
})
