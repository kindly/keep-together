import { QueryClient, QueryObserver } from '@tanstack/react-query'
import type { QueryKey } from '@tanstack/react-query'
import { describe, expect, test } from 'vitest'
import { applyEvent, ownWrite } from './events'
import type { OrgEvent } from './rust-types/OrgEvent'
import { keys } from './rust/keys'

const SLUG = 'alpha'

/** A cache holding A1's reads for two contacts, all fresh. */
function cache() {
  const qc = new QueryClient()
  const held: Array<QueryKey> = [
    keys.identifierTypes(SLUG),
    [...keys.emailContext(SLUG, 'c1'), 'a@x.org'],
    [...keys.emailContext(SLUG, 'c2'), 'a@x.org'],
    keys.notes(SLUG, 'c1', false),
    keys.notes(SLUG, 'c2', true),
    keys.fields(SLUG),
  ]
  for (const k of held) qc.setQueryData(k, {})
  return qc
}

const stale = (qc: QueryClient) =>
  qc
    .getQueryCache()
    .getAll()
    .filter((q) => q.state.isInvalidated)
    .map((q) => JSON.stringify(q.queryKey))
    .sort()

const event = (entity: string, contract: string, id = 'x'): OrgEvent => ({
  seq: 1,
  entity,
  id,
  contract,
  counter: 1,
})

describe('A1 events', () => {
  test('an email, a name or an archive saved on any contact refreshes every email context; other slices none', async () => {
    const qc = cache()
    applyEvent(qc, SLUG, event('contacts', 'contacts.fields', 'c3'))
    applyEvent(qc, SLUG, event('contacts', 'contacts.identifiers', 'c3'))
    expect(stale(qc).filter((k) => k.includes('emailContext'))).toEqual([])
    for (const contract of ['methods', 'details', 'archive']) {
      const fresh = cache()
      applyEvent(fresh, SLUG, event('contacts', `contacts.${contract}`, 'c3'))
      expect(
        stale(fresh).filter((k) => k.includes('emailContext')),
      ).toHaveLength(2)
      // Invalidations coalesce per key while one runs: let it finish.
      await new Promise((done) => setTimeout(done))
    }
  })

  test('a hold or release refreshes every email context, nothing else', () => {
    const qc = cache()
    applyEvent(qc, SLUG, event('email_suppressions', 'comms.suppression'))
    expect(stale(qc)).toEqual([
      JSON.stringify([...keys.emailContext(SLUG, 'c1'), 'a@x.org']),
      JSON.stringify([...keys.emailContext(SLUG, 'c2'), 'a@x.org']),
    ])
  })

  test('a note event refreshes the notes lists; a type, the types', () => {
    const qc = cache()
    applyEvent(qc, SLUG, event('contact_notes', 'contacts.noteFlags'))
    expect(stale(qc)).toEqual(
      [
        JSON.stringify(keys.notes(SLUG, 'c1', false)),
        JSON.stringify(keys.notes(SLUG, 'c2', true)),
      ].sort(),
    )
    const qc2 = cache()
    applyEvent(qc2, SLUG, event('identifier_types', 'contacts.identifierType'))
    expect(stale(qc2)).toEqual([JSON.stringify(keys.identifierTypes(SLUG))])
  })

  test('relationships invalidate nothing (no page shows them)', () => {
    const qc = cache()
    applyEvent(qc, SLUG, event('relationships', 'contacts.relationship'))
    applyEvent(
      qc,
      SLUG,
      event('relationship_types', 'contacts.relationshipType'),
    )
    expect(stale(qc)).toEqual([])
  })
})

// The contact-hold QC flake: a query with no data yet (a contact's email
// context for a just-saved address) was fetching when the hold's event
// came. TanStack Query's refetch joins such a fetch rather than restarting
// it, so the answer read before the hold was the last word. The event now
// cancels the fetch in flight, and the refetch reads after the change.
test('an event refetches a query whose first fetch began before the change', async () => {
  const qc = new QueryClient()
  const key = [...keys.emailContext(SLUG, 'c1'), 'a@x.org']
  let held = false
  const answers: Array<(v: { held: boolean }) => void> = []
  const observer = new QueryObserver(qc, {
    queryKey: key,
    queryFn: ({ signal }) =>
      new Promise<{ held: boolean }>((resolve, reject) => {
        const seen = held
        answers.push(() => resolve({ held: seen }))
        signal.addEventListener('abort', () => reject(new Error('aborted')))
      }),
  })
  const unsubscribe = observer.subscribe(() => {})
  await Promise.resolve()
  expect(answers).toHaveLength(1) // the first fetch: in flight, no data

  held = true // the hold commits; its event arrives
  applyEvent(qc, SLUG, event('email_suppressions', 'comms.suppression'))
  await new Promise((done) => setTimeout(done))
  expect(answers).toHaveLength(2) // a new fetch, after the change
  answers[0]({ held: false }) // the stale answer lands late: ignored
  answers[1]({ held: true })
  await new Promise((done) => setTimeout(done))
  expect(qc.getQueryData(key)).toEqual({ held: true })
  unsubscribe()
})

