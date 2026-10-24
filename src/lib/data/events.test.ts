import { QueryClient } from '@tanstack/react-query'
import type { QueryKey } from '@tanstack/react-query'
import { describe, expect, test } from 'vitest'
import { applyEvent } from './events'
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
  test('an email saved on any contact refreshes every email context, other slices none', () => {
    const qc = cache()
    applyEvent(qc, SLUG, event('contacts', 'contacts.details', 'c3'))
    expect(stale(qc).filter((k) => k.includes('emailContext'))).toEqual([])
    applyEvent(qc, SLUG, event('contacts', 'contacts.methods', 'c3'))
    expect(stale(qc).filter((k) => k.includes('emailContext'))).toHaveLength(2)
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
    applyEvent(qc, SLUG, event('relationship_types', 'contacts.relationshipType'))
    expect(stale(qc)).toEqual([])
  })
})
