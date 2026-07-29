/** Minimal TGA reader — GoldSrc stores skybox faces as uncompressed or RLE Targa. */
export interface TgaImage {
  width: number
  height: number
  /** RGBA8, top-left origin. */
  pixels: Uint8Array
}

const TYPE_TRUECOLOR = 2
const TYPE_TRUECOLOR_RLE = 10

export function parseTga(bytes: Uint8Array): TgaImage {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const idLength = bytes[0]
  const imageType = bytes[2]
  const width = view.getUint16(12, true)
  const height = view.getUint16(14, true)
  const bitsPerPixel = bytes[16]
  const descriptor = bytes[17]

  if (imageType !== TYPE_TRUECOLOR && imageType !== TYPE_TRUECOLOR_RLE) {
    throw new Error(`Unsupported TGA image type ${imageType}`)
  }
  if (bitsPerPixel !== 24 && bitsPerPixel !== 32) {
    throw new Error(`Unsupported TGA depth ${bitsPerPixel}`)
  }

  const bytesPerPixel = bitsPerPixel / 8
  const pixels = new Uint8Array(width * height * 4)
  // Bit 5 of the descriptor sets the origin; when clear the rows run bottom-up.
  const bottomUp = (descriptor & 0x20) === 0

  let at = 18 + idLength
  let pixel = 0
  const total = width * height

  const write = (index: number, b: number, g: number, r: number, a: number) => {
    const x = index % width
    const y = Math.floor(index / width)
    const row = bottomUp ? height - 1 - y : y
    const to = (row * width + x) * 4
    pixels[to] = r
    pixels[to + 1] = g
    pixels[to + 2] = b
    pixels[to + 3] = a
  }

  if (imageType === TYPE_TRUECOLOR) {
    while (pixel < total) {
      write(pixel, bytes[at], bytes[at + 1], bytes[at + 2], bytesPerPixel === 4 ? bytes[at + 3] : 255)
      at += bytesPerPixel
      pixel++
    }
    return { width, height, pixels }
  }

  // Run-length encoded: a packet header byte, then either one repeated pixel
  // or a literal run.
  while (pixel < total && at < bytes.length) {
    const header = bytes[at++]
    const count = (header & 0x7f) + 1
    if (header & 0x80) {
      const b = bytes[at]
      const g = bytes[at + 1]
      const r = bytes[at + 2]
      const a = bytesPerPixel === 4 ? bytes[at + 3] : 255
      at += bytesPerPixel
      for (let i = 0; i < count && pixel < total; i++) write(pixel++, b, g, r, a)
    } else {
      for (let i = 0; i < count && pixel < total; i++) {
        write(pixel++, bytes[at], bytes[at + 1], bytes[at + 2], bytesPerPixel === 4 ? bytes[at + 3] : 255)
        at += bytesPerPixel
      }
    }
  }

  return { width, height, pixels }
}
