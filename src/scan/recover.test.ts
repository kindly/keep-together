import { describe, expect, it } from 'vitest'
import { recover } from './recover'
import type { SavedPage } from './persist'

const A = 'a'.repeat(32)
const B = 'b'.repeat(32)

const page = (
  pageId: string,
  scanId: string,
  seq: number,
  opens = false,
): SavedPage => ({
  key: 'k',
  pageId,
  scanId,
  opens,
  seq,
  bytes: new ArrayBuffer(1),
  savedAt: 0,
})

describe('recover', () => {
  it('sends kept pages again in the order they were taken', () => {
    const r = recover(
      {
        pages: [
          page('p3', B, 3, true),
          page('p1', A, 1, true),
          page('p2', A, 2),
        ],
        current: B,
      },
      [],
    )
    expect(r.resend.map((p) => p.pageId)).toEqual(['p1', 'p2', 'p3'])
    expect(r.landed).toEqual([])
    expect(r.created).toEqual([])
  })

  it('a kept first page of a scan the server holds already landed', () => {
    // Only its removal from the phone was lost: sent again as a next
    // page, it would be a copy.
    const r = recover(
      { pages: [page('p1', A, 1, true), page('p2', A, 2)], current: A },
      [{ id: A, pageIds: ['s1'], open: true }],
    )
    expect(r.landed).toEqual(['p1'])
    expect(r.resend.map((p) => p.pageId)).toEqual(['p2'])
    expect(r.created).toEqual([A])
  })

  it('reopens the open scan, counting the pages already on the server', () => {
    const r = recover({ pages: [page('p3', A, 3)], current: A }, [
      { id: A, pageIds: ['s1', 'p2'], open: true },
    ])
    expect(r.current).toEqual({ id: A, earlier: 2 })
  })

  it('a kept next page the server holds landed: the answer was lost, not the page', () => {
    // scan-phone.spec.ts: the tab was thrown away while page 2's upload
    // landed. Sent again and counted as earlier too, it showed
    // "This scan: 3 pages" for 2.
    const r = recover({ pages: [page('p2', A, 2)], current: A }, [
      { id: A, pageIds: ['s1', 'p2'], open: true },
    ])
    expect(r.landed).toEqual(['p2'])
    expect(r.resend).toEqual([])
    expect(r.current).toEqual({ id: A, earlier: 2 })
  })

  it('a kept next page of a taken scan that holds it is not sent again', () => {
    const r = recover({ pages: [page('p2', A, 2)], current: A }, [
      { id: A, pageIds: ['s1', 'p2'], open: false },
    ])
    expect(r.landed).toEqual(['p2'])
    expect(r.resend).toEqual([])
    expect(r.current).toBeNull()
  })

  it('reopens a scan none of whose pages landed yet', () => {
    const r = recover({ pages: [page('p1', A, 1, true)], current: A }, [])
    expect(r.current).toEqual({ id: A, earlier: 0 })
  })

  it('does not reopen a scan the laptop has taken', () => {
    const r = recover({ pages: [page('p3', A, 3)], current: A }, [
      { id: A, pageIds: ['s1', 's2'], open: false },
    ])
    expect(r.current).toBeNull()
    // Its page is still sent: the outbox moves it to a scan of its own.
    expect(r.resend.map((p) => p.pageId)).toEqual(['p3'])
  })

  it('nothing kept, nothing open', () => {
    expect(recover({ pages: [], current: A }, [])).toEqual({
      created: [],
      resend: [],
      landed: [],
      current: null,
    })
  })
})
