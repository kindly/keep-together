/**
 * The phone page's geometry (plan declaration-scans.sv, step 5): the
 * page's four corners in the photo, the output size they imply, and the
 * homography that maps the output rectangle back onto the photo, so the
 * warp samples the photo once per output pixel.
 */

export interface Point {
  x: number
  y: number
}

/** Corners in photo pixels, clockwise from the page's top left. */
export type Quad = [Point, Point, Point, Point]

/** A4 at 150 dpi: 1240 × 1754 (g1q12). */
export const PAGE_SHORT = 1240
export const PAGE_LONG = 1754

/** The quad a page starts from when detection finds none: inset 8%. */
export function insetQuad(width: number, height: number, inset = 0.08): Quad {
  const dx = width * inset
  const dy = height * inset
  return [
    { x: dx, y: dy },
    { x: width - dx, y: dy },
    { x: width - dx, y: height - dy },
    { x: dx, y: height - dy },
  ]
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)

/**
 * The output's width and height for `quad` at `long` px on its long edge:
 * A4's proportions, portrait unless the quad is wider than it is tall.
 */
export function outputSize(
  quad: Quad,
  long = PAGE_LONG,
): { width: number; height: number } {
  const [tl, tr, br, bl] = quad
  const across = (dist(tl, tr) + dist(bl, br)) / 2
  const down = (dist(tl, bl) + dist(tr, br)) / 2
  const short = Math.round((long * PAGE_SHORT) / PAGE_LONG)
  return across > down
    ? { width: long, height: short }
    : { width: short, height: long }
}

/**
 * The photo turned a quarter clockwise: where `p` lands in an image that
 * was `height` px tall.
 */
export function rotatePoint(p: Point, height: number): Point {
  return { x: height - p.y, y: p.x }
}

/**
 * `quad` after the photo turns a quarter clockwise: each point moves, and
 * what was the bottom left is now the top left.
 */
export function rotateQuad(quad: Quad, height: number): Quad {
  const [tl, tr, br, bl] = quad.map((p) => rotatePoint(p, height))
  return [bl, tl, tr, br]
}

/** `p` kept inside a `width` × `height` image. */
export function clampPoint(p: Point, width: number, height: number): Point {
  return {
    x: Math.min(Math.max(p.x, 0), width),
    y: Math.min(Math.max(p.y, 0), height),
  }
}

/**
 * A 3×3 homography, row-major, with h[8] = 1: (x, y) maps to
 * ((h0·x + h1·y + h2) / w, (h3·x + h4·y + h5) / w), w = h6·x + h7·y + 1.
 */
export type Homography = Float64Array

/**
 * The homography taking each `from` point to the `to` point at the same
 * index, or null when the points are degenerate (three in a line).
 */
export function homography(from: Quad, to: Quad): Homography | null {
  // Eight equations in h0..h7: two per point pair.
  const a: Array<Array<number>> = []
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i]
    const { x: u, y: v } = to[i]
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u])
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y, v])
  }
  // Gauss-Jordan with partial pivoting on the 8×9 augmented matrix.
  for (let col = 0; col < 8; col++) {
    let pivot = col
    for (let r = col + 1; r < 8; r++) {
      if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r
    }
    if (Math.abs(a[pivot][col]) < 1e-10) return null
    ;[a[col], a[pivot]] = [a[pivot], a[col]]
    for (let r = 0; r < 8; r++) {
      if (r === col) continue
      const f = a[r][col] / a[col][col]
      if (f === 0) continue
      for (let c = col; c < 9; c++) a[r][c] -= f * a[col][c]
    }
  }
  const h = new Float64Array(9)
  for (let i = 0; i < 8; i++) h[i] = a[i][8] / a[i][i]
  h[8] = 1
  return h
}

export function applyHomography(h: Homography, p: Point): Point {
  const w = h[6] * p.x + h[7] * p.y + h[8]
  return {
    x: (h[0] * p.x + h[1] * p.y + h[2]) / w,
    y: (h[3] * p.x + h[4] * p.y + h[5]) / w,
  }
}

/** The output rectangle's corners, clockwise from the top left. */
export function rectQuad(width: number, height: number): Quad {
  return [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ]
}

/**
 * The outline is a convex quadrilateral going clockwise on screen (y
 * down), as the corners are labelled. A crossed or folded outline (a
 * handle dragged past another) would warp to a mirrored or folded page,
 * so "Use page" refuses it; a merely rotated labelling stays clockwise.
 */
export function isUsableQuad(quad: Quad): boolean {
  for (let i = 0; i < 4; i++) {
    const a = quad[i]
    const b = quad[(i + 1) % 4]
    const c = quad[(i + 2) % 4]
    const turn = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
    if (!(turn > 0)) return false
  }
  return true
}
