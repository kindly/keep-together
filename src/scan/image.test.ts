import { describe, expect, it } from 'vitest'
import { insetQuad, rectQuad } from './geometry'
import type { Quad } from './geometry'
import { LADDER, fitPage, toGrey, warp } from './image'
import type { Grey } from './image'

describe('toGrey', () => {
  it('takes Rec. 601 luma', () => {
    const rgba = new Uint8ClampedArray([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
    ])
    expect([...toGrey(rgba, 4, 1).data]).toEqual([76, 150, 29, 255])
  })
})

/** A `w` × `h` grey image: white with a black square from `a` to `b`. */
function card(w: number, h: number, a: number, b: number): Grey {
  const data = new Uint8Array(w * h).fill(255)
  for (let y = a; y < b; y++) for (let x = a; x < b; x++) data[y * w + x] = 0
  return { width: w, height: h, data }
}

const at = (rgba: Uint8ClampedArray, w: number, x: number, y: number) =>
  rgba[(y * w + x) * 4]

describe('warp', () => {
  it('flattens the quad onto the whole output', () => {
    // The black square is the "page": the output is all black inside.
    const src = card(100, 100, 20, 80)
    const quad: Quad = [
      { x: 20, y: 20 },
      { x: 80, y: 20 },
      { x: 80, y: 80 },
      { x: 20, y: 80 },
    ]
    const out = warp(src, quad, 30, 30)
    expect(at(out, 30, 0, 0)).toBe(0)
    expect(at(out, 30, 29, 29)).toBe(0)
    expect(at(out, 30, 15, 15)).toBe(0)
  })

  it('is greyscale and opaque', () => {
    const out = warp(card(10, 10, 2, 5), rectQuad(10, 10), 10, 10)
    for (let i = 0; i < out.length; i += 4) {
      expect(out[i]).toBe(out[i + 1])
      expect(out[i]).toBe(out[i + 2])
      expect(out[i + 3]).toBe(255)
    }
  })

  it('keeps the layout of an unwarped rectangle', () => {
    const src = card(10, 10, 2, 5)
    const out = warp(src, rectQuad(10, 10), 10, 10)
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 10; x++)
        expect(at(out, 10, x, y)).toBe(src.data[y * 10 + x])
    }
  })

  it('fills what lies outside the photo with white, as paper', () => {
    const quad: Quad = [
      { x: -50, y: -50 },
      { x: 5, y: -50 },
      { x: 5, y: 5 },
      { x: -50, y: 5 },
    ]
    const out = warp(card(10, 10, 0, 10), quad, 20, 20)
    expect(at(out, 20, 0, 0)).toBe(255)
    expect(at(out, 20, 19, 19)).toBe(0)
  })
})

describe('fitPage (the stepped compression)', () => {
  const quad = insetQuad(3000, 4000)
  /** An encoder whose output size is set per step, recording its calls. */
  const encoder = (sizes: Array<number>) => {
    const calls: Array<[number, number, number]> = []
    const encode = (w: number, h: number, q: number) => {
      calls.push([w, h, q])
      return Promise.resolve(
        new Blob([new Uint8Array(sizes[calls.length - 1])]),
      )
    }
    return { calls, encode }
  }

  it('takes the first step when it fits: 1240 × 1754 at 0.65', async () => {
    const { calls, encode } = encoder([200_000])
    const fitted = await fitPage(quad, 400_000, encode)
    expect(fitted).toMatchObject({ width: 1240, height: 1754, step: 0 })
    expect(calls).toEqual([[1240, 1754, 0.65]])
  })

  it('steps quality down, then the long edge, until the page fits', async () => {
    const { calls, encode } = encoder([
      900_000, 700_000, 500_000, 420_000, 390_000,
    ])
    const fitted = await fitPage(quad, 400_000, encode)
    expect(fitted).toMatchObject({ width: 919, height: 1300, step: 4 })
    expect(calls).toEqual([
      [1240, 1754, 0.65],
      [1240, 1754, 0.55],
      [1240, 1754, 0.45],
      [1060, 1500, 0.45],
      [919, 1300, 0.45],
    ])
  })

  it('counts exactly the limit as fitting', async () => {
    const { encode } = encoder([400_000])
    expect(await fitPage(quad, 400_000, encode)).not.toBeNull()
  })

  it('gives up below the floor (about 110 dpi) rather than send what the server refuses', async () => {
    const { calls, encode } = encoder(LADDER.map(() => 400_001))
    expect(await fitPage(quad, 400_000, encode)).toBeNull()
    expect(calls).toHaveLength(LADDER.length)
  })

  it('stops at 1300 px on the long edge', () => {
    expect(Math.min(...LADDER.map((s) => s.long))).toBe(1300)
    expect(LADDER[0]).toEqual({ long: 1754, quality: 0.65 })
  })
})
