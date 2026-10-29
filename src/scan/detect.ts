import { insetQuad } from './geometry'
import type { Quad } from './geometry'

/**
 * A first guess at the page's corners: scanic (MIT, Rust → WASM, its WASM
 * inlined in its own chunk), loaded only once a photo is taken. Staff drag
 * the corners anyway, so when scanic can't load or finds no page the guess
 * is an inset rectangle (plan g1q11's fallback).
 */

export interface Detected {
  quad: Quad
  /** scanic found the page; false means the inset fallback. */
  found: boolean
}

/** The page's size in detection: smaller is faster, and corners are a guess. */
const DETECT_LONG = 800

export async function detectCorners(
  canvas: HTMLCanvasElement,
): Promise<Detected> {
  const fallback = {
    quad: insetQuad(canvas.width, canvas.height),
    found: false,
  }
  try {
    const { scanDocument } = await import('scanic')
    const result = await scanDocument(canvas, {
      mode: 'detect',
      maxProcessingDimension: DETECT_LONG,
    })
    const c = result.success ? result.corners : null
    if (!c) return fallback
    const quad: Quad = [c.topLeft, c.topRight, c.bottomRight, c.bottomLeft]
    if (!quad.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) {
      return fallback
    }
    return { quad: quad.map(({ x, y }) => ({ x, y })) as Quad, found: true }
  } catch {
    return fallback
  }
}
