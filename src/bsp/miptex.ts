import { ByteReader } from '../core/ByteReader.ts'

export interface MipTexture {
  name: string
  width: number
  height: number
  /** RGBA8, top-left origin. Null when the texture lives in an external WAD. */
  pixels: Uint8Array | null
}

/** Textures whose name starts with `{` use palette entry 255 as transparent. */
const MASKED_PREFIX = '{'

/**
 * Decodes a GoldSrc `miptex` at `offset`.
 *
 * Layout: a 16-byte name, width/height, and four mip level offsets, followed
 * by the level data and a 256-entry RGB palette. A zero first offset means the
 * BSP only references the texture and the pixels live in a WAD.
 */
export function readMipTexture(bytes: Uint8Array, offset: number): MipTexture {
  const r = new ByteReader(bytes, offset)
  const name = r.strFixed(16)
  const width = r.u32()
  const height = r.u32()
  const mipOffsets = [r.u32(), r.u32(), r.u32(), r.u32()]

  if (mipOffsets[0] === 0 || width === 0 || height === 0) {
    return { name, width, height, pixels: null }
  }

  const indicesAt = offset + mipOffsets[0]
  // The palette sits after all four mip levels, behind a two-byte count.
  const mipDataSize = (width * height * 85) >> 6 // w*h * (1 + 1/4 + 1/16 + 1/64)
  const paletteAt = offset + mipOffsets[0] + mipDataSize + 2

  const masked = name.startsWith(MASKED_PREFIX)
  const pixels = new Uint8Array(width * height * 4)

  for (let i = 0; i < width * height; i++) {
    const index = bytes[indicesAt + i]
    const p = paletteAt + index * 3
    const o = i * 4
    if (masked && index === 255) {
      // Fully transparent, and the colour must be zeroed too so that filtering
      // does not bleed the palette's blue fringe into the visible edge.
      pixels[o] = 0
      pixels[o + 1] = 0
      pixels[o + 2] = 0
      pixels[o + 3] = 0
      continue
    }
    pixels[o] = bytes[p]
    pixels[o + 1] = bytes[p + 1]
    pixels[o + 2] = bytes[p + 2]
    pixels[o + 3] = 255
  }

  return { name, width, height, pixels }
}

/** A WAD3 archive: a flat directory of miptex lumps shared between maps. */
export class Wad {
  private readonly bytes: Uint8Array
  private readonly directory = new Map<string, number>()

  constructor(bytes: Uint8Array) {
    this.bytes = bytes
    const r = new ByteReader(bytes)
    if (r.strFixed(4) !== 'WAD3') throw new Error('Not a WAD3 archive')
    const count = r.i32()
    const directoryOffset = r.i32()

    for (let i = 0; i < count; i++) {
      const entry = new ByteReader(bytes, directoryOffset + i * 32)
      const filePos = entry.i32()
      entry.skip(8) // disk size, uncompressed size
      const type = entry.u8()
      const compression = entry.u8()
      entry.skip(2)
      const name = entry.strFixed(16).toLowerCase()
      if (type === 0x43 && compression === 0) this.directory.set(name, filePos)
    }
  }

  get(name: string): MipTexture | null {
    const offset = this.directory.get(name.toLowerCase())
    return offset === undefined ? null : readMipTexture(this.bytes, offset)
  }
}
