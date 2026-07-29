import { ByteReader } from '../core/ByteReader.ts'
import { readMipTexture, type MipTexture } from './miptex.ts'

const LUMP_ENTITIES = 0
const LUMP_TEXTURES = 2
const LUMP_VERTICES = 3
const LUMP_TEXINFO = 6
const LUMP_FACES = 7
const LUMP_LIGHTING = 8
const LUMP_EDGES = 12
const LUMP_SURFEDGES = 13
const LUMP_MODELS = 14
const LUMP_COUNT = 15

export interface BspFace {
  firstEdge: number
  edgeCount: number
  texInfo: number
  /** Byte offset into the lighting lump, or -1 when the face is unlit. */
  lightmapOffset: number
  styles: [number, number, number, number]
}

export interface BspTexInfo {
  /** s axis and offset: u = dot(vertex, s) + sShift. */
  s: [number, number, number]
  sShift: number
  t: [number, number, number]
  tShift: number
  textureIndex: number
  flags: number
}

export interface BspModel {
  origin: [number, number, number]
  firstFace: number
  faceCount: number
}

export interface BspEntity {
  [key: string]: string
}

export interface Bsp {
  vertices: Float32Array
  edges: Uint16Array
  surfEdges: Int32Array
  faces: BspFace[]
  texInfo: BspTexInfo[]
  textures: MipTexture[]
  models: BspModel[]
  lighting: Uint8Array
  entities: BspEntity[]
}

export function parseBsp(bytes: Uint8Array): Bsp {
  const header = new ByteReader(bytes)
  const version = header.i32()
  if (version !== 30) {
    throw new Error(`Unsupported BSP version ${version} (expected 30, GoldSrc)`)
  }

  const lumps: { offset: number; length: number }[] = []
  for (let i = 0; i < LUMP_COUNT; i++) {
    lumps.push({ offset: header.i32(), length: header.i32() })
  }
  const lump = (index: number) => {
    const { offset, length } = lumps[index]
    return bytes.subarray(offset, offset + length)
  }

  // Vertices, edges and surfedges are plain arrays; read them as typed views.
  const vertexBytes = lump(LUMP_VERTICES)
  const vertices = new Float32Array(vertexBytes.length / 4)
  new Uint8Array(vertices.buffer).set(vertexBytes)

  const edgeBytes = lump(LUMP_EDGES)
  const edges = new Uint16Array(edgeBytes.length / 2)
  new Uint8Array(edges.buffer).set(edgeBytes)

  const surfEdgeBytes = lump(LUMP_SURFEDGES)
  const surfEdges = new Int32Array(surfEdgeBytes.length / 4)
  new Uint8Array(surfEdges.buffer).set(surfEdgeBytes)

  const faces: BspFace[] = []
  const faceReader = new ByteReader(lump(LUMP_FACES))
  while (faceReader.remaining >= 20) {
    faceReader.skip(4) // plane index and side; the winding already encodes both
    const firstEdge = faceReader.i32()
    const edgeCount = faceReader.u16()
    const texInfo = faceReader.u16()
    const styles: [number, number, number, number] = [
      faceReader.u8(),
      faceReader.u8(),
      faceReader.u8(),
      faceReader.u8()
    ]
    faces.push({ firstEdge, edgeCount, texInfo, styles, lightmapOffset: faceReader.i32() })
  }

  const texInfo: BspTexInfo[] = []
  const texInfoReader = new ByteReader(lump(LUMP_TEXINFO))
  while (texInfoReader.remaining >= 40) {
    const s = texInfoReader.vec3()
    const sShift = texInfoReader.f32()
    const t = texInfoReader.vec3()
    const tShift = texInfoReader.f32()
    texInfo.push({
      s,
      sShift,
      t,
      tShift,
      textureIndex: texInfoReader.u32(),
      flags: texInfoReader.u32()
    })
  }

  const models: BspModel[] = []
  const modelReader = new ByteReader(lump(LUMP_MODELS))
  while (modelReader.remaining >= 64) {
    modelReader.skip(24) // mins, maxs
    const origin = modelReader.vec3()
    modelReader.skip(16) // head nodes
    modelReader.skip(4) // vis leaf count
    models.push({ origin, firstFace: modelReader.i32(), faceCount: modelReader.i32() })
  }

  const textureLump = lump(LUMP_TEXTURES)
  const textures: MipTexture[] = []
  if (textureLump.length >= 4) {
    const textureReader = new ByteReader(textureLump)
    const count = textureReader.u32()
    for (let i = 0; i < count; i++) {
      const offset = textureReader.i32()
      // A negative offset marks an entry the compiler dropped.
      textures.push(
        offset < 0
          ? { name: '', width: 0, height: 0, pixels: null }
          : readMipTexture(textureLump, offset)
      )
    }
  }

  return {
    vertices,
    edges,
    surfEdges,
    faces,
    texInfo,
    textures,
    models,
    lighting: lump(LUMP_LIGHTING),
    entities: parseEntities(lump(LUMP_ENTITIES))
  }
}

/** Parses the entity lump's `{ "key" "value" ... }` blocks. */
export function parseEntities(bytes: Uint8Array): BspEntity[] {
  let text = ''
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i]
    if (c === 0) break
    text += String.fromCharCode(c)
  }

  const entities: BspEntity[] = []
  const pattern = /"([^"]*)"\s*"([^"]*)"/g
  for (const block of text.split('}')) {
    const open = block.indexOf('{')
    if (open < 0) continue
    const entity: BspEntity = {}
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(block.slice(open))) !== null) {
      entity[match[1]] = match[2]
    }
    if (Object.keys(entity).length) entities.push(entity)
  }
  return entities
}
