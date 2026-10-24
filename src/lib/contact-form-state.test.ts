import { describe, expect, test } from 'vitest'
import type { Id } from '../../convex/_generated/dataModel'
import type { Counters, FormState, Slices } from './contact-form-state'
import {
  newKey,
  clean,
  initialState,
  reduce,
  mergeFieldValues,
  mergeIdentifiers,
  rekey,
  submission,
  tornSlices,
  unsavedWork,
} from './contact-form-state'

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
  identifiers: {
    identifiers: [
      { key: 'i1', typeId: 'typeOld' as Id<'identifierTypes'>, value: 'M1' },
    ],
  },
  fields: { values: [] },
}
const counters = {
  details: 0,
  methods: 0,
  addresses: 0,
  identifiers: 0,
  fields: 0,
}

describe('contact form state', () => {
  test('a clean slice follows the server', () => {
    const s = reduce(initialState(slices, counters), {
      type: 'server',
      slices: { ...slices, details: { ...slices.details, lastName: 'Byron' } },
      counters: { ...counters, details: 1 },
    })
    expect(s.local.details.lastName).toBe('Byron')
    expect(s.counters.details).toBe(1)
    expect(s.dirty.details).toBe(false)
  })

  test('typing marks the slice dirty; committing asks for a save', () => {
    let s = reduce(initialState(slices, counters), {
      type: 'edit',
      slice: 'details',
      value: { ...slices.details, nickname: 'Countess' },
    })
    expect(s.dirty.details).toBe(true)
    expect(s.needsSave).toBe(false)
    s = reduce(s, { type: 'commit' })
    expect(s.needsSave).toBe(true)
    expect(Object.keys(submission(s))).toEqual(['details'])
  })

  test('a blank new row is neither dirty nor submitted', () => {
    const withBlank = {
      emails: [
        ...slices.methods.emails,
        { key: 'e2', label: 'home' as const, address: '', isPrimary: false },
      ],
      phones: [],
    }
    let s = reduce(initialState(slices, counters), {
      type: 'edit',
      slice: 'methods',
      value: withBlank,
    })
    expect(s.dirty.methods).toBe(false)
    s = reduce(s, { type: 'commit' })
    expect(s.needsSave).toBe(false)
    expect(clean('methods', withBlank).emails).toHaveLength(1)
  })

  test('editing a saved email address re-keys the row at commit, not per keystroke', () => {
    let s = reduce(initialState(slices, counters), {
      type: 'edit',
      slice: 'methods',
      value: {
        emails: [
          { key: 'e1', label: 'home', address: 'b@x.com', isPrimary: true },
        ],
        phones: [],
      },
    })
    expect(s.local.methods.emails[0].key).toBe('e1')
    s = reduce(s, { type: 'commit' })
    expect(s.local.methods.emails[0].key).not.toBe('e1')
    expect(s.dirty.methods).toBe(true)
    expect(
      rekey(slices.methods, slices.methods, () => 'new').emails[0].key,
    ).toBe('e1')
  })

  test('a remote change to another field merges under in-progress typing', () => {
    let s = reduce(initialState(slices, counters), {
      type: 'edit',
      slice: 'details',
      value: { ...slices.details, nickname: 'Coun' },
    })
    s = reduce(s, {
      type: 'server',
      slices: { ...slices, details: { ...slices.details, title: 'Lady' } },
      counters: { ...counters, details: 1 },
    })
    expect(s.local.details).toMatchObject({ nickname: 'Coun', title: 'Lady' })
    expect(s.conflicts).toEqual([])
    expect(s.dirty.details).toBe(true)
    expect(s.needsSave).toBe(true) // retry against counter 1
  })

  test('both sides changing one field is a conflict; local wins and is flagged', () => {
    let s = reduce(initialState(slices, counters), {
      type: 'edit',
      slice: 'details',
      value: { ...slices.details, lastName: 'King' },
    })
    s = reduce(s, {
      type: 'server',
      slices: { ...slices, details: { ...slices.details, lastName: 'Byron' } },
      counters: { ...counters, details: 1 },
    })
    expect(s.local.details.lastName).toBe('King')
    expect(s.conflicts).toEqual(['details.lastName'])
  })

  test('our own save echoing back is ignored', () => {
    let s = reduce(initialState(slices, counters), {
      type: 'edit',
      slice: 'details',
      value: { ...slices.details, nickname: 'Countess' },
    })
    const submitted = submission(s)
    s = reduce(s, { type: 'saving' })
    s = reduce(s, {
      type: 'saved',
      submitted,
      at: 1,
      result: {
        saved: ['details'],
        problems: {},
        stale: {},
        counters: {
          details: 1,
          methods: 0,
          addresses: 0,
          archive: 0,
          identifiers: 0,
          fields: 0,
        },
      },
    })
    expect(s.dirty.details).toBe(false)
    expect(s.status).toBe('saved')
    // The subscription now delivers the saved state with counter 1: no change.
    const echoed = reduce(s, {
      type: 'server',
      slices: {
        ...slices,
        details: { ...slices.details, nickname: 'Countess' },
      },
      counters: { ...counters, details: 1 },
    })
    expect(echoed.local).toBe(s.local)
  })

  test('typing during a save keeps the slice dirty afterwards', () => {
    let s = reduce(initialState(slices, counters), {
      type: 'edit',
      slice: 'details',
      value: { ...slices.details, nickname: 'Coun' },
    })
    const submitted = submission(s)
    s = reduce(s, { type: 'saving' })
    s = reduce(s, {
      type: 'edit',
      slice: 'details',
      value: { ...slices.details, nickname: 'Countess' },
    })
    s = reduce(s, {
      type: 'saved',
      submitted,
      at: 1,
      result: {
        saved: ['details'],
        problems: {},
        stale: {},
        counters: {
          details: 1,
          methods: 0,
          addresses: 0,
          archive: 0,
          identifiers: 0,
          fields: 0,
        },
      },
    })
    expect(s.base.details.nickname).toBe('Coun')
    expect(s.dirty.details).toBe(true)
    expect(s.needsSave).toBe(true)
  })

  test('a stale slice is reported, then cleared when the newer state arrives', () => {
    let s = reduce(initialState(slices, counters), {
      type: 'edit',
      slice: 'methods',
      value: { emails: [], phones: [] },
    })
    const submitted = submission(s)
    s = reduce(s, { type: 'saving' })
    s = reduce(s, {
      type: 'saved',
      submitted,
      at: 1,
      result: {
        saved: [],
        problems: {},
        stale: { methods: 1 },
        counters: {
          details: 0,
          methods: 1,
          addresses: 0,
          archive: 0,
          identifiers: 0,
          fields: 0,
        },
      },
    })
    expect(s.stale).toEqual({ methods: 1 })
    expect(s.dirty.methods).toBe(true)
    const theirs = {
      emails: [
        {
          key: 'e2',
          label: 'home' as const,
          address: 'b@x.com',
          isPrimary: true,
        },
      ],
      phones: [],
    }
    s = reduce(s, {
      type: 'server',
      slices: { ...slices, methods: theirs },
      counters: { ...counters, methods: 1 },
    })
    expect(s.stale).toEqual({})
    // Both sides changed `emails`: conflict, local kept, save will retry with expected 1.
    expect(s.conflicts).toEqual(['methods.emails'])
    expect(s.counters.methods).toBe(1)
  })

  describe('a stale notice clears once the retry saves', () => {
    const theirs = { ...slices.details, title: 'Lady' }
    const mine = { ...slices.details, nickname: 'Countess' }
    const result = (
      saved: Array<'details'>,
      stale: { details?: number },
      details: number,
    ) => ({
      saved,
      problems: {},
      stale,
      counters: {
        details,
        methods: 0,
        addresses: 0,
        archive: 0,
        identifiers: 0,
        fields: 0,
      },
    })

    // Their change (counter 1) has already reached us when our save, sent
    // against counter 0, comes back stale; the retry goes against 1.
    function retrying() {
      let s = reduce(initialState(slices, counters), {
        type: 'edit',
        slice: 'details',
        value: mine,
      })
      const first = submission(s)
      s = reduce(s, { type: 'saving' })
      s = reduce(s, {
        type: 'server',
        slices: { ...slices, details: theirs },
        counters: { ...counters, details: 1 },
      })
      s = reduce(s, {
        type: 'saved',
        submitted: first,
        at: 1,
        result: result([], { details: 1 }, 1),
      })
      expect(s.stale).toEqual({ details: 1 })
      expect(s.needsSave).toBe(true)
      const retry = submission(s)
      expect(retry.details).toMatchObject({
        title: 'Lady',
        nickname: 'Countess',
      })
      return { s: reduce(s, { type: 'saving' }), retry }
    }
    const echo = {
      type: 'server' as const,
      slices: {
        ...slices,
        details: { ...slices.details, title: 'Lady', nickname: 'Countess' },
      },
      counters: { ...counters, details: 2 },
    }

    test('result before echo', () => {
      const { s: start, retry } = retrying()
      let s = start
      s = reduce(s, {
        type: 'saved',
        submitted: retry,
        at: 2,
        result: result(['details'], {}, 2),
      })
      expect(s.stale).toEqual({})
      s = reduce(s, echo)
      expect(s.stale).toEqual({})
      expect(s.dirty.details).toBe(false)
    })

    test('echo before result', () => {
      const { s: start, retry } = retrying()
      let s = start
      s = reduce(s, echo)
      expect(s.stale).toEqual({})
      s = reduce(s, {
        type: 'saved',
        submitted: retry,
        at: 2,
        result: result(['details'], {}, 2),
      })
      expect(s.stale).toEqual({})
      expect(s.dirty.details).toBe(false)
    })
  })

  test('a blocking problem keeps the slice dirty without retrying', () => {
    let s = reduce(initialState(slices, counters), {
      type: 'edit',
      slice: 'details',
      value: { ...slices.details, lastName: '' },
    })
    const submitted = submission(s)
    s = reduce(s, { type: 'saving' })
    s = reduce(s, {
      type: 'saved',
      submitted,
      at: 1,
      result: {
        saved: [],
        problems: { details: [{ field: 'lastName', message: 'needed' }] },
        stale: {},
        counters: {
          details: 0,
          methods: 0,
          addresses: 0,
          archive: 0,
          identifiers: 0,
          fields: 0,
        },
      },
    })
    expect(s.problems.details?.[0].field).toBe('lastName')
    expect(s.dirty.details).toBe(true)
    expect(s.needsSave).toBe(false)
  })

  test('a problem slice corrected during the save is retried, its problem dropped', () => {
    let s = reduce(initialState(slices, counters), {
      type: 'edit',
      slice: 'details',
      value: { ...slices.details, lastName: '' },
    })
    s = reduce(s, { type: 'commit' })
    const submitted = submission(s)
    s = reduce(s, { type: 'saving' })
    // Corrected and blurred while the refused value is in flight.
    s = reduce(s, {
      type: 'edit',
      slice: 'details',
      value: { ...slices.details, lastName: 'Byron' },
    })
    s = reduce(s, { type: 'commit' })
    s = reduce(s, {
      type: 'saved',
      submitted,
      at: 1,
      result: {
        saved: [],
        problems: { details: [{ field: 'lastName', message: 'needed' }] },
        stale: {},
        counters: { ...counters, archive: 0 },
      },
    })
    expect(s.problems.details).toBeUndefined()
    expect(s.dirty.details).toBe(true)
    expect(s.needsSave).toBe(true)
    expect(submission(s).details?.lastName).toBe('Byron')
  })

  test('a stale identifiers save is noticed and cleared once the retry saves', () => {
    const row = (key: string, value: string) => ({
      key,
      typeId: 'typeOld' as Id<'identifierTypes'>,
      value,
    })
    let s = reduce(initialState(slices, counters), {
      type: 'edit',
      slice: 'identifiers',
      value: { identifiers: [] },
    })
    const first = submission(s)
    expect(Object.keys(first)).toEqual(['identifiers'])
    s = reduce(s, { type: 'saving' })
    const theirs = { identifiers: [row('i1', 'M1'), row('i9', 'M9')] }
    s = reduce(s, {
      type: 'server',
      slices: { ...slices, identifiers: theirs },
      counters: { ...counters, identifiers: 1 },
    })
    s = reduce(s, {
      type: 'saved',
      submitted: first,
      at: 1,
      result: {
        saved: [],
        problems: {},
        stale: { identifiers: 1 },
        counters: {
          details: 0,
          methods: 0,
          addresses: 0,
          archive: 0,
          identifiers: 1,
          fields: 0,
        },
      },
    })
    expect(s.stale).toEqual({ identifiers: 1 })
    const retry = submission(s)
    expect(retry.identifiers).toEqual({ identifiers: [row('i9', 'M9')] })
    s = reduce(s, { type: 'saving' })
    s = reduce(s, {
      type: 'saved',
      submitted: retry,
      at: 2,
      result: {
        saved: ['identifiers'],
        problems: {},
        stale: {},
        counters: {
          details: 0,
          methods: 0,
          addresses: 0,
          archive: 0,
          identifiers: 2,
          fields: 0,
        },
      },
    })
    expect(s.stale).toEqual({})
    expect(s.dirty.identifiers).toBe(false)
  })
})

