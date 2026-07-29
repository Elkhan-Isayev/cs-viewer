/**
 * Minimal ZIP reader — enough to pull individual entries out of `valve.zip`
 * without shelling out to `unzip` or adding a dependency.
 *
 * Supports stored (method 0) and deflated (method 8) entries, including
 * ZIP64 archives, which `valve.zip` needs at ~400 MB.
 */
import { inflateRawSync } from 'node:zlib'
import { openSync, readSync, fstatSync, closeSync } from 'node:fs'

const EOCD_SIGNATURE = 0x06054b50
const EOCD64_LOCATOR_SIGNATURE = 0x07064b50
const EOCD64_SIGNATURE = 0x06064b50
const CENTRAL_SIGNATURE = 0x02014b50

export class ZipFile {
  #fd
  /** @type {Map<string, {name: string, method: number, compressedSize: number, size: number, localHeaderOffset: number}>} */
  entries = new Map()

  constructor(path) {
    this.#fd = openSync(path, 'r')
    this.#readCentralDirectory()
  }

  #read(length, position) {
    const buffer = Buffer.allocUnsafe(length)
    let read = 0
    while (read < length) {
      const n = readSync(this.#fd, buffer, read, length - read, position + read)
      if (n === 0) break
      read += n
    }
    return buffer
  }

  #readCentralDirectory() {
    const fileSize = fstatSync(this.#fd).size
    // The end-of-central-directory record lives in the last 64 KiB.
    const tailLength = Math.min(fileSize, 65557)
    const tail = this.#read(tailLength, fileSize - tailLength)

    let eocd = -1
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIGNATURE) {
        eocd = i
        break
      }
    }
    if (eocd < 0) throw new Error('Not a ZIP archive (no end-of-central-directory record)')

    let entryCount = tail.readUInt16LE(eocd + 10)
    let centralOffset = tail.readUInt32LE(eocd + 16)
    let centralSize = tail.readUInt32LE(eocd + 12)

    // ZIP64: the 32-bit fields saturate and the real values live in a separate record.
    const locator = eocd - 20
    if (locator >= 0 && tail.readUInt32LE(locator) === EOCD64_LOCATOR_SIGNATURE) {
      const eocd64Offset = Number(tail.readBigUInt64LE(locator + 8))
      const eocd64 = this.#read(56, eocd64Offset)
      if (eocd64.readUInt32LE(0) === EOCD64_SIGNATURE) {
        entryCount = Number(eocd64.readBigUInt64LE(32))
        centralSize = Number(eocd64.readBigUInt64LE(40))
        centralOffset = Number(eocd64.readBigUInt64LE(48))
      }
    }

    const central = this.#read(centralSize, centralOffset)
    let at = 0
    for (let i = 0; i < entryCount && at + 46 <= central.length; i++) {
      if (central.readUInt32LE(at) !== CENTRAL_SIGNATURE) break
      const method = central.readUInt16LE(at + 10)
      let compressedSize = central.readUInt32LE(at + 20)
      let size = central.readUInt32LE(at + 24)
      const nameLength = central.readUInt16LE(at + 28)
      const extraLength = central.readUInt16LE(at + 30)
      const commentLength = central.readUInt16LE(at + 32)
      let localHeaderOffset = central.readUInt32LE(at + 42)
      const name = central.toString('utf8', at + 46, at + 46 + nameLength)

      // Oversized fields are moved into the ZIP64 extra field, in this order.
      const extraStart = at + 46 + nameLength
      let extraAt = extraStart
      while (extraAt + 4 <= extraStart + extraLength) {
        const id = central.readUInt16LE(extraAt)
        const length = central.readUInt16LE(extraAt + 2)
        if (id === 0x0001) {
          let p = extraAt + 4
          if (size === 0xffffffff) { size = Number(central.readBigUInt64LE(p)); p += 8 }
          if (compressedSize === 0xffffffff) { compressedSize = Number(central.readBigUInt64LE(p)); p += 8 }
          if (localHeaderOffset === 0xffffffff) { localHeaderOffset = Number(central.readBigUInt64LE(p)) }
        }
        extraAt += 4 + length
      }

      this.entries.set(name, { name, method, compressedSize, size, localHeaderOffset })
      at = extraStart + extraLength + commentLength
    }
  }

  has(name) {
    return this.entries.has(name)
  }

  /** Returns entry names, optionally filtered by a predicate. */
  list(predicate) {
    const names = [...this.entries.keys()]
    return predicate ? names.filter(predicate) : names
  }

  /** @returns {Buffer} the decompressed contents of `name`. */
  read(name) {
    const entry = this.entries.get(name)
    if (!entry) throw new Error(`No such entry in archive: ${name}`)

    // The local header repeats the name/extra lengths, which may differ from
    // the central directory's, so the data offset must be read from it.
    const local = this.#read(30, entry.localHeaderOffset)
    const dataOffset = entry.localHeaderOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28)
    const raw = this.#read(entry.compressedSize, dataOffset)

    if (entry.method === 0) return raw
    if (entry.method === 8) return inflateRawSync(raw)
    throw new Error(`Unsupported compression method ${entry.method} for ${name}`)
  }

  close() {
    closeSync(this.#fd)
  }
}