// codex C1 #7: the echo of this tab's own save skips only what its hook
// already refetched; what shows the entity elsewhere still refetches.
describe('own writes', () => {
  const shown = (slug: string) => {
    const qc = new QueryClient()
    const held: Array<QueryKey> = [
      keys.gift(slug, 'g1'),
      keys.recentGifts(slug),
      [...keys.gifts(slug), 'donor', 'c1', '2026-10-24'],
      keys.list(slug),
      keys.sources(slug),
    ]
    for (const k of held) qc.setQueryData(k, {})
    return qc
  }
  const ours = (slug: string, e: OrgEvent) => {
    ownWrite(slug, e.id, e.contract, e.counter)
    return e
  }

  test('a donor renamed here: its gifts, recent gifts and donor info refetch, not the list', () => {
    const qc = shown('o1')
    applyEvent(
      qc,
      'o1',
      ours('o1', event('contacts', 'contacts.details', 'c1')),
    )
    expect(stale(qc)).toEqual(
      [
        JSON.stringify(keys.gift('o1', 'g1')),
        JSON.stringify(keys.recentGifts('o1')),
        JSON.stringify([...keys.gifts('o1'), 'donor', 'c1', '2026-10-24']),
      ].sort(),
    )
  })

  test('a source code saved here: gifts naming it refetch, the tree does not', () => {
    const qc = shown('o2')
    applyEvent(qc, 'o2', ours('o2', event('source_codes', 'sources.code')))
    const refetched = stale(qc)
    expect(refetched).toContain(JSON.stringify(keys.gift('o2', 'g1')))
    expect(refetched).not.toContain(JSON.stringify(keys.sources('o2')))
  })

  test('an acquisition set here: the code tree learns the code is used', () => {
    const qc = shown('o3')
    applyEvent(
      qc,
      'o3',
      ours('o3', event('contacts', 'contacts.acquisition', 'c1')),
    )
    expect(stale(qc)).toContain(JSON.stringify(keys.sources('o3')))
    expect(stale(qc)).not.toContain(JSON.stringify(keys.list('o3')))
  })
})

describe('declaration scans', () => {
  test('a scan event refetches every scan read (the stack, the inbox, a declaration’s) and nothing else', async () => {
    const qc = cache()
    for (const k of [
      keys.scanInbox(SLUG),
      keys.scanPairing(SLUG, 'p1'),
      keys.declarationScans(SLUG, 'd1'),
      keys.filesUsage(SLUG),
    ])
      qc.setQueryData(k, {})
    applyEvent(qc, SLUG, event('declaration_scans', 'giftaid.scan', 's1'))
    await Promise.resolve()
    expect(stale(qc)).toEqual(
      [
        keys.declarationScans(SLUG, 'd1'),
        keys.scanInbox(SLUG),
        keys.scanPairing(SLUG, 'p1'),
        keys.filesUsage(SLUG),
      ]
        .map((k) => JSON.stringify(k))
        .sort(),
    )
  })
})

describe('bank transfers 6b events', () => {
  // A transfer recorded by hand elsewhere changes a line's suggestions (the
  // hand-entered suggester), so a stale pre-tick can't make a second gift.
  test('a gift event refetches the lines, a line, and the transfers it could match', async () => {
    const qc = new QueryClient()
    const reads = [
      keys.bankLines(SLUG, 'acc1', 'unmatched'),
      keys.bankLine(SLUG, 'l1'),
      keys.bankHandTransfers(SLUG, 'l1', 14),
    ]
    for (const k of reads) qc.setQueryData(k, {})
    applyEvent(qc, SLUG, event('gifts', 'giving.gift'))
    expect(stale(qc)).toEqual(reads.map((k) => JSON.stringify(k)).sort())
    // Invalidations coalesce per key while one runs: let it finish.
    await new Promise((done) => setTimeout(done))
    const qc2 = new QueryClient()
    qc2.setQueryData(keys.bankLines(SLUG, 'acc1', 'unmatched'), {})
    applyEvent(qc2, SLUG, event('regular_gifts', 'giving.regularGift'))
    expect(stale(qc2)).toEqual([
      JSON.stringify(keys.bankLines(SLUG, 'acc1', 'unmatched')),
    ])
  })
})