describe('unfilled rows', () => {
  const email = (key: string, address: string) => ({
    key,
    label: 'home' as const,
    address,
    isPrimary: false,
  })
  const a = slices.methods.emails[0]
  const blank = email('e9', '')

  test('are never submitted, and base stays clean after the save', () => {
    let s = reduce(initialState(slices, counters), {
      type: 'edit',
      slice: 'methods',
      value: { emails: [a, email('e2', 'b@x.com'), blank], phones: [] },
    })
    s = reduce(s, { type: 'commit' })
    const submitted = submission(s)
    expect(submitted.methods?.emails).toEqual([a, email('e2', 'b@x.com')])
    s = reduce(s, { type: 'saving' })
    s = reduce(s, {
      type: 'saved',
      submitted,
      at: 1,
      result: {
        saved: ['methods'],
        problems: {},
        stale: {},
        counters: { ...counters, methods: 1, archive: 0 },
      },
    })
    expect(s.base.methods.emails).toEqual([a, email('e2', 'b@x.com')])
    expect(s.local.methods.emails).toContain(blank)
    expect(s.dirty.methods).toBe(false)
    expect(s.needsSave).toBe(false)
  })

  test('a blank row on screen never turns a remote change into a conflict', () => {
    // Emails [A] plus a blank row; a new phone makes methods dirty. Another
    // tab adds email C. The retry must keep C, not overwrite it with [A].
    const phone = {
      key: 'p1',
      label: 'home' as const,
      number: '01632',
      isPrimary: true,
    }
    const c = email('e3', 'c@x.com')
    let s = reduce(initialState(slices, counters), {
      type: 'edit',
      slice: 'methods',
      value: { emails: [a, blank], phones: [phone] },
    })
    s = reduce(s, {
      type: 'server',
      slices: { ...slices, methods: { emails: [a, c], phones: [] } },
      counters: { ...counters, methods: 1 },
    })
    expect(s.conflicts).toEqual([])
    expect(s.local.methods).toEqual({ emails: [a, c, blank], phones: [phone] })
    expect(submission(s).methods).toEqual({ emails: [a, c], phones: [phone] })
    expect(s.needsSave).toBe(true)
  })
})

