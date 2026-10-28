import { describe, expect, test } from 'vitest'
import { portsFor, reserved, servedOn, slotFor } from './dev-lib.mjs'

const MAIN = '/w/keep-together'
const all = () => true

describe('slotFor', () => {
  test('the main checkout is always slot 0', () => {
    expect(slotFor({}, MAIN, MAIN, all)).toEqual({ n: 0, slots: { [MAIN]: 0 } })
  })

  test('a worktree takes the lowest free slot from 1, and keeps it', () => {
    const first = slotFor({ [MAIN]: 0 }, '/w/a', MAIN, all)
    expect(first.n).toBe(1)
    const second = slotFor(first.slots, '/w/b', MAIN, all)
    expect(second.n).toBe(2)
    expect(slotFor(second.slots, '/w/a', MAIN, all).n).toBe(1)
  })

  test('a removed checkout frees its slot', () => {
    const slots = { [MAIN]: 0, '/w/gone': 1, '/w/b': 2 }
    const got = slotFor(slots, '/w/c', MAIN, (p) => p !== '/w/gone')
    expect(got.n).toBe(1)
    expect(got.slots).toEqual({ [MAIN]: 0, '/w/b': 2, '/w/c': 1 })
  })

  test('slots whose api port QC or the stall bench owns are skipped', () => {
    const slots = { [MAIN]: 0 }
    for (let n = 1; n <= 12; n++) slots[`/w/${n}`] = n
    const got = slotFor(slots, '/w/next', MAIN, all)
    expect(reserved(13)).toBe(true)
    expect(got.n).toBe(33)
    expect(portsFor(got.n).api).toBe(8820)
  })
})

test('ports follow the slot', () => {
  expect(portsFor(0)).toEqual({ api: 8787, vite: 3000, https: 9100 })
  expect(portsFor(2)).toEqual({ api: 8789, vite: 3002, https: 9102 })
})

describe('servedOn', () => {
  const host = 'box.tailnet.ts.net'
  const status = {
    TCP: { 443: { HTTPS: true }, 9101: { HTTPS: true }, 9102: { HTTPS: true } },
    Web: {
      [`${host}:443`]: {
        Handlers: { '/': { Proxy: 'http://127.0.0.1:8780' } },
      },
      [`${host}:9101`]: {
        Handlers: { '/': { Proxy: 'http://127.0.0.1:3001' } },
      },
      [`${host}:9102`]: { Handlers: { '/': { Path: '/srv/other' } } },
    },
  }

  test('a free port', () => {
    expect(servedOn(status, 9103, 'http://127.0.0.1:3003')).toBeNull()
    expect(servedOn({}, 9103, 'http://127.0.0.1:3003')).toBeNull()
  })

  test("this checkout's own entry", () => {
    expect(servedOn(status, 9101, 'http://127.0.0.1:3001')).toEqual({
      ours: true,
    })
  })

  test("someone else's: another target, a path, the preview", () => {
    expect(servedOn(status, 9101, 'http://127.0.0.1:3002')).toEqual({
      ours: false,
    })
    expect(servedOn(status, 9102, 'http://127.0.0.1:3002')).toEqual({
      ours: false,
    })
    expect(servedOn(status, 443, 'http://127.0.0.1:3000')).toEqual({
      ours: false,
    })
  })
})
