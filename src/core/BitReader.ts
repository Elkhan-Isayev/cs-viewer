/**
 * LSB-first bit reader, matching GoldSrc's `MSG_ReadBits` semantics.
 *
 * GoldSrc network messages are a hybrid stream: the outer message loop is
 * byte-aligned, but individual messages (entity deltas, events, resource
 * lists) switch into bit mode mid-message and then round up to the next byte
 * boundary when they finish. `BitReader` is therefore constructed over the
 * same buffer as the surrounding `ByteReader` and seeks by absolute bit index.
 */
export class BitReader {
  private readonly bytes: Uint8Array
  /** Absolute read cursor, in bits from the start of `bytes`. */
  index: number

  constructor(bytes: Uint8Array, startByte = 0) {
    this.bytes = bytes
    this.index = startByte * 8
  }

  get bitsLeft(): number {
    return this.bytes.length * 8 - this.index
  }

  /** Reads `bits` (1..32) as an unsigned integer, LSB first. */
  read(bits: number): number {
    if (bits === 0) return 0
    if (bits > this.bitsLeft) {
      throw new RangeError(`BitReader overrun: wanted ${bits} bits, ${this.bitsLeft} left`)
    }

    let value = 0
    let done = 0
    let offset = this.index
    while (done < bits) {
      const bitOffset = offset & 7
      // How many bits we can still take out of the byte we are sitting in.
      const take = Math.min(bits - done, 8 - bitOffset)
      const chunk = (this.bytes[offset >> 3] >> bitOffset) & ((1 << take) - 1)
      value |= chunk << done
      offset += take
      done += take
    }
    this.index = offset
    return value >>> 0
  }

  /** Reads `bits` as a two's-complement signed integer. */
  readSigned(bits: number): number {
    const value = this.read(bits)
    if (bits !== 32 && value & (1 << (bits - 1))) {
      return value | (-1 ^ ((1 << bits) - 1))
    }
    return value | 0
  }

  /** Reads without advancing the cursor. */
  peek(bits: number): number {
    const at = this.index
    const value = this.read(bits)
    this.index = at
    return value
  }

  skip(bits: number): void {
    this.index += bits
  }

  /** Reads a NUL-terminated string, one byte per character. */
  readString(): string {
    let out = ''
    for (;;) {
      if (this.bitsLeft < 8) break
      const c = this.read(8)
      if (c === 0) break
      out += String.fromCharCode(c)
    }
    return out
  }

  /**
   * A GoldSrc network coordinate: optional integer part (12 bits) and
   * optional 1/32-unit fractional part (3 bits), with a shared sign bit.
   */
  readCoord(): number {
    const hasInt = this.read(1)
    const hasFrac = this.read(1)
    if (!hasInt && !hasFrac) return 0

    const negative = this.read(1)
    const int = hasInt ? this.read(12) : 0
    const frac = hasFrac ? this.read(3) : 0
    const value = int + frac / 32
    return negative ? -value : value
  }

  /** The byte offset just past the last bit read, rounded up. */
  byteAlignedEnd(): number {
    return Math.ceil(this.index / 8)
  }
}