describe('a slice edited back to its saved state', () => {
  test('drops its problems (details here)', () => {
    let s = reduce(initialState(slices, counters), {
      type: 'edit',
      slice: 'details',
      value: { ...slices.details, lastName: '' },
    })
    const submitted = submission(s)
    s = reduce(s, {
      type: 'saved',
      submitted,
      at: 1,
      result: {
        saved: [],
        problems: { details: [{ field: 'lastName', message: 'needed' }] },
        stale: {},
        counters: { ...counters, archive: 0 },
      },
    })
    expect(s.problems.details).toHaveLength(1)
    s = reduce(s, { type: 'edit', slice: 'details', value: slices.details })
    expect(s.dirty.details).toBe(false)
    expect(s.problems.details).toBeUndefined()
    expect(unsavedWork(s)).toBe('clean')
  })
})

describe('the identifiers slice', () => {
  const row = (key: string, typeId: string, value: string) => ({
    key,
    typeId: typeId as Id<'identifierTypes'>,
    value,
  })
  const old = row('i1', 'typeOld', 'M1')
  const zeros = { ...counters, archive: 0 }

  test('a row without both a type and a value is neither dirty nor sent', () => {
    for (const unfilled of [row('i2', '', 'M2'), row('i2', 'typeOld', '  ')]) {
      const s = reduce(initialState(slices, counters), {
        type: 'edit',
        slice: 'identifiers',
        value: { identifiers: [old, unfilled] },
      })
      expect(s.dirty.identifiers).toBe(false)
      expect(submission(s)).toEqual({})
    }
    let s = reduce(initialState(slices, counters), {
      type: 'edit',
      slice: 'identifiers',
      value: {
        identifiers: [old, row('i2', 'typeOld', 'M2'), row('i3', '', '')],
      },
    })
    expect(submission(s).identifiers).toEqual({
      identifiers: [old, row('i2', 'typeOld', 'M2')],
    })
    s = reduce(s, { type: 'commit' })
    expect(unsavedWork(s)).toBe('busy')
  })

  test('a value typed without a type is unsaved work, though not sent', () => {
    const s = reduce(initialState(slices, counters), {
      type: 'edit',
      slice: 'identifiers',
      value: { identifiers: [old, row('i2', '', 'M2')] },
    })
    expect(s.dirty.identifiers).toBe(false)
    expect(submission(s)).toEqual({})
    expect(unsavedWork(s)).toBe('unsaved')
  })

  test('a clash stays on its row (by key) until the row is removed', () => {
    const clashing = row('i2', 'typeOld', 'M9')
    let s = reduce(initialState(slices, counters), {
      type: 'edit',
      slice: 'identifiers',
      value: { identifiers: [old, clashing] },
    })
    const submitted = submission(s)
    s = reduce(s, { type: 'saving' })
    s = reduce(s, {
      type: 'saved',
      submitted,
      at: 1,
      result: {
        saved: [],
        problems: {
          identifiers: [
            {
              field: 'identifiers',
              message: 'M9 is already used by Ada Byron',
              key: 'i2',
              contactId: 'other' as Id<'contacts'>,
            },
          ],
        },
        stale: {},
        counters: zeros,
      },
    })
    expect(s.problems.identifiers?.[0].key).toBe('i2')
    expect(s.dirty.identifiers).toBe(true)
    expect(s.needsSave).toBe(false)
    expect(unsavedWork(s)).toBe('unsaved')
    // Still dirty after an unrelated edit: the problem stays.
    s = reduce(s, {
      type: 'edit',
      slice: 'identifiers',
      value: { identifiers: [old, { ...clashing, value: 'M99' }] },
    })
    expect(s.problems.identifiers).toHaveLength(1)
    // Removing the row leaves nothing to save, and nothing to fix.
    s = reduce(s, {
      type: 'edit',
      slice: 'identifiers',
      value: { identifiers: [old] },
    })
    expect(s.dirty.identifiers).toBe(false)
    expect(s.problems.identifiers).toBeUndefined()
    expect(unsavedWork(s)).toBe('clean')
  })

  test('a clash corrected during the save is retried; an untouched one waits', () => {
    const clashing = row('i2', 'typeOld', 'M9')
    const refusal = {
      saved: [],
      problems: {
        identifiers: [
          {
            field: 'identifiers',
            message: 'M9 is already used by Ada Byron',
            key: 'i2',
            contactId: 'other' as Id<'contacts'>,
          },
        ],
      },
      stale: {},
      counters: zeros,
    }
    let s = reduce(initialState(slices, counters), {
      type: 'edit',
      slice: 'identifiers',
      value: { identifiers: [old, clashing] },
    })
    s = reduce(s, { type: 'commit' })
    const submitted = submission(s)
    s = reduce(s, { type: 'saving' })
    // A commit with nothing new (another field's blur) changes nothing.
    s = reduce(s, { type: 'commit' })
    const untouched = reduce(s, {
      type: 'saved',
      submitted,
      at: 1,
      result: refusal,
    })
    expect(untouched.problems.identifiers).toHaveLength(1)
    expect(untouched.needsSave).toBe(false)

    s = reduce(s, {
      type: 'edit',
      slice: 'identifiers',
      value: { identifiers: [old, { ...clashing, value: 'M10' }] },
    })
    s = reduce(s, { type: 'commit' })
    s = reduce(s, { type: 'saved', submitted, at: 1, result: refusal })
    expect(s.problems.identifiers).toBeUndefined()
    expect(s.needsSave).toBe(true)
    expect(unsavedWork(s)).toBe('busy')
  })

  test('rows added here and elsewhere merge by key, removals stick', () => {
    const theirs = row('t9', 'typeOld', 'M7')
    const mine = row('i2', 'typeOld', 'M2')
    expect(
      mergeIdentifiers(
        { identifiers: [old] },
        { identifiers: [mine] },
        { identifiers: [old, theirs] },
      ),
    ).toEqual({ identifiers: [theirs, mine] })

    let s = reduce(initialState(slices, counters), {
      type: 'edit',
      slice: 'identifiers',
      value: { identifiers: [old, mine] },
    })
    s = reduce(s, {
      type: 'server',
      slices: { ...slices, identifiers: { identifiers: [old, theirs] } },
      counters: { ...counters, identifiers: 1 },
    })
    expect(s.local.identifiers.identifiers).toEqual([old, theirs, mine])
    expect(s.conflicts).toEqual([])
    expect(s.counters.identifiers).toBe(1)
    expect(s.needsSave).toBe(true)
  })
})

