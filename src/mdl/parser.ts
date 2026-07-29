import { ByteReader } from '../core/ByteReader.ts'

/**
 * Parser for Half-Life studio models (`IDST`, version 10) — the format CS 1.6
 * uses for players, weapons and props.
 */

export interface MdlBone {
  name: string
  parent: number
  /** Default value per degree of freedom: position xyz then rotation xyz. */
  value: number[]
  /** Multiplier applied to the compressed animation deltas. */
  scale: number[]
}

export interface MdlSequence {
  label: string
  fps: number
  flags: number
  frameCount: number
  /** Per-bone RLE animation channels for blend 0. */
  animOffset: number
  blendCount: number
  /** Straight-line motion the animation itself carries, in model space. */
  linearMovement: [number, number, number]
}

export interface MdlMesh {
  triangleCommandOffset: number
  skinRef: number
}

export interface MdlSubModel {
  name: string
  vertexCount: number
  /** Offset of the vec3 vertex array. */
  vertexOffset: number
  /** Offset of the per-vertex bone index array. */
  vertexBoneOffset: number
  normalCount: number
  normalOffset: number
  normalBoneOffset: number
  meshes: MdlMesh[]
}

export interface MdlBodyPart {
  name: string
  base: number
  models: MdlSubModel[]
}

export interface MdlTexture {
  name: string
  flags: number
  width: number
  height: number
  /** RGBA8 pixels. */
  pixels: Uint8Array
}

export interface Mdl {
  name: string
  bones: MdlBone[]
  sequences: MdlSequence[]
  bodyParts: MdlBodyPart[]
  textures: MdlTexture[]
  /** `skinFamilies[family][skinRef]` -> texture index. */
  skinFamilies: number[][]
  /** The raw file, needed to walk animation and triangle data lazily. */
  bytes: Uint8Array
}

/** Texture flag: colours are additive/chrome rather than plain diffuse. */
export const STUDIO_NF_CHROME = 0x02
export const STUDIO_NF_ADDITIVE = 0x20
export const STUDIO_NF_MASKED = 0x40

