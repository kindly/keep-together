import { describe, expect, test } from 'vitest'
import type { Id } from '../../convex/_generated/dataModel'
import type { Slices } from './contact-form-state'
import {
  clean,
  initialState,
  reduce,
  mergeTags,
  rekey,
  submission,
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
  tags: { tags: [{ key: 't1', tagId: 'tagMember' as Id<'tags'> }] },
}
const counters = { details: 0, methods: 0, addresses: 0, tags: 0 }

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
        counters: { details: 1, methods: 0, addresses: 0, archive: 0, tags: 0 },
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
        counters: { details: 1, methods: 0, addresses: 0, archive: 0, tags: 0 },
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
        counters: { details: 0, methods: 1, addresses: 0, archive: 0, tags: 0 },
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
      counters: { details, methods: 0, addresses: 0, archive: 0, tags: 0 },
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
        counters: { details: 0, methods: 0, addresses: 0, archive: 0, tags: 0 },
      },
    })
    expect(s.problems.details?.[0].field).toBe('lastName')
    expect(s.dirty.details).toBe(true)
    expect(s.needsSave).toBe(false)
  })

  describe('the tags slice', () => {
    const tag = (key: string, id: string) => ({
      key,
      tagId: id as Id<'tags'>,
    })
    const member = tag('t1', 'tagMember')

    test('a tag added here and one added elsewhere both survive', () => {
      let s = reduce(initialState(slices, counters), {
        type: 'edit',
        slice: 'tags',
        value: { tags: [member, tag('t2', 'tagVolunteer')] },
      })
      s = reduce(s, {
        type: 'server',
        slices: { ...slices, tags: { tags: [member, tag('t9', 'tagDonor')] } },
        counters: { ...counters, tags: 1 },
      })
      expect(s.local.tags.tags.map((t) => t.tagId)).toEqual([
        'tagMember',
        'tagDonor',
        'tagVolunteer',
      ])
      expect(s.conflicts).toEqual([])
      expect(s.dirty.tags).toBe(true)
      expect(s.needsSave).toBe(true)
    })

    test('a tag removed here stays removed when another tag arrives', () => {
      const s = mergeTags(
        { tags: [member] },
        { tags: [] },
        { tags: [member, tag('t9', 'tagDonor')] },
      )
      expect(s.tags).toEqual([tag('t9', 'tagDonor')])
    })

    test('both sides adding the same tag keeps the remote row, not dirty', () => {
      let s = reduce(initialState(slices, counters), {
        type: 'edit',
        slice: 'tags',
        value: { tags: [member, tag('mine', 'tagDonor')] },
      })
      s = reduce(s, {
        type: 'server',
        slices: {
          ...slices,
          tags: { tags: [member, tag('theirs', 'tagDonor')] },
        },
        counters: { ...counters, tags: 1 },
      })
      expect(s.local.tags.tags).toEqual([member, tag('theirs', 'tagDonor')])
      expect(s.dirty.tags).toBe(false)
    })

    test('a stale tags save is noticed and cleared once the retry saves', () => {
      let s = reduce(initialState(slices, counters), {
        type: 'edit',
        slice: 'tags',
        value: { tags: [] },
      })
      const first = submission(s)
      expect(Object.keys(first)).toEqual(['tags'])
      s = reduce(s, { type: 'saving' })
      const theirs = { tags: [member, tag('t9', 'tagDonor')] }
      s = reduce(s, {
        type: 'server',
        slices: { ...slices, tags: theirs },
        counters: { ...counters, tags: 1 },
      })
      s = reduce(s, {
        type: 'saved',
        submitted: first,
        at: 1,
        result: {
          saved: [],
          problems: {},
          stale: { tags: 1 },
          counters: { details: 0, methods: 0, addresses: 0, archive: 0, tags: 1 },
        },
      })
      expect(s.stale).toEqual({ tags: 1 })
      const retry = submission(s)
      expect(retry.tags).toEqual({ tags: [tag('t9', 'tagDonor')] })
      s = reduce(s, { type: 'saving' })
      s = reduce(s, {
        type: 'saved',
        submitted: retry,
        at: 2,
        result: {
          saved: ['tags'],
          problems: {},
          stale: {},
          counters: { details: 0, methods: 0, addresses: 0, archive: 0, tags: 2 },
        },
      })
      expect(s.stale).toEqual({})
      expect(s.dirty.tags).toBe(false)
    })
  })
})