describe('unsavedWork', () => {
  test('a commit during the save that took everything leaves it clean', () => {
    const phone = {
      key: 'p1',
      label: 'home' as const,
      number: '07700 900123',
      isPrimary: true,
    }
    let s = reduce(initialState(slices, counters), {
      type: 'edit',
      slice: 'methods',
      value: { ...slices.methods, phones: [phone] },
    })
    s = reduce(s, { type: 'commit' })
    const submitted = submission(s)
    s = reduce(s, { type: 'saving' })
    // The Save click's blur commits while the save is in flight.
    s = reduce(s, { type: 'commit' })
    expect(s.needsSave).toBe(true)
    s = reduce(s, {
      type: 'saved',
      submitted,
      at: 1,
      result: {
        saved: ['methods'],
        problems: {},
        stale: {},
        counters: {
          details: 0,
          methods: 1,
          addresses: 0,
          archive: 0,
          identifiers: 0,
          fields: 0,
        },
      },
    })
    expect(s.needsSave).toBe(false)
    expect(unsavedWork(s)).toBe('clean')
  })

  test('a queued save a remote merge made moot is unqueued', () => {
    const nickname = { ...slices.details, nickname: 'Countess' }
    let s = reduce(initialState(slices, counters), {
      type: 'edit',
      slice: 'details',
      value: nickname,
    })
    s = reduce(s, { type: 'commit' })
    // The same edit, made in another tab, lands before the autosave.
    s = reduce(s, {
      type: 'server',
      slices: { ...slices, details: nickname },
      counters: { ...counters, details: 1 },
    })
    expect(s.dirty.details).toBe(false)
    expect(submission(s)).toEqual({})
    // What save() dispatches when it finds nothing to submit.
    s = reduce(s, { type: 'nothingToSave' })
    expect(s.needsSave).toBe(false)
    expect(unsavedWork(s)).toBe('clean')
  })

  test('nothingToSave keeps a save queued by a later edit', () => {
    let s = reduce(initialState(slices, counters), {
      type: 'edit',
      slice: 'details',
      value: { ...slices.details, nickname: 'Countess' },
    })
    s = reduce(s, { type: 'commit' })
    s = reduce(s, { type: 'nothingToSave' })
    expect(s.needsSave).toBe(true)
  })

  const typed = (state = initialState(slices, counters)) =>
    reduce(state, {
      type: 'edit',
      slice: 'details',
      value: { ...slices.details, nickname: 'Countess' },
    })
  const submitted = { details: { ...slices.details, nickname: 'Countess' } }
  const after = (
    result: Partial<{
      saved: Array<'details'>
      problems: { details?: Array<{ field: string; message: string }> }
      stale: { details?: number }
    }>,
  ) =>
    reduce(reduce(reduce(typed(), { type: 'commit' }), { type: 'saving' }), {
      type: 'saved',
      submitted,
      at: 1,
      result: {
        saved: [],
        problems: {},
        stale: {},
        counters: { ...counters, archive: 0 },
        ...result,
      },
    })

  test('clean when nothing is edited', () => {
    expect(unsavedWork(initialState(slices, counters))).toBe('clean')
  })

  test('an edit still being typed is unsaved', () => {
    expect(unsavedWork(typed())).toBe('unsaved')
  })

  test('a committed edit (queued save) and a save in flight are busy', () => {
    const committed = reduce(typed(), { type: 'commit' })
    expect(unsavedWork(committed)).toBe('busy')
    expect(unsavedWork(reduce(committed, { type: 'saving' }))).toBe('busy')
  })

  test('saved is clean again', () => {
    const s = after({
      saved: ['details'],
      // The counter the saved slice now holds.
    })
    expect(unsavedWork({ ...s, counters: { ...s.counters, details: 1 } })).toBe(
      'clean',
    )
  })

  test('a stale slice awaiting its retry is busy', () => {
    expect(unsavedWork(after({ stale: { details: 3 } }))).toBe('busy')
  })

  test('a refused (invalid) or failed save is unsaved', () => {
    expect(
      unsavedWork(
        after({
          problems: { details: [{ field: 'nickname', message: 'no' }] },
        }),
      ),
    ).toBe('unsaved')
    const failed = reduce(
      reduce(reduce(typed(), { type: 'commit' }), { type: 'saving' }),
      { type: 'failed', message: 'offline' },
    )
    expect(unsavedWork(failed)).toBe('unsaved')
  })
})

