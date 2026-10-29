import { homography, outputSize, rectQuad } from './geometry'
import type { Quad } from './geometry'

/**
 * Pixels for the phone page: the photo's greyscale, the warp that flattens
 * the page onto an A4 rectangle, and the ladder of encodings that keeps a
 * page within the server's limit. Pure over arrays; the canvas work is in
 * `photo.ts`.
 */

/** One byte of luma per pixel. */
export interface Grey {
  width: number
  height: number
  data: Uint8Array
}

/** Rec. 601 luma of RGBA pixels (alpha ignored: photos have none). */
export function toGrey(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Grey {
  const data = new Uint8Array(width * height)
  for (let i = 0, j = 0; i < data.length; i++, j += 4) {
    data[i] =
      (rgba[j] * 299 + rgba[j + 1] * 587 + rgba[j + 2] * 114 + 500) / 1000
  }
  return { width, height, data }
}

/**
 * The page inside `quad` flattened to `width` × `height`, as RGBA (grey in
 * all three channels, for a canvas). Each output pixel's centre maps back
 * through the homography and is sampled bilinearly; outside the photo is
 * white, as paper.
 */
export function warp(
  src: Grey,
  quad: Quad,
  width: number,
  height: number,
): Uint8ClampedArray {
  const h = homography(rectQuad(width, height), quad)
  const out = new Uint8ClampedArray(width * height * 4)
  if (!h) return out.fill(255)
  const { width: sw, height: sh, data } = src
  let o = 0
  for (let y = 0; y < height; y++) {
    const cy = y + 0.5
    for (let x = 0; x < width; x++) {
      const cx = x + 0.5
      const w = h[6] * cx + h[7] * cy + h[8]
      // Back to pixel indices: centres sit at +0.5.
      const sx = (h[0] * cx + h[1] * cy + h[2]) / w - 0.5
      const sy = (h[3] * cx + h[4] * cy + h[5]) / w - 0.5
      let v = 255
      if (sx > -1 && sy > -1 && sx < sw && sy < sh) {
        const x0 = Math.floor(sx)
        const y0 = Math.floor(sy)
        const fx = sx - x0
        const fy = sy - y0
        const xa = Math.max(x0, 0)
        const xb = Math.min(x0 + 1, sw - 1)
        const ya = Math.max(y0, 0) * sw
        const yb = Math.min(y0 + 1, sh - 1) * sw
        const top = data[ya + xa] + (data[ya + xb] - data[ya + xa]) * fx
        const bottom = data[yb + xa] + (data[yb + xb] - data[yb + xa]) * fx
        v = top + (bottom - top) * fy
      }
      out[o] = out[o + 1] = out[o + 2] = v
      out[o + 3] = 255
      o += 4
    }
  }
  return out
}

/**
 * The stepped compression (plan g1q7 rider): quality 0.65 → 0.55 → 0.45 at
 * 150 dpi, then the long edge 1754 → 1500 → 1300 px (about 110 dpi, the
 * floor). JPEG, never WebP: Safari's canvas can't encode WebP and quietly
 * hands back PNG.
 */
export const LADDER: ReadonlyArray<{ long: number; quality: number }> = [
  { long: 1754, quality: 0.65 },
  { long: 1754, quality: 0.55 },
  { long: 1754, quality: 0.45 },
  { long: 1500, quality: 0.45 },
  { long: 1300, quality: 0.45 },
]

export interface Fitted {
  blob: Blob
  width: number
  height: number
  /** Index into LADDER of the step that fitted. */
  step: number
}

/**
 * The first step of the ladder whose encoding is at most `maxBytes`, or
 * null when even the floor is over (the server would refuse it). `encode`
 * renders and encodes the page at one size and quality.
 */
export async function fitPage(
  quad: Quad,
  maxBytes: number,
  encode: (width: number, height: number, quality: number) => Promise<Blob>,
): Promise<Fitted | null> {
  for (let step = 0; step < LADDER.length; step++) {
    const { long, quality } = LADDER[step]
    const { width, height } = outputSize(quad, long)
    const blob = await encode(width, height, quality)
    if (blob.size <= maxBytes) return { blob, width, height, step }
  }
  return null
}
