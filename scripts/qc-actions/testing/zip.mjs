// A zip writer for the qc-actions tests: [name, contents] entries,
// deflated unless `store`, with zip64 fields when `zip64` (as yazl,
// Playwright's zip writer, can).
import { crc32, deflateRawSync } from 'node:zlib'

/** A zip of [name, contents] (deflated unless `store`), as yazl writes them. */
export function zip(entries, { store = false, zip64 = false } = {}) {
  const locals = []
  const central = []
  let offset = 0
  for (const [name, body] of entries) {
    const n = Buffer.from(name)
    const raw = Buffer.from(body)
    const data = store ? raw : deflateRawSync(raw)
    const method = store ? 0 : 8
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc32(raw), 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(n.length, 26)
    locals.push(local, n, data)
    let extra = Buffer.alloc(0)
    if (zip64) {
      extra = Buffer.alloc(28)
      extra.writeUInt16LE(0x0001, 0)
      extra.writeUInt16LE(24, 2)
      extra.writeBigUInt64LE(BigInt(raw.length), 4)
      extra.writeBigUInt64LE(BigInt(data.length), 12)
      extra.writeBigUInt64LE(BigInt(offset), 20)
    }
    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50, 0)
    c.writeUInt16LE(method, 10)
    c.writeUInt32LE(crc32(raw), 16)
    c.writeUInt32LE(zip64 ? 0xffffffff : data.length, 20)
    c.writeUInt32LE(zip64 ? 0xffffffff : raw.length, 24)
    c.writeUInt16LE(n.length, 28)
    c.writeUInt16LE(extra.length, 30)
    c.writeUInt32LE(zip64 ? 0xffffffff : offset, 42)
    central.push(c, n, extra)
    offset += 30 + n.length + data.length
  }
  const cd = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}
