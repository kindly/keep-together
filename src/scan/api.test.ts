import { afterEach, describe, expect, it, vi } from 'vitest'
import { backoffMs, newId, outcomeOf, sendPage, tokenFrom } from './api'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const TOKEN = 'ab'.repeat(32)

describe('tokenFrom', () => {
  it('reads 64 lower-case hex from the fragment', () => {
    expect(tokenFrom(`#${TOKEN}`)).toBe(TOKEN)
  })

  it('refuses anything else, so nothing odd reaches a path', () => {
    for (const hash of [
      '',
      '#',
      `#${TOKEN.toUpperCase()}`,
      `#${TOKEN}0`,
      `#${TOKEN.slice(1)}/`,
      '#../x',
    ]) {
      expect(tokenFrom(hash)).toBeNull()
    }
  })
})

it('makes client ids of 32 lower-case hex', () => {
  expect(newId()).toMatch(/^[0-9a-f]{32}$/)
  expect(newId()).not.toBe(newId())
})

describe('outcomeOf', () => {
  it('reads the body of a success', async () => {
    expect(await outcomeOf(json(200, { scanId: 'x' }))).toEqual({
      kind: 'ok',
      value: { scanId: 'x' },
    })
  })

  it('410 is the link ended, 403 another phone, 404 a scan no longer a draft', async () => {
    expect(await outcomeOf(json(410, { kind: 'gone' }))).toEqual({
      kind: 'gone',
    })
    expect(await outcomeOf(json(403, { kind: 'forbidden' }))).toEqual({
      kind: 'forbidden',
    })
    expect(await outcomeOf(json(404, { kind: 'not_found' }))).toEqual({
      kind: 'not_found',
    })
  })

  it('sends again when nothing was stored: busy, rate-limited, a server fault', async () => {
    expect(await outcomeOf(json(503, { kind: 'busy' }))).toEqual({
      kind: 'retry',
      why: 'busy',
    })
    expect(await outcomeOf(json(429, { kind: 'rate_limited' }))).toEqual({
      kind: 'retry',
      why: 'busy',
    })
    expect(await outcomeOf(json(500, { kind: 'internal' }))).toEqual({
      kind: 'retry',
      why: 'server',
    })
    // A proxy's HTML error page, not the api's JSON.
    expect(await outcomeOf(new Response('<html>', { status: 502 }))).toEqual({
      kind: 'retry',
      why: 'server',
    })
  })

  it('names the refusals the page explains', async () => {
    const rejected = (reason: string) =>
      json(422, { kind: 'rejected', reason, message: '' })
    expect(await outcomeOf(rejected('page_limit'))).toEqual({
      kind: 'refused',
      reason: 'page_limit',
    })
    expect(await outcomeOf(rejected('upload_limit'))).toEqual({
      kind: 'refused',
      reason: 'upload_limit',
    })
    expect(await outcomeOf(rejected('files_full'))).toEqual({
      kind: 'refused',
      reason: 'files_full',
    })
    expect(await outcomeOf(rejected('something_new'))).toEqual({
      kind: 'refused',
      reason: 'other',
    })
    expect(
      await outcomeOf(json(422, { kind: 'invalid', problems: [] })),
    ).toEqual({ kind: 'refused', reason: 'invalid' })
    expect(await outcomeOf(json(507, { kind: 'storage_full' }))).toEqual({
      kind: 'refused',
      reason: 'storage_full',
    })
  })
})

describe('sendPage', () => {
  afterEach(() => vi.unstubAllGlobals())

  const blob = new Blob([new Uint8Array([0xff, 0xd8])], { type: 'image/jpeg' })

  it("posts a scan's first page with the scan's id, the next with the page's", async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(json(200, { scanId: 's', pages: 1, uploadsLeft: 299 })),
    )
    vi.stubGlobal('fetch', fetch)
    await sendPage(TOKEN, {
      scanId: 'a'.repeat(32),
      pageId: 'b'.repeat(32),
      first: true,
      blob,
    })
    await sendPage(TOKEN, {
      scanId: 'a'.repeat(32),
      pageId: 'c'.repeat(32),
      first: false,
      blob,
    })
    const calls = fetch.mock.calls as unknown as Array<[string, RequestInit]>
    expect(calls[0][0]).toBe(`/api/scan/${TOKEN}/scans?id=${'a'.repeat(32)}`)
    expect(calls[1][0]).toBe(
      `/api/scan/${TOKEN}/scans/${'a'.repeat(32)}/pages?pageId=${'c'.repeat(32)}`,
    )
    expect(calls[0][1]).toMatchObject({
      method: 'POST',
      body: blob,
      referrerPolicy: 'no-referrer',
    })
  })

  it('a network failure is a retry, not an error', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Load failed')))
    expect(
      await sendPage(TOKEN, {
        scanId: 'a'.repeat(32),
        pageId: 'b'.repeat(32),
        first: true,
        blob,
      }),
    ).toEqual({
      kind: 'retry',
      why: 'offline',
    })
  })
})

it('backs off 1, 2, 4, 8, 15, then 30 s', () => {
  expect([0, 1, 2, 3, 4, 5, 6, 50].map(backoffMs)).toEqual(
    [1, 2, 4, 8, 15, 30, 30, 30].map((s) => s * 1000),
  )
})
