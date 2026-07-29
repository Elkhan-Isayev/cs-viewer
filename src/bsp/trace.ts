import { ByteReader } from '../core/ByteReader.ts'

/**
 * Collision tracing against the BSP clip hulls — the same structure the engine
 * moves players through.
 *
 * The viewer uses it to keep the chase camera out of walls: without it the
 * camera happily sits inside geometry and the view fills with backfaces.
 */

const LUMP_PLANES = 1
const LUMP_CLIPNODES = 9
const LUMP_MODELS = 14

const CONTENTS_SOLID = -2
/** Nudge so traces stop just short of the surface rather than exactly on it. */
const DIST_EPSILON = 0.03125

export interface Hull {
  planeNormals: Float32Array
  planeDistances: Float32Array
  planeTypes: Uint8Array
  /** Two children per clipnode; negative values are contents. */
  children: Int32Array
  planeNumbers: Int32Array
  rootNode: number
}

/**
 * Builds one of the world model's clip hulls.
 *
 * The planes are pre-expanded by the hull size, so a trace treats the moving
 * object as a point. Hull 3 is the small crouch-sized hull, which is the best
 * fit for a camera: hull 1 is a full standing player and makes the chase
 * camera snap in much closer than it needs to in corridors.
 */
export function buildHull(bytes: Uint8Array, hullIndex = 3): Hull | null {
  const header = new ByteReader(bytes, 4)
  const lumps: { offset: number; length: number }[] = []
  for (let i = 0; i < 15; i++) lumps.push({ offset: header.i32(), length: header.i32() })

  const planeLump = lumps[LUMP_PLANES]
  const clipLump = lumps[LUMP_CLIPNODES]
  const modelLump = lumps[LUMP_MODELS]
  if (!planeLump.length || !clipLump.length || !modelLump.length) return null

  const planeCount = Math.floor(planeLump.length / 20)
  const planeNormals = new Float32Array(planeCount * 3)
  const planeDistances = new Float32Array(planeCount)
  const planeTypes = new Uint8Array(planeCount)
  const planes = new ByteReader(bytes, planeLump.offset)
  for (let i = 0; i < planeCount; i++) {
    planeNormals[i * 3] = planes.f32()
    planeNormals[i * 3 + 1] = planes.f32()
    planeNormals[i * 3 + 2] = planes.f32()
    planeDistances[i] = planes.f32()
    planeTypes[i] = planes.i32()
  }

  const clipCount = Math.floor(clipLump.length / 8)
  const planeNumbers = new Int32Array(clipCount)
  const children = new Int32Array(clipCount * 2)
  const clip = new ByteReader(bytes, clipLump.offset)
  for (let i = 0; i < clipCount; i++) {
    planeNumbers[i] = clip.i32()
    children[i * 2] = clip.i16()
    children[i * 2 + 1] = clip.i16()
  }

  // The world model is model 0. headnode[0] is the visible BSP tree; 1..3 are
  // the clip hulls.
  const model = new ByteReader(bytes, modelLump.offset)
  model.skip(24 + 12) // mins, maxs, origin
  const headNodes = [model.i32(), model.i32(), model.i32(), model.i32()]
  const rootNode = headNodes[hullIndex] ?? headNodes[1]
  if (rootNode < 0 || rootNode >= clipCount) return null

  return { planeNormals, planeDistances, planeTypes, children, planeNumbers, rootNode }
}

function pointContents(hull: Hull, node: number, x: number, y: number, z: number): number {
  let current = node
  while (current >= 0) {
    const plane = hull.planeNumbers[current]
    const type = hull.planeTypes[plane]
    const distance =
      type < 3
        ? (type === 0 ? x : type === 1 ? y : z) - hull.planeDistances[plane]
        : hull.planeNormals[plane * 3] * x +
          hull.planeNormals[plane * 3 + 1] * y +
          hull.planeNormals[plane * 3 + 2] * z -
          hull.planeDistances[plane]
    current = hull.children[current * 2 + (distance < 0 ? 1 : 0)]
  }
  return current
}

export interface TraceResult {
  /** How far along the segment the trace got, 0..1. */
  fraction: number
  /** True when the start point was already inside solid geometry. */
  startSolid: boolean
}

/**
 * Traces the segment `from` -> `to` (Quake coordinates) through the hull.
 * Mirrors the engine's `SV_RecursiveHullCheck`.
 */
export function traceLine(
  hull: Hull,
  from: [number, number, number],
  to: [number, number, number]
): TraceResult {
  const result: TraceResult = { fraction: 1, startSolid: false }

  const recurse = (
    node: number,
    startFraction: number,
    endFraction: number,
    p1: [number, number, number],
    p2: [number, number, number]
  ): boolean => {
    if (node < 0) {
      if (node === CONTENTS_SOLID) result.startSolid = true
      return true
    }

    const plane = hull.planeNumbers[node]
    const type = hull.planeTypes[plane]
    const distance = hull.planeDistances[plane]
    let t1: number
    let t2: number
    if (type < 3) {
      t1 = p1[type] - distance
      t2 = p2[type] - distance
    } else {
      const nx = hull.planeNormals[plane * 3]
      const ny = hull.planeNormals[plane * 3 + 1]
      const nz = hull.planeNormals[plane * 3 + 2]
      t1 = nx * p1[0] + ny * p1[1] + nz * p1[2] - distance
      t2 = nx * p2[0] + ny * p2[1] + nz * p2[2] - distance
    }

    // Wholly on one side: descend that child only.
    if (t1 >= 0 && t2 >= 0) return recurse(hull.children[node * 2], startFraction, endFraction, p1, p2)
    if (t1 < 0 && t2 < 0) return recurse(hull.children[node * 2 + 1], startFraction, endFraction, p1, p2)

    const denominator = t1 - t2
    let split = denominator === 0 ? 0 : (t1 < 0 ? t1 + DIST_EPSILON : t1 - DIST_EPSILON) / denominator
    split = Math.min(Math.max(split, 0), 1)

    const midFraction = startFraction + (endFraction - startFraction) * split
    const mid: [number, number, number] = [
      p1[0] + split * (p2[0] - p1[0]),
      p1[1] + split * (p2[1] - p1[1]),
      p1[2] + split * (p2[2] - p1[2])
    ]

    const side = t1 < 0 ? 1 : 0
    if (!recurse(hull.children[node * 2 + side], startFraction, midFraction, p1, mid)) return false

    // If the far side is open, keep going through it.
    if (pointContents(hull, hull.children[node * 2 + (side ^ 1)], mid[0], mid[1], mid[2]) !== CONTENTS_SOLID) {
      return recurse(hull.children[node * 2 + (side ^ 1)], midFraction, endFraction, mid, p2)
    }

    // Otherwise this is the impact point; back off until we are outside.
    let backoff = split
    let hitFraction = midFraction
    const hit: [number, number, number] = [mid[0], mid[1], mid[2]]
    while (pointContents(hull, hull.rootNode, hit[0], hit[1], hit[2]) === CONTENTS_SOLID) {
      backoff -= 0.1
      if (backoff < 0) {
        result.fraction = hitFraction
        return false
      }
      hitFraction = startFraction + (endFraction - startFraction) * backoff
      for (let i = 0; i < 3; i++) hit[i] = p1[i] + backoff * (p2[i] - p1[i])
    }

    result.fraction = hitFraction
    return false
  }

  recurse(hull.rootNode, 0, 1, from, to)
  return result
}
