import { backoffMs, newId } from './api'
import type { Outcome, Refusal, RetryWhy } from './api'
import type { ScanUploaded } from '#/lib/data/rust-types/ScanUploaded'

/**
 * The phone's outbox: pages go one at a time, in the order they were
 * taken, so a scan's first page always reaches the server before its
 * next. A page that can't get through (no signal, the server busy) waits
 * and is sent again with the same ids, which the server answers as the
 * same scan and page, until it lands or the link ends. Each page is
 * also kept on the phone (`keep`, persist.ts) until it lands, so a reload
 * can send it again (`restore`).
 */

export type PageState = 'waiting' | 'sending' | 'sent' | 'failed'

export interface OutboxPage {
  scanId: string
  pageId: string
  blob: Blob
  state: PageState
  /** It opens its scan: no earlier page of the scan was taken. */
  opens: boolean
  /** Why a failed page was refused. */
  problem?: Refusal
  /** An attempt went unanswered: it may have landed anyway. */
  retried?: boolean
  /**
   * Moved to a new scan after its own was taken on the laptop, though an
   * unanswered attempt may have reached that scan first: this page may
   * be on the laptop twice.
   */
  maybeTwice?: boolean
}

/** Where the outbox keeps its pages until they land. */
export interface OutboxKeep {
  put: (page: OutboxPage) => void
  drop: (page: OutboxPage) => void
}

export interface OutboxDeps {
  send: (page: {
    scanId: string
    pageId: string
    first: boolean
    blob: Blob
  }) => Promise<Outcome<ScanUploaded>>
  /** Resolves after `ms`, or sooner on `wake()`. */
  sleep: (ms: number, wake: Promise<void>) => Promise<void>
  /** Something a page shows changed. */
  changed: () => void
  /** The link ended or belongs to another phone: nothing more will go. */
  ended: (kind: 'gone' | 'forbidden') => void
  keep?: OutboxKeep
}

/** Refusals that stop every page after them too, not just this one. */
const STOPS_ALL: ReadonlyArray<Refusal> = [
  'upload_limit',
  'files_full',
  'storage_full',
]

export class Outbox {
  readonly pages: Array<OutboxPage> = []
  /** Scans the server holds: their next page adds to them. */
  readonly created = new Set<string>()
  /** Set while a page waits to be sent again. */
  retrying: { why: RetryWhy; attempt: number } | null = null
  uploadsLeft: number | null = null
  /** Scan ids replaced because the laptop took the scan meanwhile. */
  readonly moved = new Map<string, string>()

  private running = false
  private stopped = false
  private waking: () => void = () => {}

  constructor(private deps: OutboxDeps) {}

  add(scanId: string, blob: Blob): OutboxPage {
    const page: OutboxPage = {
      scanId,
      pageId: newId(),
      blob,
      state: 'waiting',
      opens: !this.pages.some((p) => p.scanId === scanId),
    }
    this.pages.push(page)
    this.deps.keep?.put(page)
    this.deps.changed()
    void this.run()
    return page
  }

  /**
   * Pages kept from before a reload, with their own ids, and the scans
   * the server already holds.
   */
  restore(
    pages: Array<Pick<OutboxPage, 'scanId' | 'pageId' | 'blob' | 'opens'>>,
    created: Iterable<string>,
  ): Array<OutboxPage> {
    for (const id of created) this.created.add(id)
    const restored = pages.map((p): OutboxPage => ({ ...p, state: 'waiting' }))
    this.pages.push(...restored)
    this.deps.changed()
    void this.run()
    return restored
  }

  /** Retry now (back online, or the user asked). */
  wake(): void {
    this.waking()
  }

  /** Nothing waiting or being sent, or nothing more will be. */
  get idle(): boolean {
    return (
      this.stopped ||
      !this.pages.some((p) => p.state === 'waiting' || p.state === 'sending')
    )
  }

  /** The scan id pages taken as `scanId` now go under. */
  current(scanId: string): string {
    let id = scanId
    while (this.moved.has(id)) id = this.moved.get(id)!
    return id
  }

  private async run(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      for (;;) {
        const page = this.pages.find((p) => p.state === 'waiting')
        if (!page || this.stopped) return
        page.state = 'sending'
        this.deps.changed()
        const first = !this.created.has(page.scanId)
        if (first && !page.opens) {
          // Its scan's earlier pages were refused: this one opens it now.
          page.opens = true
          this.deps.keep?.put(page)
        }
        const out = await this.deps.send({
          scanId: page.scanId,
          pageId: page.pageId,
          first,
          blob: page.blob,
        })
        if (this.settle(page, out, first)) continue
        const attempt = this.retrying?.attempt ?? 0
        this.deps.changed()
        await this.deps.sleep(
          backoffMs(attempt),
          new Promise((resolve) => (this.waking = resolve)),
        )
        if (this.retrying) this.retrying.attempt = attempt + 1
      }
    } finally {
      this.running = false
      this.deps.changed()
    }
  }

  /** Applies `out` to `page`; false when it should be sent again. */
  private settle(
    page: OutboxPage,
    out: Outcome<ScanUploaded>,
    first: boolean,
  ): boolean {
    if (out.kind === 'not_found' && first) {
      // A new scan has no scan to be missing: nothing to move it to.
      out = { kind: 'refused', reason: 'other' }
    }
    switch (out.kind) {
      case 'ok':
        page.state = 'sent'
        this.deps.keep?.drop(page)
        this.created.add(out.value.scanId)
        this.uploadsLeft = out.value.uploadsLeft
        this.retrying = null
        return true
      case 'retry':
        page.state = 'waiting'
        page.retried = true
        this.retrying ??= { why: out.why, attempt: 0 }
        this.retrying.why = out.why
        return false
      case 'not_found': {
        // The scan stopped being a draft (accepted, merged or discarded
        // on the laptop) before this page reached it: the rest of its
        // pages start a scan of their own.
        // A resend of a page the scan already holds is answered `ok`,
        // whatever the scan's state, so the old scan doesn't hold this
        // one now; but an earlier attempt may have landed there before
        // the laptop merged it away or deleted its images, so it may be
        // in two scans.
        if (page.retried) page.maybeTwice = true
        const [gone, fresh] = [page.scanId, newId()]
        this.moved.set(gone, fresh)
        let opens = true
        for (const p of this.pages) {
          if (p.scanId === gone && p.state !== 'sent') {
            p.scanId = fresh
            p.opens = opens
            opens = false
            if (p.state === 'sending') p.state = 'waiting'
            this.deps.keep?.put(p)
          }
        }
        return true
      }
      case 'gone':
      case 'forbidden':
        page.state = 'waiting'
        this.stopped = true
        this.deps.ended(out.kind)
        return true
      case 'refused': {
        page.state = 'failed'
        page.problem = out.reason
        this.deps.keep?.drop(page)
        this.retrying = null
        if (STOPS_ALL.includes(out.reason)) {
          for (const p of this.pages) {
            if (p.state === 'waiting') {
              p.state = 'failed'
              p.problem = out.reason
              this.deps.keep?.drop(p)
            }
          }
        }
        return true
      }
    }
  }
}
