/**
 * Shelf packer for BSP lightmaps.
 *
 * Every lit face carries its own small block of light samples (at most 17x17
 * lumels). Uploading one texture per face would mean thousands of draw calls,
 * so they all get packed into a single atlas and addressed through a second UV
 * channel.
 */
export class LightmapAtlas {
  readonly size: number
  readonly pixels: Uint8Array
  private shelfY = 0
  private shelfHeight = 0
  private cursorX = 0
  /** Padding around each block so bilinear filtering cannot sample a neighbour. */
  private readonly padding = 1

  constructor(size = 2048) {
    this.size = size
    this.pixels = new Uint8Array(size * size * 4)
  }

  /**
   * Reserves a `width` x `height` block. Returns its top-left corner, or null
   * when the atlas is full.
   */
  allocate(width: number, height: number): { x: number; y: number } | null {
    const w = width + this.padding * 2
    const h = height + this.padding * 2
    if (w > this.size) return null

    if (this.cursorX + w > this.size) {
      // Start a new shelf.
      this.shelfY += this.shelfHeight
      this.shelfHeight = 0
      this.cursorX = 0
    }
    if (this.shelfY + h > this.size) return null

    const x = this.cursorX + this.padding
    const y = this.shelfY + this.padding
    this.cursorX += w
    if (h > this.shelfHeight) this.shelfHeight = h
    return { x, y }
  }

  /**
   * Writes a block of RGB light samples, and bleeds the border outwards into
   * the padding so filtering at the edges stays clean.
   */
  write(x: number, y: number, width: number, height: number, source: Uint8Array, sourceOffset: number): void {
    for (let row = -1; row <= height; row++) {
      const sourceRow = Math.min(Math.max(row, 0), height - 1)
      for (let column = -1; column <= width; column++) {
        const sourceColumn = Math.min(Math.max(column, 0), width - 1)
        const from = sourceOffset + (sourceRow * width + sourceColumn) * 3
        const to = ((y + row) * this.size + (x + column)) * 4
        if (to < 0 || to + 3 >= this.pixels.length) continue
        this.pixels[to] = source[from] ?? 255
        this.pixels[to + 1] = source[from + 1] ?? 255
        this.pixels[to + 2] = source[from + 2] ?? 255
        this.pixels[to + 3] = 255
      }
    }
  }

  /** Fills a block with flat white, for faces the compiler left unlit. */
  writeWhite(x: number, y: number, width: number, height: number): void {
    for (let row = -1; row <= height; row++) {
      for (let column = -1; column <= width; column++) {
        const to = ((y + row) * this.size + (x + column)) * 4
        if (to < 0 || to + 3 >= this.pixels.length) continue
        this.pixels[to] = 255
        this.pixels[to + 1] = 255
        this.pixels[to + 2] = 255
        this.pixels[to + 3] = 255
      }
    }
  }
}