export function parseMdl(bytes: Uint8Array): Mdl {
  const r = new ByteReader(bytes)
  const magic = r.strFixed(4)
  if (magic !== 'IDST') {
    throw new Error(`Not a studio model (magic "${magic}")`)
  }
  const version = r.i32()
  if (version !== 10) {
    throw new Error(`Unsupported studio model version ${version} (expected 10)`)
  }

  const name = r.strFixed(64)
  r.skip(4) // file length
  r.skip(12 * 5) // eye position, movement hull, clipping hull
  r.skip(4) // flags

  const boneCount = r.i32()
  const boneOffset = r.i32()
  const boneControllerCount = r.i32()
  const boneControllerOffset = r.i32()
  void boneControllerCount
  void boneControllerOffset
  r.skip(8) // hit boxes
  const sequenceCount = r.i32()
  const sequenceOffset = r.i32()
  r.skip(8) // sequence groups
  const textureCount = r.i32()
  const textureOffset = r.i32()
  r.skip(4) // texture data offset
  const skinRefCount = r.i32()
  const skinFamilyCount = r.i32()
  const skinOffset = r.i32()
  const bodyPartCount = r.i32()
  const bodyPartOffset = r.i32()

  // --- bones ---
  const bones: MdlBone[] = []
  for (let i = 0; i < boneCount; i++) {
    const b = new ByteReader(bytes, boneOffset + i * 112)
    const boneName = b.strFixed(32)
    const parent = b.i32()
    b.skip(4) // flags
    b.skip(24) // bone controller indices
    const value = [b.f32(), b.f32(), b.f32(), b.f32(), b.f32(), b.f32()]
    const scale = [b.f32(), b.f32(), b.f32(), b.f32(), b.f32(), b.f32()]
    bones.push({ name: boneName, parent, value, scale })
  }

  // --- sequences ---
  const sequences: MdlSequence[] = []
  for (let i = 0; i < sequenceCount; i++) {
    const s = new ByteReader(bytes, sequenceOffset + i * 176)
    const label = s.strFixed(32)
    const fps = s.f32()
    const flags = s.i32()
    s.skip(8) // activity, activity weight
    s.skip(8) // events
    const frameCount = s.i32()
    s.skip(8) // pivots
    s.skip(8) // motion type, motion bone
    const linearMovement = s.vec3()
    s.skip(8) // auto-move offsets
    s.skip(24) // bounding box
    const blendCount = s.i32()
    const animOffset = s.i32()
    sequences.push({ label, fps, flags, frameCount, animOffset, blendCount, linearMovement })
  }

  // --- body parts, sub-models and meshes ---
  const bodyParts: MdlBodyPart[] = []
  for (let i = 0; i < bodyPartCount; i++) {
    const p = new ByteReader(bytes, bodyPartOffset + i * 76)
    const partName = p.strFixed(64)
    const modelCount = p.i32()
    const base = p.i32()
    const modelOffset = p.i32()

    const models: MdlSubModel[] = []
    for (let m = 0; m < modelCount; m++) {
      const mr = new ByteReader(bytes, modelOffset + m * 112)
      const modelName = mr.strFixed(64)
      mr.skip(4) // type
      mr.skip(4) // bounding radius
      const meshCount = mr.i32()
      const meshOffset = mr.i32()
      const vertexCount = mr.i32()
      const vertexBoneOffset = mr.i32()
      const vertexOffset = mr.i32()
      const normalCount = mr.i32()
      const normalBoneOffset = mr.i32()
      const normalOffset = mr.i32()

      const meshes: MdlMesh[] = []
      for (let k = 0; k < meshCount; k++) {
        const mesh = new ByteReader(bytes, meshOffset + k * 20)
        mesh.skip(4) // triangle count — the command list is self-terminating
        const triangleCommandOffset = mesh.i32()
        const skinRef = mesh.i32()
        meshes.push({ triangleCommandOffset, skinRef })
      }

      models.push({
        name: modelName,
        vertexCount,
        vertexOffset,
        vertexBoneOffset,
        normalCount,
        normalOffset,
        normalBoneOffset,
        meshes
      })
    }
    bodyParts.push({ name: partName, base, models })
  }

  // --- textures ---
  const textures: MdlTexture[] = []
  for (let i = 0; i < textureCount; i++) {
    const t = new ByteReader(bytes, textureOffset + i * 80)
    const textureName = t.strFixed(64)
    const flags = t.i32()
    const width = t.i32()
    const height = t.i32()
    const dataOffset = t.i32()
    textures.push({
      name: textureName,
      flags,
      width,
      height,
      pixels: decodeTexture(bytes, dataOffset, width, height, (flags & STUDIO_NF_MASKED) !== 0)
    })
  }

  // --- skin families ---
  const skinFamilies: number[][] = []
  for (let family = 0; family < skinFamilyCount; family++) {
    const row: number[] = []
    const s = new ByteReader(bytes, skinOffset + family * skinRefCount * 2)
    for (let ref = 0; ref < skinRefCount; ref++) row.push(s.u16())
    skinFamilies.push(row)
  }
  if (skinFamilies.length === 0) {
    skinFamilies.push(textures.map((_, i) => i))
  }

  return { name, bones, sequences, bodyParts, textures, skinFamilies, bytes }
}

/** Studio textures are 8-bit paletted, with the 256-entry RGB palette inline. */
function decodeTexture(
  bytes: Uint8Array,
  offset: number,
  width: number,
  height: number,
  masked: boolean
): Uint8Array {
  const pixels = new Uint8Array(width * height * 4)
  const paletteAt = offset + width * height
  for (let i = 0; i < width * height; i++) {
    const index = bytes[offset + i]
    const p = paletteAt + index * 3
    const o = i * 4
    if (masked && index === 255) {
      pixels[o] = pixels[o + 1] = pixels[o + 2] = pixels[o + 3] = 0
      continue
    }
    pixels[o] = bytes[p]
    pixels[o + 1] = bytes[p + 1]
    pixels[o + 2] = bytes[p + 2]
    pixels[o + 3] = 255
  }
  return pixels
}

/**
 * Reads one bone's animation channel for `frame`.
 *
 * Channels are run-length encoded: each span starts with a `valid`/`total`
 * byte pair, where `valid` values follow and the last one repeats for the
 * remainder of `total` frames.
 */
export function readAnimChannel(
  bytes: Uint8Array,
  animBase: number,
  boneIndex: number,
  channel: number,
  frame: number
): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const boneAnim = animBase + boneIndex * 12
  const offset = view.getUint16(boneAnim + channel * 2, true)
  if (offset === 0) return null

  let at = boneAnim + offset
  let k = frame
  // Walk spans until the one containing this frame.
  for (let guard = 0; guard < 1000; guard++) {
    const valid = bytes[at]
    const total = bytes[at + 1]
    if (total === 0) return null
    if (total > k) {
      const index = Math.min(k, valid - 1)
      return view.getInt16(at + 2 + index * 2, true)
    }
    k -= total
    at += 2 + valid * 2
  }
  return null
}
