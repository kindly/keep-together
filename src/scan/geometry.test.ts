import { describe, expect, it } from 'vitest'
import {
  applyHomography,
  clampPoint,
  homography,
  insetQuad,
  isUsableQuad,
  outputSize,
  rectQuad,
  rotatePoint,
  rotateQuad,
} from './geometry'
import type { Quad } from './geometry'

const near = (a: { x: number; y: number }, b: { x: number; y: number }) => {
  expect(a.x).toBeCloseTo(b.x, 6)
  expect(a.y).toBeCloseTo(b.y, 6)
}

describe('homography', () => {
  it('maps each corner of the rectangle onto the quad', () => {
    const quad: Quad = [
      { x: 103, y: 87 },
      { x: 912, y: 140 },
      { x: 860, y: 1290 },
      { x: 60, y: 1201 },
    ]
    const rect = rectQuad(1240, 1754)
    const h = homography(rect, quad)!
    rect.forEach((p, i) => near(applyHomography(h, p), quad[i]))
  })

  it('is the identity between equal quads', () => {
    const q = rectQuad(100, 50)
    const h = homography(q, q)!
    near(applyHomography(h, { x: 37, y: 12 }), { x: 37, y: 12 })
  })

  it("keeps straight lines straight (the page's edge stays an edge)", () => {
    const quad: Quad = [
      { x: 10, y: 10 },
      { x: 200, y: 30 },
      { x: 180, y: 300 },
      { x: 20, y: 260 },
    ]
    const h = homography(rectQuad(100, 100), quad)!
    // Points along the output's top edge land on the quad's top edge.
    for (const x of [0, 25, 50, 75, 100]) {
      const p = applyHomography(h, { x, y: 0 })
      const t = (p.x - 10) / 190
      expect(p.y).toBeCloseTo(10 + t * 20, 6)
    }
  })

  it('refuses a degenerate quad', () => {
    const line: Quad = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 3, y: 3 },
    ]
    expect(homography(rectQuad(10, 10), line)).toBeNull()
  })
})

describe('outputSize', () => {
  it('is A4 at 150 dpi, portrait for a page taller than wide', () => {
    expect(outputSize(insetQuad(3000, 4000))).toEqual({
      width: 1240,
      height: 1754,
    })
  })

  it('turns landscape for a page wider than tall', () => {
    expect(outputSize(insetQuad(4000, 3000))).toEqual({
      width: 1754,
      height: 1240,
    })
  })

  it('keeps A4 proportions at a smaller long edge', () => {
    expect(outputSize(insetQuad(3000, 4000), 1300)).toEqual({
      width: 919,
      height: 1300,
    })
  })

  it('reads the shape from the quad, not the photo', () => {
    // A portrait page photographed in a landscape frame.
    const quad: Quad = [
      { x: 1200, y: 100 },
      { x: 2800, y: 100 },
      { x: 2800, y: 2900 },
      { x: 1200, y: 2900 },
    ]
    expect(outputSize(quad)).toEqual({ width: 1240, height: 1754 })
  })
})

describe('rotation', () => {
  it('turns a point a quarter clockwise', () => {
    // In a 400 × 300 image the top left goes to the top right of 300 × 400.
    expect(rotatePoint({ x: 0, y: 0 }, 300)).toEqual({ x: 300, y: 0 })
    expect(rotatePoint({ x: 400, y: 300 }, 300)).toEqual({ x: 0, y: 400 })
  })

  it('keeps the corners in order, starting from the new top left', () => {
    const quad = insetQuad(400, 300, 0)
    const turned = rotateQuad(quad, 300)
    expect(turned).toEqual(rectQuad(300, 400))
  })

  it('swaps portrait and landscape', () => {
    const quad = insetQuad(4000, 3000)
    expect(outputSize(rotateQuad(quad, 3000))).toEqual({
      width: 1240,
      height: 1754,
    })
  })

  it('comes back after four turns', () => {
    let q = insetQuad(400, 300)
    for (let i = 0; i < 4; i++) q = rotateQuad(q, i % 2 === 0 ? 300 : 400)
    q.forEach((p, i) => near(p, insetQuad(400, 300)[i]))
  })
})

it('clamps a dragged corner inside the photo', () => {
  expect(clampPoint({ x: -5, y: 120 }, 100, 100)).toEqual({ x: 0, y: 100 })
})

describe('isUsableQuad', () => {
  it('takes a clockwise convex outline, however it is turned', () => {
    expect(isUsableQuad(insetQuad(400, 300))).toBe(true)
    expect(isUsableQuad(rotateQuad(insetQuad(400, 300), 300))).toBe(true)
  })

  it('refuses a crossed outline (top left dragged past top right)', () => {
    const [tl, tr, br, bl] = insetQuad(400, 300)
    expect(isUsableQuad([tr, tl, br, bl])).toBe(false)
  })

  it('refuses a mirrored (anticlockwise) outline', () => {
    const [tl, tr, br, bl] = insetQuad(400, 300)
    expect(isUsableQuad([tl, bl, br, tr])).toBe(false)
  })

  it('refuses a folded outline and a corner on top of another', () => {
    const [tl, tr, br, bl] = insetQuad(400, 300)
    expect(isUsableQuad([tl, tr, { x: 100, y: 60 }, bl])).toBe(false)
    expect(isUsableQuad([tl, tr, br, br])).toBe(false)
  })
})
