/**
 * One place that knows whether a page holds work not yet on the server.
 * Each editor on the page (the contact form, every note editor, the note
 * composer) reports its own state; the page's guard reads the worst of
 * them when the user tries to leave.
 */
import {
  createContext,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

/**
 * `busy`: a save is in flight or already queued, and will settle by
 * itself. `unsaved`: only the user can resolve it (an edit not yet
 * submitted, refused as invalid or stale, or failed).
 */
export type Unsaved = 'clean' | 'busy' | 'unsaved'

const RANK: Record<Unsaved, number> = { clean: 0, busy: 1, unsaved: 2 }

export function worst(states: Iterable<Unsaved>): Unsaved {
  let out: Unsaved = 'clean'
  for (const s of states) if (RANK[s] > RANK[out]) out = s
  return out
}

type Entry = { state: Unsaved; flush?: () => void }

export class UnsavedWork {
  private entries = new Map<string, Entry>()
  private listeners = new Set<() => void>()

  set(key: string, entry: Entry) {
    this.entries.set(key, entry)
    this.changed()
  }

  delete(key: string) {
    this.entries.delete(key)
    this.changed()
  }

  state(): Unsaved {
    return worst([...this.entries.values()].map((e) => e.state))
  }

  /** Start every queued save now rather than after its autosave pause. */
  flush() {
    for (const e of this.entries.values()) e.flush?.()
  }

  /** Resolves once nothing is `busy`, or after `timeoutMs`. */
  settled(timeoutMs: number): Promise<Unsaved> {
    return new Promise((resolve) => {
      const check = () => {
        if (this.state() === 'busy') return
        done()
      }
      const done = () => {
        clearTimeout(timer)
        this.listeners.delete(check)
        resolve(this.state())
      }
      const timer = setTimeout(done, timeoutMs)
      this.listeners.add(check)
      check()
    })
  }

  private changed() {
    for (const l of [...this.listeners]) l()
  }
}

const Context = createContext<UnsavedWork | null>(null)

export function UnsavedWorkProvider({
  work,
  children,
}: {
  work: UnsavedWork
  children: React.ReactNode
}) {
  return <Context.Provider value={work}>{children}</Context.Provider>
}

/** A page-lifetime registry for the page's guard to read. */
export function useUnsavedWork(): UnsavedWork {
  const [work] = useState(() => new UnsavedWork())
  return work
}

/**
 * Report this editor's state to the page. A layout effect, so the state
 * is current before the browser handles the next event: a blur that
 * starts a save has registered it by the time the click on a link lands.
 */
export function useReportUnsaved(state: Unsaved, flush?: () => void) {
  const work = useContext(Context)
  const key = useId()
  const latestFlush = useRef(flush)
  latestFlush.current = flush
  useLayoutEffect(() => {
    if (!work) return
    work.set(key, { state, flush: () => latestFlush.current?.() })
  }, [work, key, state])
  useLayoutEffect(() => {
    if (!work) return
    return () => work.delete(key)
  }, [work, key])
}
