import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { jpegInfo, orientTransform, orientationIgnored } from './orient'

/** Bytes from hex, e.g. `'ff d8'`. */
const hex = (s: string) => s.split(' ').map((b) => parseInt(b, 16))
const u16 = (n: number, little: boolean) =>
  little ? [n & 0xff, n >> 8] : [n >> 8, n & 0xff]

/** A minimal JPEG header: SOI, an EXIF APP1 with `orientation`, SOF0. */
function jpeg(
  width: number,
  height: number,
  orientation: number,
  little = true,
) {
  const tiff = [
    ...hex(little ? '49 49 2a 00 08 00 00 00' : '4d 4d 00 2a 00 00 00 08'),
    // One IFD entry: tag 0x0112 (orientation), SHORT, count 1, the value.
    ...u16(1, little),
    ...u16(0x0112, little),
    ...u16(3, little),
    ...(little ? hex('01 00 00 00') : hex('00 00 00 01')),
    ...u16(orientation, little),
    ...hex('00 00 00 00 00 00'),
  ]
  const exif = [...hex('45 78 69 66 00 00'), ...tiff]
  const app1 = [...hex('ff e1'), ...u16(exif.length + 2, false), ...exif]
  const sof = [
    ...hex('ff c0 00 11 08'),
    ...u16(height, false),
    ...u16(width, false),
    ...hex('03 01 22 00 02 11 01 03 11 01'),
  ]
  return new Uint8Array([...hex('ff d8'), ...app1, ...sof])
}

describe('jpegInfo', () => {
  it('reads size and orientation, either byte order', () => {
    expect(jpegInfo(jpeg(4032, 3024, 6))).toEqual({
      width: 4032,
      height: 3024,
      orientation: 6,
    })
    expect(jpegInfo(jpeg(4032, 3024, 8, false))).toEqual({
      width: 4032,
      height: 3024,
      orientation: 8,
    })
  })

  it('reads the QC fixture: an iPhone-style photo stored on its side', () => {
    const bytes = readFileSync(
      new URL('../../qc/assets/declaration-photo.jpg', import.meta.url),
    )
    expect(jpegInfo(new Uint8Array(bytes))).toEqual({
      width: 4032,
      height: 3024,
      orientation: 6,
    })
  })

  it('takes orientation 1 when there is no EXIF', () => {
    const sof = hex('ff c0 00 11 08 00 0a 00 14 03 01 22 00 02 11 01 03 11 01')
    expect(jpegInfo(new Uint8Array([0xff, 0xd8, ...sof]))).toEqual({
      width: 20,
      height: 10,
      orientation: 1,
    })
  })

  it('is null for what is not a JPEG, or is cut short', () => {
    expect(jpegInfo(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull()
    expect(jpegInfo(jpeg(10, 10, 1).slice(0, 12))).toBeNull()
  })
})

describe('orientationIgnored', () => {
  const info = { width: 4032, height: 3024, orientation: 6 }

  it('is true when a quarter turn left the stored size unchanged', () => {
    expect(orientationIgnored(info, { width: 4032, height: 3024 })).toBe(true)
  })

  it('is false when the decoder turned it', () => {
    expect(orientationIgnored(info, { width: 3024, height: 4032 })).toBe(false)
  })

  it('is false without a quarter turn, or for a square photo', () => {
    expect(orientationIgnored({ ...info, orientation: 1 }, info)).toBe(false)
    expect(orientationIgnored({ ...info, orientation: 3 }, info)).toBe(false)
    expect(
      orientationIgnored(
        { width: 10, height: 10, orientation: 6 },
        { width: 10, height: 10 },
      ),
    ).toBe(false)
  })
})

describe('orientTransform', () => {
  /** Where the stored pixel (x, y) is drawn. */
  const draw = (o: number, w: number, h: number, x: number, y: number) => {
    const {
      matrix: [a, b, c, d, e, f],
    } = orientTransform(o, w, h)
    return [a * x + c * y + e, b * x + d * y + f]
  }

  it('6 turns a quarter clockwise: the stored top left lands top right', () => {
    expect(orientTransform(6, 400, 300)).toMatchObject({
      width: 300,
      height: 400,
    })
    expect(draw(6, 400, 300, 0, 0)).toEqual([300, 0])
    expect(draw(6, 400, 300, 400, 0)).toEqual([300, 400])
  })

  it('8 turns a quarter anticlockwise; 3 a half', () => {
    expect(draw(8, 400, 300, 0, 0)).toEqual([0, 400])
    expect(draw(3, 400, 300, 0, 0)).toEqual([400, 300])
  })

  it('keeps every orientation inside its canvas', () => {
    for (let o = 1; o <= 8; o++) {
      const { width, height } = orientTransform(o, 400, 300)
      for (const [x, y] of [
        [0, 0],
        [400, 0],
        [400, 300],
        [0, 300],
      ]) {
        const [X, Y] = draw(o, 400, 300, x, y)
        expect(X).toBeGreaterThanOrEqual(0)
        expect(Y).toBeGreaterThanOrEqual(0)
        expect(X).toBeLessThanOrEqual(width)
        expect(Y).toBeLessThanOrEqual(height)
      }
    }
  })
})
