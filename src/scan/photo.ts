import { fitPage, toGrey, warp } from './image'
import type { Fitted, Grey } from './image'
import type { Quad } from './geometry'

/**
 * The canvas side of a page: the camera's file decoded (EXIF orientation
 * applied) and held at a working size, turned a quarter at a time, and
 * flattened and encoded once its corners are set.
 */

/**
 * The working photo's long edge. The page comes out at 1754 px at most
 * and fills most of the photo, so this keeps its detail while holding a
 * 12 MP camera's 48 MB bitmap to about a third (and well under iOS's
 * 16.7 MP canvas limit).
 */
export const WORKING_LONG = 2800

/** The photo in `file` drawn on a canvas at most WORKING_LONG long. */
export async function loadPhoto(file: Blob): Promise<HTMLCanvasElement> {
  const source = await decode(file)
  try {
    const scale = Math.min(
      1,
      WORKING_LONG / Math.max(source.width, source.height),
    )
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(source.width * scale)
    canvas.height = Math.round(source.height * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no 2d context')
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(source.image, 0, 0, canvas.width, canvas.height)
    return canvas
  } finally {
    source.close()
  }
}

interface Decoded {
  image: CanvasImageSource
  width: number
  height: number
  close: () => void
}

async function decode(file: Blob): Promise<Decoded> {
  // createImageBitmap applies EXIF orientation by default; an <img> is the
  // fallback for a browser that lacks it or can't decode this file that way.
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file)
      return {
        image: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => bitmap.close(),
      }
    } catch {
      // fall through
    }
  }
  const url = URL.createObjectURL(file)
  const img = new Image()
  img.src = url
  try {
    await img.decode()
  } catch (err) {
    URL.revokeObjectURL(url)
    throw err
  }
  return {
    image: img,
    width: img.naturalWidth,
    height: img.naturalHeight,
    close: () => URL.revokeObjectURL(url),
  }
}

/** `canvas` turned a quarter clockwise, as a new canvas. */
export function rotateCanvas(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const out = document.createElement('canvas')
  out.width = canvas.height
  out.height = canvas.width
  const ctx = out.getContext('2d')!
  ctx.translate(out.width, 0)
  ctx.rotate(Math.PI / 2)
  ctx.drawImage(canvas, 0, 0)
  return out
}

export function greyOf(canvas: HTMLCanvasElement): Grey {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
  return toGrey(data, canvas.width, canvas.height)
}

/**
 * The page inside `quad`, flattened, greyscale and encoded down the
 * ladder until it fits `maxBytes`; null when even the floor doesn't.
 */
export async function flatten(
  grey: Grey,
  quad: Quad,
  maxBytes: number,
): Promise<Fitted | null> {
  const canvas = document.createElement('canvas')
  let drawn = ''
  try {
    return await fitPage(quad, maxBytes, async (width, height, quality) => {
      // Qualities at one size share the warp.
      if (drawn !== `${width}x${height}`) {
        canvas.width = width
        canvas.height = height
        const pixels = warp(grey, quad, width, height)
        canvas
          .getContext('2d')!
          .putImageData(
            new ImageData(pixels as ImageDataArray, width, height),
            0,
            0,
          )
        drawn = `${width}x${height}`
      }
      return encodeJpeg(canvas, quality)
    })
  } finally {
    // iOS keeps a canvas's memory until it is shrunk.
    canvas.width = canvas.height = 0
  }
}

function encodeJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('no JPEG'))),
      'image/jpeg',
      quality,
    ),
  )
}
