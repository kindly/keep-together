import type { Saved, SavedPage } from './persist'
import type { SittingScan } from '#/lib/data/rust-types/SittingScan'

/**
 * A reload of a link with pages still kept on the phone (persist.ts): what
 * to send again, what already landed, and which scan "Add page" adds to.
 * The sitting's own list of scans says which scans the server holds.
 */

export interface Recovered {
  /** Scans the server holds: a kept page of one is its next page. */
  created: Array<string>
  /** Pages to send again, in the order they were taken. */
  resend: Array<SavedPage>
  /**
   * Kept pages already on the server: a scan exists only once its first
   * page landed, so a kept first page of a scan the server holds is there
   * (only its removal from the phone was lost). Sending it again as the
   * first page would answer the scan; as a next page it would be a copy.
   */
  landed: Array<string>
  /** The scan still open on the phone, with its pages already sent. */
  current: { id: string; earlier: number } | null
}

export function recover(saved: Saved, scans: Array<SittingScan>): Recovered {
  const held = new Map(scans.map((s) => [s.id, s]))
  const resend: Array<SavedPage> = []
  const landed: Array<string> = []
  for (const page of [...saved.pages].sort((a, b) => a.seq - b.seq)) {
    if (page.opens && held.has(page.scanId)) landed.push(page.pageId)
    else resend.push(page)
  }
  let current: Recovered['current'] = null
  const id = saved.current
  if (id) {
    const scan = held.get(id)
    if (scan?.open) current = { id, earlier: scan.pages }
    // Not on the server yet: its first page is among those to send.
    else if (!scan && resend.some((p) => p.scanId === id)) {
      current = { id, earlier: 0 }
    }
  }
  return { created: [...held.keys()], resend, landed, current }
}
