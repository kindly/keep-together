// A failed test's requests (qc/fixtures.ts, the `requests` attachment):
// which ones hung, failed or were slow, so a failure says whether the
// network or the server held something up, or the page never asked.
//
// A request still pending when its page was replaced (`page.goto` again,
// a full reload, a cross-document back) gets no `requestfinished` or
// `requestfailed` from Playwright: Chromium drops it with the document.
// Listed as "NO ANSWER", those read as a server or proxy that never
// answered. On keep-qc (2026-11-01/02) mobile-nav.spec.ts:101's
// `goto(/t/$slug)` then `goto(/t/$slug/contacts)` left the first page's
// lazy chunks (t._slug, gift-nav, …, all sent in the same millisecond)
// "unanswered after 6 s" in three failing runs, and they were chased as
// a stalled static file service; locally (route delay of 60 to 300 ms)
// the same chunks are left the same way in passing runs. So each request
// carries the document it was sent from: a page's document changes when
// one of its frame's navigation requests is answered, and a pending
// request from an earlier document was dropped, not unanswered.

/** One request, as the fixture saw it. */
export interface SeenRequest {
  method: string
  url: string
  /** Date.now() when it was sent. */
  sentAt: number
  /** Its frame's document number when it was sent. */
  doc: number
  /** Its frame's document number now (at the end of the test). */
  docNow: number
  /** ms to its answer, or why it failed; undefined: no outcome yet. */
  end?: number | string
}

/** Answers this slow or slower are listed too. */
export const SLOW_MS = 1000

/**
 * The lines of the attachment, empty when there's nothing to say. `now`
 * is Date.now() at the end of the test.
 */
export function requestLines(
  seen: ReadonlyArray<SeenRequest>,
  now: number,
): Array<string> {
  const lines = seen
    .filter((r) => {
      // The event stream stays open by design.
      if (new URL(r.url).pathname.endsWith('/events')) return false
      return typeof r.end !== 'number' || r.end >= SLOW_MS
    })
    .map((r) => {
      const took =
        typeof r.end === 'number'
          ? `${r.end} ms`
          : r.end !== undefined
            ? r.end
            : r.doc < r.docNow
              ? `DROPPED (its page was replaced) after ${now - r.sentAt} ms`
              : `NO ANSWER after ${now - r.sentAt} ms`
      // The outcome before the url: the terminal reporter cuts long lines.
      return `${new Date(r.sentAt).toISOString().slice(11, 23)} ${took} · ${r.method} ${r.url}`
    })
  if (!lines.length) return []
  return [
    'Requests unanswered at the end of the test, failed, or slower than 1 s. DROPPED: still pending when a navigation replaced its page, which Chromium drops without an answer; not a hang.',
    ...lines,
  ]
}
