import { ConvexError } from 'convex/values'
import { describe, expect, test } from 'vitest'
import type { Id } from '../../convex/_generated/dataModel'
import {
  childNoun,
  dateRange,
  deleteBlocked,
  deleteCount,
  failureMessage,
  openDraft,
  payload,
  rebase,
  shownParts,
} from './source-codes'
import type { Part } from './source-codes'

const id = (s: string) => s as Id<'sourceCodes'>

function part(over: Partial<Part> & Pick<Part, '_id' | 'level'>): Part {
  return {
    name: over._id,
    code: over._id,
    isActive: true,
    visible: true,
    used: false,
    saveVersion: 0,
    ...over,
  } as Part
}

// Street (archived) → Wesser → 001; Online → Web → 001 (used).
const TREE = [
  part({
    _id: id('street'),
    level: 'category',
    isActive: false,
    visible: false,
  }),
  part({
    _id: id('wesser'),
    level: 'detail',
    parentId: id('street'),
    visible: false,
  }),
  part({
    _id: id('w1'),
    level: 'version',
    parentId: id('wesser'),
    visible: false,
  }),
  part({ _id: id('online'), level: 'category', used: true }),
  part({ _id: id('web'), level: 'detail', parentId: id('online'), used: true }),
  part({ _id: id('o1'), level: 'version', parentId: id('web'), used: true }),
]

test('a category takes details, a detail versions, a version nothing', () => {
  expect(childNoun('category')).toBe('detail')
  expect(childNoun('detail')).toBe('version')
  expect(childNoun('version')).toBeNull()
})

test('without "show archived", archived parts and all under them are hidden', () => {
  expect(shownParts(TREE, false).map((p) => p._id)).toEqual([
    'online',
    'web',
    'o1',
  ])
  expect(shownParts(TREE, true)).toHaveLength(6)
})

test('a used part can only be archived; an unused one deletes with its subtree', () => {
  expect(deleteBlocked(TREE[3])).toMatch(/only be archived/)
  expect(deleteBlocked(TREE[0])).toBeNull()
  expect(deleteCount(TREE, id('street'))).toBe(3)
  expect(deleteCount(TREE, id('wesser'))).toBe(2)
  expect(deleteCount(TREE, id('w1'))).toBe(1)
})

test('blank form fields become absent in the payload', () => {
  expect(
    payload(
      { name: 'Wesser', description: '', startDate: '2026-03-01', endDate: '' },
      true,
    ),
  ).toEqual({
    name: 'Wesser',
    description: undefined,
    startDate: '2026-03-01',
    endDate: undefined,
    isActive: true,
  })
})

test('dates read as a range', () => {
  expect(dateRange({ startDate: '2026-03-01', endDate: '2026-05-31' })).toBe(
    '1 Mar 2026 to 31 May 2026',
  )
  expect(dateRange({ startDate: '2026-03-01' })).toBe('from 1 Mar 2026')
  expect(dateRange({ endDate: '2026-05-31' })).toBe('until 31 May 2026')
  expect(dateRange({})).toBeNull()
})

describe('an open editor follows saves made elsewhere', () => {
  const live = part({
    _id: id('wesser'),
    level: 'detail',
    name: 'Wesser',
    description: 'Agency',
    saveVersion: 3,
  })

  test('its own counter, or an older one, changes nothing', () => {
    const d = openDraft(live)
    expect(rebase(d, live)).toBe(d)
  })

  test('fields changed only there take theirs; ours keep ours; the counter moves', () => {
    const d = {
      ...openDraft(live),
      fields: { ...openDraft(live).fields, name: 'Wessex' },
    }
    const next = rebase(d, {
      ...live,
      description: 'Bristol agency',
      saveVersion: 4,
    })
    expect(next.fields).toMatchObject({
      name: 'Wessex',
      description: 'Bristol agency',
    })
    expect(next.baseVersion).toBe(4)
    expect(next.conflicts).toEqual([])
  })

  test('a field changed on both sides keeps ours and is flagged', () => {
    const d = {
      ...openDraft(live),
      fields: { ...openDraft(live).fields, name: 'Wessex' },
    }
    const next = rebase(d, { ...live, name: 'Wesser2', saveVersion: 4 })
    expect(next.fields.name).toBe('Wessex')
    expect(next.base.name).toBe('Wesser2')
    expect(next.conflicts).toEqual(['name'])
  })

  test('the same change on both sides is no conflict (our own save echoing)', () => {
    const d = {
      ...openDraft(live),
      fields: { ...openDraft(live).fields, name: 'Wessex' },
    }
    expect(
      rebase(d, { ...live, name: 'Wessex', saveVersion: 4 }).conflicts,
    ).toEqual([])
  })
})

test('failures read as one line', () => {
  expect(
    failureMessage(
      new ConvexError({
        kind: 'invalid',
        problems: [{ message: 'A' }, { message: 'B' }],
      }),
    ),
  ).toBe('A; B')
  expect(
    failureMessage(new ConvexError({ kind: 'stale', current: 2 })),
  ).toMatch(/merged in/)
  expect(
    failureMessage(
      new ConvexError({
        kind: 'rejected',
        reason: 'used',
        message: 'Only archive',
      }),
    ),
  ).toBe('Only archive')
  expect(failureMessage(new Error('boom'))).toBe('Could not save')
})
