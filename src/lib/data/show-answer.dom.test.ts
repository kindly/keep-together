// @vitest-environment happy-dom
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import type { QueryKey } from '@tanstack/react-query'
import { afterEach, expect, test, vi } from 'vitest'
import { deliver, resetTenant, showAnswer } from './events'
import type { OrgEvent } from './rust-types/OrgEvent'
import type { Written } from './rust/client'

// `showAnswer` against the event stream's edge cases (review of
// one-trip-saves, 2026-11-02): the answer never replaces anything newer
// than itself, freshness is per tenant, a reset forgets it, and events
// that waited on a write are applied whatever became of the write.
// one-trip.dom.test.tsx covers each flow's hooks; this, the orderings.

afterEach(() => vi.useRealTimers())

let tenants = 0

/**
 * One tenant's notes list, observed (as a mounted page would), whose
 * server state is `server` and whose fetches answer when `answerFetch`
 * says so: what each fetch read is what it was when it started.
 */
function world() {
  const slug = `answer-${++tenants}`
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const key: QueryKey = ['t', slug, 'notes', 'c1', 'live']
  const state = { server: 'v0', fetches: 0 }
  const fetches: Array<() => void> = []
  const observer = new QueryObserver(qc, {
    queryKey: key,
    queryFn: () => {
      state.fetches++
      const read = state.server
      return new Promise<string>((r) => fetches.push(() => r(read)))
    },
  })
  const stop = observer.subscribe(() => {})
  /** Answer every fetch in flight. */
  const answerFetches = () => {
    for (const f of fetches.splice(0)) f()
  }
  /** A write whose answer the test gives (or refuses) when it likes. */
  function write() {
    let reply!: { ok: (w: Written<string>) => void; fail: (e: Error) => void }
    const done = showAnswer(
      qc,
      slug,
      () => new Promise<Written<string>>((ok, fail) => (reply = { ok, fail })),
      (answer) => [[key, answer]],
    )
    return { done, settle: () => reply }
  }
  const event = (seq: number): OrgEvent => ({
    seq,
    entity: 'contact_notes',
    id: 'n1',
    contract: 'contacts.note',
    counter: seq,
  })
  return {
    slug,
    qc,
    key,
    state,
    fetches,
    answerFetches,
    write,
    event,
    shown: () => qc.getQueryData<string>(key),
    stop,
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0))
async function settle() {
  for (let i = 0; i < 10; i++) await tick()
}

async function loaded() {
  const w = world()
  await settle()
  w.answerFetches()
  await settle()
  expect(w.shown()).toBe('v0')
  w.state.fetches = 0
  return w
}

test('M1: a later change applied after the hold lapsed is not lost to the answer', async () => {
  vi.useFakeTimers()
  const w = world()
  await vi.advanceTimersByTimeAsync(0)
  w.answerFetches()
  await vi.advanceTimersByTimeAsync(0)
  const save = w.write()
  // Our commit is seq 10 ("mine"); someone else's, seq 11, follows.
  w.state.server = 'mine+theirs'
  await vi.advanceTimersByTimeAsync(10_001) // the hold lapses
  deliver(w.qc, w.slug, w.event(11))
  await vi.advanceTimersByTimeAsync(0)
  expect(w.fetches).toHaveLength(1) // their refetch, in flight
  save.settle().ok({ answer: 'mine', seq: 10 })
  await save.done
  deliver(w.qc, w.slug, w.event(10)) // our echo, late
  await vi.advanceTimersByTimeAsync(0)
  w.answerFetches()
  await vi.advanceTimersByTimeAsync(100)
  w.answerFetches()
  await vi.advanceTimersByTimeAsync(100)
  expect(w.shown()).toBe('mine+theirs')
  w.stop()
})

test('M1: a reset during the write: the answer is not installed over its refetch', async () => {
  const w = await loaded()
  const save = w.write()
  w.state.server = 'mine+missed'
  resetTenant(w.qc, w.slug) // never held: the commits it stands for never replay
  await settle()
  save.settle().ok({ answer: 'mine', seq: 10 })
  await save.done
  await settle()
  w.answerFetches()
  await settle()
  w.answerFetches()
  await settle()
  expect(w.shown()).toBe('mine+missed')
  w.stop()
})

test('M2: one tenant’s answer marks the groups fresh for its own events only', async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  let fetches = 0
  const observer = new QueryObserver(qc, {
    queryKey: ['groups'],
    queryFn: () => Promise.resolve([++fetches]),
  })
  const stop = observer.subscribe(() => {})
  await settle()
  const a = `answer-${++tenants}`
  const b = `answer-${++tenants}`
  await showAnswer(
    qc,
    a,
    () => Promise.resolve({ answer: 1, seq: 5000 }),
    () => [[['groups'], ['a']]],
  )
  const before = fetches
  const prefs = (seq: number): OrgEvent => ({
    seq,
    entity: 'tenant_preferences',
    id: 'p',
    contract: 'tenantPreferences.fields',
    counter: 1,
  })
  // A's own echo: skipped.
  deliver(qc, a, prefs(5000))
  await settle()
  expect(fetches - before).toBe(0)
  // B's switch, lower seq in its own file: refetched.
  deliver(qc, b, prefs(300))
  await settle()
  expect(fetches - before).toBe(1)
  stop()
})