describe('a torn view (rows and counter delivered apart)', () => {
  const second = {
    key: 'e2',
    label: 'work' as const,
    address: 'b@x.com',
    isPrimary: false,
  }
  const v1 = { ...slices.methods, emails: [...slices.methods.emails, second] }
  /** What the contact form does with each delivery. */
  const form = (start: Slices) => {
    let last = { slices: start, counters }
    return (state: FormState, delivered: Slices, at: Counters): FormState => {
      const now = { slices: delivered, counters: at }
      const torn = tornSlices(last, now)
      last = now
      return reduce(state, { type: 'server', ...now, torn })
    }
  }

  test('the counter first, the rows after: a clean slice still takes the rows', () => {
    const deliver = form(slices)
    let s = initialState(slices, counters)
    s = deliver(s, slices, { ...counters, methods: 1 })
    expect(s.counters.methods).toBe(1)
    s = deliver(s, { ...slices, methods: v1 }, { ...counters, methods: 1 })
    expect(s.local.methods).toEqual(v1)
    expect(s.base.methods).toEqual(v1)
    expect(s.dirty.methods).toBe(false)
  })

  test('a dirty slice merges the late rows like any remote change', () => {
    const deliver = form(slices)
    let s = initialState(slices, counters)
    s = reduce(s, {
      type: 'edit',
      slice: 'details',
      value: { ...slices.details, nickname: 'Countess' },
    })
    s = reduce(s, {
      type: 'edit',
      slice: 'methods',
      value: {
        ...slices.methods,
        emails: [{ ...slices.methods.emails[0], label: 'other' }],
      },
    })
    s = deliver(s, slices, { ...counters, methods: 1 })
    s = deliver(s, { ...slices, methods: v1 }, { ...counters, methods: 1 })
    // Merged against the rows the counter belongs to: both sides changed
    // the emails, so it is the usual flagged conflict, not a silent loss.
    expect(s.base.methods).toEqual(v1)
    expect(s.conflicts).toEqual(['methods.emails'])
    expect(s.local.methods.emails).toEqual([
      { ...slices.methods.emails[0], label: 'other' },
    ])
    expect(s.local.details.nickname).toBe('Countess')
  })

  test('the rows first, the counter after: taken once, then nothing new', () => {
    const deliver = form(slices)
    let s = initialState(slices, counters)
    s = deliver(s, { ...slices, methods: v1 }, counters)
    expect(s.local.methods).toEqual(v1)
    expect(s.counters.methods).toBe(0)
    const after = deliver(
      s,
      { ...slices, methods: v1 },
      { ...counters, methods: 1 },
    )
    expect(after.local.methods).toEqual(v1)
    expect(after.counters.methods).toBe(1)
  })

  test('our own save’s echo is not torn: in-progress typing survives it', () => {
    const deliver = form(slices)
    let s = initialState(slices, counters)
    const submitted = {
      ...slices.methods,
      emails: [...slices.methods.emails, second],
    }
    s = reduce(s, { type: 'edit', slice: 'methods', value: submitted })
    s = reduce(s, { type: 'commit' })
    s = reduce(s, { type: 'saving' })
    // Typing on during the save.
    const typing = {
      ...submitted,
      emails: [...submitted.emails, { ...second, key: 'e3', address: 'c@x' }],
    }
    s = reduce(s, { type: 'edit', slice: 'methods', value: typing })
    s = reduce(s, {
      type: 'saved',
      submitted: { methods: submitted },
      result: {
        saved: ['methods'],
        problems: {},
        stale: {},
        counters: { ...counters, methods: 1, archive: 0 },
      },
      at: 1,
    })
    // The echo, ordered as the server orders it.
    s = deliver(
      s,
      {
        ...slices,
        methods: { ...submitted, emails: [...submitted.emails].reverse() },
      },
      { ...counters, methods: 1 },
    )
    expect(s.local.methods).toEqual(typing)
    expect(s.dirty.methods).toBe(true)
  })

  test('rows reordered by a rename elsewhere, counter unchanged: nothing to take', () => {
    const row = (key: string, typeId: string, value: string) => ({
      key,
      typeId: typeId as Id<'identifierTypes'>,
      value,
    })
    const two = {
      identifiers: [row('i1', 'typeA', 'M1'), row('i2', 'typeB', 'M2')],
    }
    const deliver = form({ ...slices, identifiers: two })
    let s = initialState({ ...slices, identifiers: two }, counters)
    s = reduce(s, {
      type: 'edit',
      slice: 'identifiers',
      value: { identifiers: [two.identifiers[0]] },
    })
    s = deliver(
      s,
      {
        ...slices,
        identifiers: { identifiers: [...two.identifiers].reverse() },
      },
      counters,
    )
    expect(s.local.identifiers).toEqual({ identifiers: [two.identifiers[0]] })
    expect(s.base.identifiers).toEqual(two)
    expect(s.conflicts).toEqual([])
  })
})

