/**
 * Renders a still frame of the replay without a GPU.
 *
 * It drives the real camera rig, map geometry and studio skinning, then
 * rasterises the result into a PNG. That makes it possible to verify the
 * third-person view — coordinate conversion, camera placement, model posing —
 * from the command line or CI, where WebGL is not available.
 *
 *   node --experimental-strip-types scripts/render-preview.mjs [--time 600] [--player 3] [--out preview.png]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { parseBsp } from '../src/bsp/parser.ts'
import { buildHull, traceLine } from '../src/bsp/trace.ts'
import { threeToQuake } from '../src/render/coords.ts'
import { buildMapScene } from '../src/bsp/scene.ts'
import { buildStudioModel, StudioInstance } from '../src/mdl/model.ts'
import { parseReplay } from '../src/demo/replay.ts'
import { CameraRig } from '../src/render/cameraRig.ts'
import { samplePlayer, createPose } from '../src/render/players.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const assets = join(root, 'public', 'assets')

const args = process.argv.slice(2)
const option = (flag, fallback) => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : fallback
}

const WIDTH = Number(option('--width', 960))
const HEIGHT = Number(option('--height', 540))
const TIME = Number(option('--time', 600))
const MODE = option('--mode', 'third-person')
const OUT = option('--out', join(root, 'preview.png'))

const demoPath = option('--demo', join(root, 'public', 'demos', 'demo.dem'))
if (!existsSync(demoPath)) {
  console.error(`No demo at ${demoPath}`)
  process.exit(1)
}

console.log('Decoding demo…')
const replay = parseReplay(new Uint8Array(readFileSync(demoPath)))

const bspPath = join(assets, 'maps', `${replay.mapName}.bsp`)
if (!existsSync(bspPath)) {
  console.error(`No map at ${bspPath} — run: npm run assets -- --map ${replay.mapName}`)
  process.exit(1)
}

console.log('Building map…')
const bspBytes = new Uint8Array(readFileSync(bspPath))
const map = buildMapScene(parseBsp(bspBytes))
const hull = buildHull(bspBytes)
map.root.updateMatrixWorld(true)

// Pick a player who is actually in the world at this timestamp.
const pose = createPose()
const requested = option('--player', null)
let subject = null
for (const player of replay.players) {
  if (requested !== null && String(player.slot) !== requested) continue
  samplePlayer(player, TIME, pose)
  if (pose.present) {
    subject = player
    break
  }
}
if (!subject) {
  console.error(`No player is present at t=${TIME}s`)
  process.exit(1)
}
samplePlayer(subject, TIME, pose)
const quakeOrigin = threeToQuake(pose.position.x, pose.position.y, pose.position.z)
console.log(
  `Following ${subject.name} at t=${TIME}s — map origin (${quakeOrigin.map((v) => v.toFixed(0)).join(', ')}) yaw ${pose.yaw.toFixed(0)}°`
)

const rig = new CameraRig(WIDTH / HEIGHT)
rig.mode = MODE
rig.smoothing = 1
if (hull) {
  rig.lineOfSight = (from, to) => {
    const result = traceLine(hull, threeToQuake(from.x, from.y, from.z), threeToQuake(to.x, to.y, to.z))
    return result.startSolid ? 1 : result.fraction
  }
}
rig.update({ position: pose.position.clone(), pitch: pose.pitch, yaw: pose.yaw }, true)
rig.camera.updateMatrixWorld(true)

const viewProjection = new THREE.Matrix4().multiplyMatrices(
  rig.camera.projectionMatrix,
  rig.camera.matrixWorldInverse
)

// --- software rasteriser --------------------------------------------------

const colorBuffer = new Uint8Array(WIDTH * HEIGHT * 3)
const depthBuffer = new Float32Array(WIDTH * HEIGHT).fill(Infinity)
for (let i = 0; i < WIDTH * HEIGHT; i++) {
  colorBuffer[i * 3] = 12
  colorBuffer[i * 3 + 1] = 15
  colorBuffer[i * 3 + 2] = 21
}

const clip = new THREE.Vector4()

/** Projects a world-space point to screen space; returns null when behind the camera. */
function project(x, y, z) {
  clip.set(x, y, z, 1).applyMatrix4(viewProjection)
  if (clip.w <= 0.0001) return null
  const inverseW = 1 / clip.w
  return {
    x: (clip.x * inverseW * 0.5 + 0.5) * WIDTH,
    y: (1 - (clip.y * inverseW * 0.5 + 0.5)) * HEIGHT,
    depth: clip.w
  }
}

function rasterize(a, b, c, r, g, bl) {
  const minX = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)))
  const maxX = Math.min(WIDTH - 1, Math.ceil(Math.max(a.x, b.x, c.x)))
  const minY = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)))
  const maxY = Math.min(HEIGHT - 1, Math.ceil(Math.max(a.y, b.y, c.y)))
  if (minX > maxX || minY > maxY) return

  const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
  if (Math.abs(area) < 1e-9) return

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5
      const py = y + 0.5
      const w0 = ((b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x)) / area
      const w1 = ((c.x - b.x) * (py - b.y) - (c.y - b.y) * (px - b.x)) / area
      const w2 = 1 - w0 - w1
      // Barycentric coverage test, accepting either winding.
      if (w0 < 0 || w1 < 0 || w2 < 0) continue

      const depth = a.depth * w1 + b.depth * w2 + c.depth * w0
      const index = y * WIDTH + x
      if (depth >= depthBuffer[index]) continue
      depthBuffer[index] = depth
      colorBuffer[index * 3] = r
      colorBuffer[index * 3 + 1] = g
      colorBuffer[index * 3 + 2] = bl
    }
  }
}

