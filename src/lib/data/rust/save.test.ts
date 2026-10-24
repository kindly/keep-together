import { describe, expect, test } from 'vitest'
import type { Action, FormState, Slices } from '../../contact-form-state'
import { initialState, reduce, submission } from '../../contact-form-state'
import { saveRequest, savedActions, splitInvalid, staleActions } from './save'
import { sliceFromWire, sliceToWire } from './wire'

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

describe('rust save', () => {
  test('the request carries each slice with its expected counter, rows by id', () => {
    const { submitted, state } = saving({
      details: { ...slices.details, nickname: 'Countess' },
      methods: {
        ...slices.methods,
        phones: [
          {
            key: '0190f1d2-3c4b-7a00-8000-000000000001',
            label: 'work',
            number: '01632 960000',
            isPrimary: false,
          },
        ],
      },
    })
    expect(saveRequest(submitted, state.counters)).toEqual({
      source: 'autosave',
      slices: {
        details: { expected: 3, ...slices.details, nickname: 'Countess' },
        methods: {
          expected: 5,
          emails: [
            { id: 'e1', label: 'home', address: 'a@x.com', isPrimary: true },
          ],
          phones: [
            {
              id: '0190f1d23c4b7a008000000000000001',
              label: 'work',
              number: '01632 960000',
              isPrimary: false,
            },
          ],
        },
      },
    })
  })

  test('a saved answer takes the new counters and leaves the form clean', () => {
    const { state, submitted } = saving({
      details: { ...slices.details, nickname: 'Countess' },
    })
    const s = run(
      state,
      savedActions(
        submitted,
        state,
        { slices: { details: { id: 'c', counter: 4 } } },
        1,
      ),
    )
    expect(s.status).toBe('saved')
    expect(s.counters.details).toBe(4)
    expect(s.dirty.details).toBe(false)
    expect(s.needsSave).toBe(false)
  })

  test('409 stale: the other tab’s change is merged and the save retried against its counter', () => {
    // We changed the nickname; the other tab changed the last name.
    const { state, submitted } = saving({
      details: { ...slices.details, nickname: 'Countess' },
    })
    const theirs = { ...slices.details, lastName: 'King' }
    const s = run(
      state,
      staleActions(
        submitted,
        state,
        { contract: 'contacts.details', counter: 4, current: theirs },
        1,
      ),
    )
    expect(s.local.details).toEqual({ ...theirs, nickname: 'Countess' })
    expect(s.base.details).toEqual(theirs)
    expect(s.counters.details).toBe(4)
    expect(s.conflicts).toEqual([])
    // Merged, so no notice left, and the retry is queued.
    expect(s.stale).toEqual({})
    expect(s.status).toBe('saved')
    expect(s.needsSave).toBe(true)
    expect(saveRequest(submission(s), s.counters).slices.details).toEqual({
      expected: 4,
      ...theirs,
      nickname: 'Countess',
    })
  })

  test('409 stale on one slice keeps the other slices dirty (nothing was saved)', () => {
    const { state, submitted } = saving({
      details: { ...slices.details, nickname: 'Countess' },
      methods: { ...slices.methods, phones: [], emails: [] },
    })
    const s = run(
      state,
      staleActions(
        submitted,
        state,
        {
          contract: 'contacts.details',
          counter: 4,
          current: slices.details,
        },
        1,
      ),
    )
    expect(s.dirty.methods).toBe(true)
    expect(s.counters.methods).toBe(5)
    expect(Object.keys(submission(s)).sort()).toEqual(['details', 'methods'])
  })

  test('409 stale with the same field changed on both sides: ours kept, flagged', () => {
    const { state, submitted } = saving({
      details: { ...slices.details, lastName: 'Byron' },
    })
    const s = run(
      state,
      staleActions(
        submitted,
        state,
        {
          contract: 'contacts.details',
          counter: 4,
          current: { ...slices.details, lastName: 'King' },
        },
        1,
      ),
    )
    expect(s.local.details.lastName).toBe('Byron')
    expect(s.conflicts).toEqual(['details.lastName'])
    expect(s.needsSave).toBe(true)
  })

  test('409 stale on child rows: their rows arrive by id and merge by key', () => {
    const { state, submitted } = saving({
      details: { ...slices.details, nickname: 'Countess' },
    })
    const current = {
      emails: [
        { id: 'e1', label: 'home', address: 'a@x.com', isPrimary: true },
        { id: 'e2', label: 'work', address: 'ada@work', isPrimary: false },
      ],
      phones: [],
    }
    expect(sliceFromWire('methods', current).emails.map((e) => e.key)).toEqual([
      'e1',
      'e2',
    ])
    const s = run(
      state,
      staleActions(
        submitted,
        state,
        { contract: 'contacts.methods', counter: 6, current },
        1,
      ),
    )
    // Methods was clean here: it follows the server.
    expect(s.local.methods.emails).toHaveLength(2)
    expect(s.counters.methods).toBe(6)
    expect(s.needsSave).toBe(true)
  })

  test('422 invalid: the refused slice shows its problem, the rest is sent alone', () => {
    const { state, submitted } = saving({
      details: { ...slices.details, firstName: '' },
      methods: { ...slices.methods, emails: [] },
    })
    const split = splitInvalid(submitted, [
      { field: 'details.firstName', message: 'A name is needed' },
    ])!
    expect(Object.keys(split.rest)).toEqual(['methods'])
    const s = run(
      state,
      savedActions(
        submitted,
        state,
        { slices: { methods: { id: 'c', counter: 6 } } },
        1,
        split.problems,
      ),
    )
    expect(s.problems.details).toEqual([
      { field: 'firstName', message: 'A name is needed' },
    ])
    expect(s.dirty.methods).toBe(false)
    expect(s.dirty.details).toBe(true)
    // The refused value waits for an edit: no retry loop.
    expect(s.needsSave).toBe(false)
  })

  test('a problem naming no submitted slice fails the whole save', () => {
    const { submitted } = saving({
      details: { ...slices.details, nickname: 'X' },
    })
    expect(splitInvalid(submitted, [{ field: 'body', message: '?' }])).toBe(
      null,
    )
  })

  test('a stale contract the form has no slice for is a failure', () => {
    const { state, submitted } = saving({
      details: { ...slices.details, nickname: 'X' },
    })
    const s = run(
      state,
      staleActions(
        submitted,
        state,
        { contract: 'contacts.archive', counter: 2, current: {} },
        1,
      ),
    )
    expect(s.status).toBe('error')
  })

  test('rows round-trip: key ↔ id, a new row has neither', () => {
    const wire = sliceToWire({
      emails: [
        { key: '', label: 'home', address: 'n@x', isPrimary: false },
        { key: 'ab-cd', label: 'home', address: 'o@x', isPrimary: true },
      ],
      phones: [],
    })
    expect(wire).toEqual({
      emails: [
        { label: 'home', address: 'n@x', isPrimary: false },
        { id: 'abcd', label: 'home', address: 'o@x', isPrimary: true },
      ],
      phones: [],
    })
  })
})