describe('the fields slice', () => {
  const v = (fieldId: string, optionId: string) => ({
    fieldId: fieldId as Id<'contactFields'>,
    optionId: optionId as Id<'contactFieldOptions'>,
  })
  const withFields = (values: Array<ReturnType<typeof v>>): Slices => ({
    ...slices,
    fields: { values },
  })
  const zeros = { ...counters, archive: 0 }

  test('a field set here and another set elsewhere both survive', () => {
    let s = reduce(initialState(withFields([v('fA', 'north')]), counters), {
      type: 'edit',
      slice: 'fields',
      value: { values: [v('fA', 'south')] },
    })
    s = reduce(s, {
      type: 'server',
      slices: withFields([v('fA', 'north'), v('fB', 'active')]),
      counters: { ...counters, fields: 1 },
    })
    expect(s.local.fields.values).toEqual([v('fA', 'south'), v('fB', 'active')])
    expect(s.conflicts).toEqual([])
    expect(s.dirty.fields).toBe(true)
    expect(s.needsSave).toBe(true)
    expect(submission(s)).toEqual({
      fields: { values: [v('fA', 'south'), v('fB', 'active')] },
    })
  })

  test('a field cleared here stays cleared when another changes elsewhere', () => {
    const out = mergeFieldValues(
      { values: [v('fA', 'north')] },
      { values: [] },
      { values: [v('fA', 'north'), v('fB', 'active')] },
    )
    expect(out).toEqual({
      value: { values: [v('fB', 'active')] },
      conflicts: [],
    })
  })

  test('one field changed to different values on both sides keeps ours, as a conflict', () => {
    const out = mergeFieldValues(
      { values: [v('fA', 'north')] },
      { values: [v('fA', 'south')] },
      { values: [v('fA', 'east')] },
    )
    expect(out).toEqual({
      value: { values: [v('fA', 'south')] },
      conflicts: ['fA'],
    })
    let s = reduce(initialState(withFields([v('fA', 'north')]), counters), {
      type: 'edit',
      slice: 'fields',
      value: { values: [v('fA', 'south')] },
    })
    s = reduce(s, {
      type: 'server',
      slices: withFields([v('fA', 'east')]),
      counters: { ...counters, fields: 1 },
    })
    expect(s.conflicts).toEqual(['fields.fA'])
  })

  test('both sides choosing the same option is no change and no conflict', () => {
    let s = reduce(initialState(withFields([]), counters), {
      type: 'edit',
      slice: 'fields',
      value: { values: [v('fA', 'south')] },
    })
    s = reduce(s, {
      type: 'server',
      slices: withFields([v('fA', 'south')]),
      counters: { ...counters, fields: 1 },
    })
    expect(s.conflicts).toEqual([])
    expect(s.dirty.fields).toBe(false)
  })

  test('a saved value is clean; a refusal waits for the next edit', () => {
    let s = reduce(initialState(withFields([]), counters), {
      type: 'edit',
      slice: 'fields',
      value: { values: [v('fA', 'gone')] },
    })
    s = reduce(s, { type: 'commit' })
    s = reduce(s, { type: 'saving' })
    s = reduce(s, {
      type: 'saved',
      submitted: submission(s),
      result: {
        saved: [],
        problems: {
          fields: [{ field: 'fields', message: 'gone is archived', key: 'fA' }],
        },
        stale: {},
        counters: zeros,
      },
      at: 1,
    })
    expect(s.problems.fields).toHaveLength(1)
    expect(s.needsSave).toBe(false)
    expect(unsavedWork(s)).toBe('unsaved')
    s = reduce(s, {
      type: 'edit',
      slice: 'fields',
      value: { values: [v('fA', 'north')] },
    })
    s = reduce(s, { type: 'commit' })
    s = reduce(s, { type: 'saving' })
    s = reduce(s, {
      type: 'saved',
      submitted: submission(s),
      result: {
        saved: ['fields'],
        problems: {},
        stale: {},
        counters: { ...zeros, fields: 1 },
      },
      at: 2,
    })
    expect(s.problems.fields).toBeUndefined()
    expect(s.dirty.fields).toBe(false)
    expect(s.counters.fields).toBe(1)
    expect(unsavedWork(s)).toBe('clean')
  })
})

describe('newKey', () => {
  test('32 lower-case hex characters, never the same twice', () => {
    const keys = Array.from({ length: 100 }, newKey)
    for (const k of keys) expect(k).toMatch(/^[0-9a-f]{32}$/)
    expect(new Set(keys).size).toBe(100)
  })
})