/** Average colour of a texture, used as flat shading for the preview. */
function averageColor(pixels) {
  let r = 0
  let g = 0
  let b = 0
  let n = 0
  for (let i = 0; i < pixels.length; i += 4 * 16) {
    if (pixels[i + 3] === 0) continue
    r += pixels[i]
    g += pixels[i + 1]
    b += pixels[i + 2]
    n++
  }
  return n ? [r / n, g / n, b / n] : [128, 128, 128]
}

console.log('Rasterising map…')
let mapTriangles = 0
map.root.traverse((object) => {
  if (!(object instanceof THREE.Mesh)) return
  const position = object.geometry.getAttribute('position')
  const index = object.geometry.getIndex()
  if (!index) return

  const material = object.material
  const texture = material.uniforms?.diffuseMap?.value
  const [tr, tg, tb] = texture?.image?.data ? averageColor(texture.image.data) : [130, 130, 130]

  for (let i = 0; i < index.count; i += 3) {
    const points = []
    let visible = true
    for (let k = 0; k < 3; k++) {
      const v = index.getX(i + k)
      const p = project(position.getX(v), position.getY(v), position.getZ(v))
      if (!p) {
        visible = false
        break
      }
      points.push(p)
    }
    if (!visible) continue

    // Cheap facing-based shading so surfaces are distinguishable.
    const shade = 0.55 + 0.45 * Math.min(1, 900 / Math.max(points[0].depth, 1))
    rasterize(points[0], points[1], points[2], tr * shade, tg * shade, tb * shade)
    mapTriangles++
  }
})
console.log(`  ${mapTriangles.toLocaleString()} map triangles drawn`)

// --- players --------------------------------------------------------------

const modelCache = new Map()
function loadModel(path) {
  if (!modelCache.has(path)) {
    const file = join(assets, path)
    modelCache.set(path, existsSync(file) ? buildStudioModel(new Uint8Array(readFileSync(file))) : null)
  }
  return modelCache.get(path)
}

const QUAKE_TO_THREE = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2)
const UP_Z = new THREE.Vector3(0, 0, 1)

console.log('Rasterising players…')
let playerTriangles = 0
let drawnPlayers = 0

for (const player of replay.players) {
  const p = createPose()
  samplePlayer(player, TIME, p)
  if (!p.present) continue
  if (MODE === 'eye' && player.slot === subject.slot) continue

  const modelPath = replay.models.get(p.modelIndex)
  const data = modelPath ? loadModel(modelPath) : null
  if (!data) continue

  const instance = new StudioInstance(data)
  const sequences = instance.sequenceInfo
  const sequence = Math.max(0, Math.min(Math.round(p.sequence), sequences.length - 1))
  const frameCount = sequences[sequence]?.frameCount ?? 1
  instance.applyPose(sequence, (p.frame / 256) * Math.max(frameCount - 1, 0), 0, 0)

  const holder = new THREE.Group()
  holder.position.copy(p.position)
  holder.quaternion.copy(QUAKE_TO_THREE).clone()
  holder.quaternion
    .copy(QUAKE_TO_THREE)
    .multiply(new THREE.Quaternion().setFromAxisAngle(UP_Z, THREE.MathUtils.degToRad(p.yaw)))
  holder.add(instance.root)
  holder.updateMatrixWorld(true)

  // CPU skinning: studio vertices live in their bone's local frame.
  const geometry = data.geometry
  const position = geometry.getAttribute('position')
  const skinIndex = geometry.getAttribute('skinIndex')
  const bones = instance.mesh.skeleton.bones
  const world = new THREE.Vector3()
  const screen = []
  for (let v = 0; v < position.count; v++) {
    const bone = bones[skinIndex.getX(v)]
    world.set(position.getX(v), position.getY(v), position.getZ(v))
    if (bone) world.applyMatrix4(bone.matrixWorld)
    screen.push(project(world.x, world.y, world.z))
  }

  const isSubject = player.slot === subject.slot
  const tint = isSubject ? [255, 210, 90] : [225, 120, 70]
  for (let i = 0; i + 2 < position.count; i += 3) {
    const a = screen[i]
    const b = screen[i + 1]
    const c = screen[i + 2]
    if (!a || !b || !c) continue
    rasterize(a, b, c, tint[0], tint[1], tint[2])
    playerTriangles++
  }
  drawnPlayers++
}
console.log(`  ${drawnPlayers} players, ${playerTriangles.toLocaleString()} triangles drawn`)

// --- PNG ------------------------------------------------------------------

function writePng(path, width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0 // filter type: none
    Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3).copy(
      raw,
      y * (width * 3 + 1) + 1
    )
  }

  const chunk = (type, data) => {
    const out = Buffer.alloc(data.length + 12)
    out.writeUInt32BE(data.length, 0)
    out.write(type, 4, 'latin1')
    data.copy(out, 8)
    out.writeInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
    return out
  }

  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 2 // colour type: truecolour

  writeFileSync(
    path,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0))
    ])
  )
}

let crcTable = null
function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c
    }
  }
  let crc = -1
  for (let i = 0; i < buffer.length; i++) crc = crcTable[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)
  return crc ^ -1
}

writePng(OUT, WIDTH, HEIGHT, colorBuffer)
console.log(`\nWrote ${OUT}`)