test('L1: a reset forgets the marks: a restored file’s low seqs refetch', async () => {
  const w = await loaded()
  const save = w.write()
  save.settle().ok({ answer: 'mine', seq: 500 })
  await save.done
  deliver(w.qc, w.slug, w.event(400))
  await settle()
  expect(w.state.fetches).toBe(0) // before the restore: covered
  resetTenant(w.qc, w.slug)
  await settle()
  w.answerFetches()
  await settle()
  const after = w.state.fetches
  deliver(w.qc, w.slug, w.event(12)) // the restored file's numbering
  await settle()
  expect(w.state.fetches).toBe(after + 1)
  w.stop()
})

test('someone else’s event during the write waits, then refetches after the answer', async () => {
  const w = await loaded()
  const save = w.write()
  deliver(w.qc, w.slug, w.event(10)) // our echo
  w.state.server = 'mine+theirs'
  deliver(w.qc, w.slug, w.event(11)) // theirs
  await settle()
  expect(w.state.fetches).toBe(0) // held
  save.settle().ok({ answer: 'mine', seq: 10 })
  await save.done
  await settle()
  expect(w.shown()).toBe('mine')
  expect(w.state.fetches).toBe(1) // theirs, once
  w.answerFetches()
  await settle()
  expect(w.shown()).toBe('mine+theirs')
  w.stop()
})

test('a refused write releases the events it held, and they apply', async () => {
  const w = await loaded()
  const save = w.write()
  w.state.server = 'theirs'
  deliver(w.qc, w.slug, w.event(11))
  await settle()
  expect(w.state.fetches).toBe(0)
  save.settle().fail(new Error('409 stale'))
  await expect(save.done).rejects.toThrow('409 stale')
  await settle()
  expect(w.state.fetches).toBe(1)
  w.answerFetches()
  await settle()
  expect(w.shown()).toBe('theirs')
  w.stop()
})

test('a write lost after its commit: nothing installed, its echo refetches', async () => {
  const w = await loaded()
  const save = w.write()
  w.state.server = 'mine'
  deliver(w.qc, w.slug, w.event(10)) // committed; the answer never comes
  save.settle().fail(new Error('network'))
  await expect(save.done).rejects.toThrow('network')
  await settle()
  expect(w.state.fetches).toBe(1)
  w.answerFetches()
  await settle()
  expect(w.shown()).toBe('mine')
  w.stop()
})

test('a fetch that landed during the write is fetched again, not overwritten', async () => {
  const w = await loaded()
  const save = w.write()
  // Something read the list meanwhile (a remount), after a later commit.
  w.state.server = 'later'
  void w.qc.refetchQueries({ queryKey: w.key })
  await settle()
  await new Promise((r) => setTimeout(r, 2))
  w.answerFetches()
  await settle()
  expect(w.shown()).toBe('later')
  save.settle().ok({ answer: 'mine', seq: 10 })
  await save.done
  await settle()
  expect(w.shown()).toBe('later') // never the older answer
  w.answerFetches()
  await settle()
  expect(w.shown()).toBe('later')
  w.stop()
})

test('two writes answered out of order: the older answer is not installed', async () => {
  const w = await loaded()
  const first = w.write()
  await new Promise((r) => setTimeout(r, 2))
  const second = w.write()
  w.state.server = 'second'
  second.settle().ok({ answer: 'second', seq: 11 })
  await second.done
  expect(w.shown()).toBe('second')
  await new Promise((r) => setTimeout(r, 2))
  first.settle().ok({ answer: 'first', seq: 10 })
  await first.done
  await settle()
  expect(w.shown()).toBe('second')
  w.answerFetches()
  await settle()
  expect(w.shown()).toBe('second')
  w.stop()
})

test('L2: an answer naming no seq, with events applied meanwhile, is fetched again', async () => {
  vi.useFakeTimers()
  const w = world()
  await vi.advanceTimersByTimeAsync(0)
  w.answerFetches()
  await vi.advanceTimersByTimeAsync(0)
  const save = w.write()
  w.state.server = 'mine+theirs'
  await vi.advanceTimersByTimeAsync(10_001)
  deliver(w.qc, w.slug, w.event(11))
  await vi.advanceTimersByTimeAsync(0)
  expect(w.fetches).toHaveLength(1) // their refetch, still in flight
  save.settle().ok({ answer: 'mine', seq: null })
  await save.done
  await vi.advanceTimersByTimeAsync(0)
  w.answerFetches()
  await vi.advanceTimersByTimeAsync(0)
  expect(w.shown()).toBe('mine+theirs')
  w.stop()
})
