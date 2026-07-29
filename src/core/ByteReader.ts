/** Little-endian byte-aligned reader used for demo file structure and byte-aligned svc messages. */
export class ByteReader {
  readonly bytes: Uint8Array
  private readonly view: DataView
  offset: number

  constructor(bytes: Uint8Array, offset = 0) {
    this.bytes = bytes
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    this.offset = offset
  }

  get length(): number {
    return this.bytes.length
  }

  get remaining(): number {
    return this.bytes.length - this.offset
  }

  get eof(): boolean {
    return this.offset >= this.bytes.length
  }

  seek(offset: number): this {
    this.offset = offset
    return this
  }

  skip(count: number): this {
    this.offset += count
    return this
  }

  u8(): number {
    return this.view.getUint8(this.offset++)
  }

  i8(): number {
    return this.view.getInt8(this.offset++)
  }

  u16(): number {
    const v = this.view.getUint16(this.offset, true)
    this.offset += 2
    return v
  }

  i16(): number {
    const v = this.view.getInt16(this.offset, true)
    this.offset += 2
    return v
  }

  u32(): number {
    const v = this.view.getUint32(this.offset, true)
    this.offset += 4
    return v
  }

  i32(): number {
    const v = this.view.getInt32(this.offset, true)
    this.offset += 4
    return v
  }

  f32(): number {
    const v = this.view.getFloat32(this.offset, true)
    this.offset += 4
    return v
  }

  vec3(): [number, number, number] {
    return [this.f32(), this.f32(), this.f32()]
  }

  /** NUL-terminated string. */
  str(): string {
    let out = ''
    while (this.offset < this.bytes.length) {
      const c = this.bytes[this.offset++]
      if (c === 0) break
      out += String.fromCharCode(c)
    }
    return out
  }

  /** Fixed-width, NUL-padded string field of exactly `size` bytes. */
  strFixed(size: number): string {
    const start = this.offset
    let out = ''
    for (let i = 0; i < size; i++) {
      const c = this.bytes[start + i]
      if (c === 0) break
      out += String.fromCharCode(c)
    }
    this.offset = start + size
    return out
  }

  slice(count: number): Uint8Array {
    const out = this.bytes.subarray(this.offset, this.offset + count)
    this.offset += count
    return out
  }
}
