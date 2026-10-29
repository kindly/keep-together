/**
 * EXIF orientation, checked rather than trusted. Phones store a photo as
 * the sensor saw it and say in EXIF how to turn it (an iPhone held upright
 * writes orientation 6). Browsers apply it when decoding, but WebKit's
 * `createImageBitmap` came to it late, so the page reads the JPEG's own
 * size and orientation and turns the photo itself when a decoder didn't.
 */

export interface JpegInfo {
  /** The stored pixels' size, before any turn. */
  width: number
  height: number
  /** EXIF orientation 1–8 (1 when absent). */
  orientation: number
}

/**
 * Size and orientation from a JPEG's header (its first 128 KB are
 * plenty), or null when it isn't a JPEG this can read.
 */
export function jpegInfo(bytes: Uint8Array): JpegInfo | null {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return null
  let orientation = 1
  let at = 2
  while (at + 4 <= v.byteLength) {
    if (v.getUint8(at) !== 0xff) return null
    const marker = v.getUint8(at + 1)
    // Fill bytes before a marker.
    if (marker === 0xff) {
      at++
      continue
    }
    const length = v.getUint16(at + 2)
    if (marker === 0xe1)
      orientation = exifOrientation(v, at + 4, length - 2) ?? orientation
    // Start of frame (baseline, progressive, …; not DHT, JPG or DAC).
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      ![0xc4, 0xc8, 0xcc].includes(marker)
    ) {
      if (at + 9 > v.byteLength) return null
      return {
        height: v.getUint16(at + 5),
        width: v.getUint16(at + 7),
        orientation,
      }
    }
    if (marker === 0xda) return null
    at += 2 + length
  }
  return null
}

function exifOrientation(
  v: DataView,
  start: number,
  length: number,
): number | null {
  const end = Math.min(start + length, v.byteLength)
  // "Exif\0\0", then a TIFF header.
  if (end - start < 14 || v.getUint32(start) !== 0x45786966) return null
  const tiff = start + 6
  const little = v.getUint16(tiff) === 0x4949
  const u16 = (o: number) => v.getUint16(o, little)
  const u32 = (o: number) => v.getUint32(o, little)
  const ifd = tiff + u32(tiff + 4)
  if (ifd + 2 > end) return null
  const count = u16(ifd)
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12
    if (entry + 12 > end) return null
    if (u16(entry) === 0x0112) {
      const o = u16(entry + 8)
      return o >= 1 && o <= 8 ? o : null
    }
  }
  return null
}

/** Orientations 5–8 turn the photo a quarter: width and height swap. */
export function swapsSides(orientation: number): boolean {
  return orientation >= 5
}

/**
 * Whether a decoder left `orientation` unapplied, judged by the decoded
 * size against the stored one. Only a quarter turn shows in the size, so
 * 2–4 (mirror, half turn) can't be told and are trusted to the decoder.
 */
export function orientationIgnored(
  info: JpegInfo,
  decoded: { width: number; height: number },
): boolean {
  return (
    swapsSides(info.orientation) &&
    info.width !== info.height &&
    decoded.width === info.width &&
    decoded.height === info.height
  )
}

/**
 * The canvas size and transform that draw stored pixels (`width` ×
 * `height`) the right way up: `[a, b, c, d, e, f]` for `setTransform`.
 */
export function orientTransform(
  orientation: number,
  width: number,
  height: number,
): {
  width: number
  height: number
  matrix: [number, number, number, number, number, number]
} {
  const w = width
  const h = height
  switch (orientation) {
    case 2:
      return { width: w, height: h, matrix: [-1, 0, 0, 1, w, 0] }
    case 3:
      return { width: w, height: h, matrix: [-1, 0, 0, -1, w, h] }
    case 4:
      return { width: w, height: h, matrix: [1, 0, 0, -1, 0, h] }
    case 5:
      return { width: h, height: w, matrix: [0, 1, 1, 0, 0, 0] }
    case 6:
      return { width: h, height: w, matrix: [0, 1, -1, 0, h, 0] }
    case 7:
      return { width: h, height: w, matrix: [0, -1, -1, 0, h, w] }
    case 8:
      return { width: h, height: w, matrix: [0, -1, 1, 0, 0, w] }
    default:
      return { width: w, height: h, matrix: [1, 0, 0, 1, 0, 0] }
  }
}
