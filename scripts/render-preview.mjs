/**
 * Renders a still frame of a replay without a GPU.
 *
 * It drives the real camera rig, map geometry, lightmaps and studio skinning,
 * then rasterises the result into a PNG — perspective-correct, textured, and
 * lit the same way the WebGL shader lights it. That makes the third-person
 * view verifiable from a terminal or CI, where WebGL is not available.
 *
 *   node --experimental-strip-types scripts/render-preview.mjs \
 *        [--time 2400] [--player 7] [--mode third-person] [--out preview.png]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { parseBsp } from '../src/bsp/parser.ts'
import { buildMapScene } from '../src/bsp/scene.ts'
import { buildHull, traceLine } from '../src/bsp/trace.ts'
import { buildStudioModel, StudioInstance } from '../src/mdl/model.ts'
import { parseReplay } from '../src/demo/replay.ts'
import { CameraRig } from '../src/render/cameraRig.ts'
import { samplePlayer, createPose } from '../src/render/players.ts'
import { threeToQuake } from '../src/render/coords.ts'
import { buildSkybox } from '../src/render/skybox.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const assets = join(root, 'public', 'assets')

const args = process.argv.slice(2)
const option = (flag, fallback) => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : fallback
}

const WIDTH = Number(option('--width', 1280))
const HEIGHT = Number(option('--height', 720))
const TIME = Number(option('--time', 2400))
const MODE = option('--mode', 'third-person')
const DISTANCE = Number(option('--distance', 0)) || null
const ORBIT = Number(option('--orbit', 0))
const OUT = option('--out', join(root, 'preview.png'))
const BRIGHTNESS = Number(option('--brightness', 1.1))
/** Tints the followed player, to make it obvious who the camera is on. */
const HIGHLIGHT = args.includes('--highlight')

const demoPath = option('--demo', join(root, 'public', 'demos', 'demo.dem'))
if (!existsSync(demoPath)) {
  console.error(`No demo at ${demoPath} — run: npm run sample`)
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
if (DISTANCE) rig.distance = DISTANCE
rig.orbitYaw = ORBIT
if (hull) {
  rig.lineOfSight = (from, to) => {
    const result = traceLine(hull, threeToQuake(from.x, from.y, from.z), threeToQuake(to.x, to.y, to.z))
    return result.startSolid ? 1 : result.fraction
  }
}
// Free mode can be aimed explicitly, which is how sky and framing get checked.
if (MODE === 'free') {
  const at = option('--at', null)
  rig.freePosition.copy(pose.position)
  if (at) {
    const [x, y, z] = at.split(',').map(Number)
    rig.freePosition.set(x, y, z)
  }
  rig.freePosition.y += Number(option('--height-offset', 60))
  rig.freeYaw = THREE.MathUtils.degToRad(Number(option('--yaw', 0)))
  rig.freePitch = THREE.MathUtils.degToRad(Number(option('--pitch', 0)))
}
rig.update({ position: pose.position.clone(), pitch: pose.pitch, yaw: pose.yaw }, true)
rig.camera.updateMatrixWorld(true)

const viewProjection = new THREE.Matrix4().multiplyMatrices(
  rig.camera.projectionMatrix,
  rig.camera.matrixWorldInverse
)

// --- framebuffer ----------------------------------------------------------

const pixels = new Float32Array(WIDTH * HEIGHT * 3)
const depth = new Float32Array(WIDTH * HEIGHT).fill(Infinity)
for (let i = 0; i < WIDTH * HEIGHT; i++) {
  pixels[i * 3] = 0.02
  pixels[i * 3 + 1] = 0.025
  pixels[i * 3 + 2] = 0.035
}

// three treats textures as sRGB and does the maths in linear space; matching
// that is what makes this look like the real render rather than a washed-out
// approximation.
const SRGB_TO_LINEAR = new Float32Array(256)
for (let i = 0; i < 256; i++) {
  const c = i / 255
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}
const linearToSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055)

/** Wrapping nearest-neighbour fetch from a three.js DataTexture. */
function sampler(texture) {
  const image = texture?.image
  if (!image?.data) return null
  const { data, width, height } = image
  return (u, v, out) => {
    let x = Math.floor(u * width) % width
    let y = Math.floor(v * height) % height
    if (x < 0) x += width
    if (y < 0) y += height
    const at = (y * width + x) * 4
    out[0] = SRGB_TO_LINEAR[data[at]]
    out[1] = SRGB_TO_LINEAR[data[at + 1]]
    out[2] = SRGB_TO_LINEAR[data[at + 2]]
    out[3] = data[at + 3] / 255
    return out
  }
}

const scratchClip = new THREE.Vector4()
const NEAR_W = 0.05

/** Transforms a world point into clip space. */
function toClip(x, y, z) {
  scratchClip.set(x, y, z, 1).applyMatrix4(viewProjection)
  return { x: scratchClip.x, y: scratchClip.y, z: scratchClip.z, w: scratchClip.w }
}

/** Perspective divide to pixel coordinates. */
function toScreen(c) {
  const invW = 1 / c.w
  return {
    x: (c.x * invW * 0.5 + 0.5) * WIDTH,
    y: (1 - (c.y * invW * 0.5 + 0.5)) * HEIGHT,
    invW
  }
}

const ATTRIBUTE_SIZE = 5

function lerpVertex(a, b, t) {
  const attr = new Float32Array(ATTRIBUTE_SIZE)
  for (let i = 0; i < ATTRIBUTE_SIZE; i++) attr[i] = a.attr[i] + (b.attr[i] - a.attr[i]) * t
  return {
    clip: {
      x: a.clip.x + (b.clip.x - a.clip.x) * t,
      y: a.clip.y + (b.clip.y - a.clip.y) * t,
      z: a.clip.z + (b.clip.z - a.clip.z) * t,
      w: a.clip.w + (b.clip.w - a.clip.w) * t
    },
    attr
  }
}

/**
 * Clips a triangle against the near plane and rasterises what survives.
 *
 * Without this, any triangle with a vertex behind the camera is dropped
 * whole — which punches holes in nearby walls and makes a camera-centred
 * skybox disappear entirely.
 */
function emitTriangle(vertices, diffuse, lightmap, tint, depthOverride) {
  let polygon = vertices
  const inside = polygon.filter((v) => v.clip.w >= NEAR_W)
  if (inside.length === 0) return 0
  if (inside.length !== polygon.length) {
    const clipped = []
    for (let i = 0; i < polygon.length; i++) {
      const current = polygon[i]
      const next = polygon[(i + 1) % polygon.length]
      const currentIn = current.clip.w >= NEAR_W
      const nextIn = next.clip.w >= NEAR_W
      if (currentIn) clipped.push(current)
      if (currentIn !== nextIn) {
        const t = (NEAR_W - current.clip.w) / (next.clip.w - current.clip.w)
        clipped.push(lerpVertex(current, next, t))
      }
    }
    polygon = clipped
    if (polygon.length < 3) return 0
  }

  const screen = polygon.map((v) => toScreen(v.clip))
  let drawn = 0
  for (let i = 1; i < polygon.length - 1; i++) {
    fillTriangle(
      screen[0], screen[i], screen[i + 1],
      polygon[0].attr, polygon[i].attr, polygon[i + 1].attr,
      diffuse, lightmap, tint, depthOverride
    )
    drawn++
  }
  return drawn
}

const albedo = new Float32Array(4)
const light = new Float32Array(4)

/**
 * Fills one triangle. `attributes` holds per-vertex [u, v, lu, lv, shade];
 * everything is interpolated with a 1/w weight so textures do not swim.
 */
function fillTriangle(p0, p1, p2, a0, a1, a2, diffuse, lightmap, tint, depthOverride) {
  const minX = Math.max(0, Math.floor(Math.min(p0.x, p1.x, p2.x)))
  const maxX = Math.min(WIDTH - 1, Math.ceil(Math.max(p0.x, p1.x, p2.x)))
  const minY = Math.max(0, Math.floor(Math.min(p0.y, p1.y, p2.y)))
  const maxY = Math.min(HEIGHT - 1, Math.ceil(Math.max(p0.y, p1.y, p2.y)))
  if (minX > maxX || minY > maxY) return

  const area = (p1.x - p0.x) * (p2.y - p0.y) - (p1.y - p0.y) * (p2.x - p0.x)
  if (Math.abs(area) < 1e-9) return
  const inverseArea = 1 / area

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5
      const py = y + 0.5
      let w0 = ((p1.x - px) * (p2.y - py) - (p1.y - py) * (p2.x - px)) * inverseArea
      let w1 = ((p2.x - px) * (p0.y - py) - (p2.y - py) * (p0.x - px)) * inverseArea
      let w2 = 1 - w0 - w1
      // Accept either winding: demos are viewed from both sides of a face.
      if (w0 < 0 || w1 < 0 || w2 < 0) {
        if (w0 > 0 || w1 > 0 || w2 > 0) continue
        w0 = -w0
        w1 = -w1
        w2 = -w2
        const sum = w0 + w1 + w2
        w0 /= sum
        w1 /= sum
        w2 /= sum
      }

      const invW = w0 * p0.invW + w1 * p1.invW + w2 * p2.invW
      const z = depthOverride ?? 1 / invW
      const index = y * WIDTH + x
      if (z >= depth[index]) continue

      const b0 = (w0 * p0.invW) / invW
      const b1 = (w1 * p1.invW) / invW
      const b2 = (w2 * p2.invW) / invW

      const u = a0[0] * b0 + a1[0] * b1 + a2[0] * b2
      const v = a0[1] * b0 + a1[1] * b1 + a2[1] * b2
      if (!diffuse) continue
      diffuse(u, v, albedo)
      if (albedo[3] < 0.5) continue // masked texture

      let r = albedo[0]
      let g = albedo[1]
      let b = albedo[2]

      if (lightmap) {
        const lu = a0[2] * b0 + a1[2] * b1 + a2[2] * b2
        const lv = a0[3] * b0 + a1[3] * b1 + a2[3] * b2
        lightmap(lu, lv, light)
        // The world shader multiplies by the lightmap with GoldSrc's overbright.
        r *= light[0] * 2 * BRIGHTNESS
        g *= light[1] * 2 * BRIGHTNESS
        b *= light[2] * 2 * BRIGHTNESS
      } else {
        const shade = a0[4] * b0 + a1[4] * b1 + a2[4] * b2
        r *= shade
        g *= shade
        b *= shade
      }

      if (tint) {
        r = r * 0.55 + tint[0] * 0.45 * (r + 0.15)
        g = g * 0.55 + tint[1] * 0.45 * (g + 0.15)
        b = b * 0.55 + tint[2] * 0.45 * (b + 0.15)
      }

      depth[index] = z
      pixels[index * 3] = r
      pixels[index * 3 + 1] = g
      pixels[index * 3 + 2] = b
    }
  }
}

// --- skybox ---------------------------------------------------------------
// Drawn first at an effectively infinite depth, so real geometry overwrites it.

const bspEntities = parseBsp(bspBytes).entities
const skyName = bspEntities.find((entity) => entity.skyname)?.skyname
if (skyName) {
  const faces = {}
  for (const side of ['rt', 'lf', 'ft', 'bk', 'up', 'dn']) {
    for (const extension of ['tga', 'bmp']) {
      const file = join(assets, 'env', `${skyName}${side}.${extension}`)
      if (existsSync(file)) {
        faces[side] = new Uint8Array(readFileSync(file))
        break
      }
    }
  }
  const sky = Object.keys(faces).length === 6 ? buildSkybox(faces) : null
  if (sky) {
    sky.mesh.position.copy(rig.camera.position)
    sky.mesh.updateMatrixWorld(true)

    const geometry = sky.mesh.geometry
    const position = geometry.getAttribute('position')
    const uv = geometry.getAttribute('uv')
    const index = geometry.getIndex()
    const world = new THREE.Vector3()
    let skyTriangles = 0

    for (const group of geometry.groups) {
      const diffuse = sampler(sky.mesh.material[group.materialIndex]?.map)
      if (!diffuse) continue
      for (let i = group.start; i + 2 < group.start + group.count; i += 3) {
        const vertices = []
        for (let k = 0; k < 3; k++) {
          const v = index.getX(i + k)
          world.set(position.getX(v), position.getY(v), position.getZ(v)).applyMatrix4(sky.mesh.matrixWorld)
          const attr = new Float32Array(5)
          attr[0] = uv.getX(v)
          attr[1] = uv.getY(v)
          attr[4] = 1
          vertices.push({ clip: toClip(world.x, world.y, world.z), attr })
        }
        skyTriangles += emitTriangle(vertices, diffuse, null, null, 1e9)
      }
    }
    console.log(`Skybox "${skyName}": ${skyTriangles} triangles`)
  } else {
    console.log(`Skybox "${skyName}": not available`)
  }
}

// --- map ------------------------------------------------------------------

console.log('Rasterising map…')
let mapTriangles = 0
map.root.traverse((object) => {
  if (!(object instanceof THREE.Mesh)) return
  const geometry = object.geometry
  const position = geometry.getAttribute('position')
  const uv = geometry.getAttribute('uv')
  const lightmapUv = geometry.getAttribute('lightmapUv')
  const index = geometry.getIndex()
  if (!index || !uv || !lightmapUv) return

  const diffuse = sampler(object.material.uniforms?.diffuseMap?.value)
  const lightmap = sampler(object.material.uniforms?.lightmap?.value)
  if (!diffuse) return

  for (let i = 0; i < index.count; i += 3) {
    const vertices = []
    for (let k = 0; k < 3; k++) {
      const v = index.getX(i + k)
      const attr = new Float32Array(5)
      attr[0] = uv.getX(v)
      attr[1] = uv.getY(v)
      attr[2] = lightmapUv.getX(v)
      attr[3] = lightmapUv.getY(v)
      vertices.push({ clip: toClip(position.getX(v), position.getY(v), position.getZ(v)), attr })
    }
    mapTriangles += emitTriangle(vertices, diffuse, lightmap, null, null)
  }
})
console.log(`  ${mapTriangles.toLocaleString()} map triangles`)

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
const KEY_LIGHT = new THREE.Vector3(0.4, 1, 0.25).normalize()

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
  const BLEND = option('--blend', null)
  // Drive the gait the way the viewer does. There is no accumulated phase in a
  // still, so derive one from the timestamp: distance covered by now, over the
  // ground one cycle of the sequence carries.
  const gaitSequence = Math.max(0, Math.min(Math.round(p.gaitSequence), sequences.length - 1))
  const gait = sequences[gaitSequence]
  const stride = gait?.linearMovement?.[0] ?? 0
  const gaitFrames = gait?.frameCount ?? 1
  const phase = stride > 1 ? ((TIME * p.speed) / stride) * gaitFrames : TIME * (gait?.fps ?? 0)
  const gaitFrame = gaitFrames > 1 ? ((phase % gaitFrames) + gaitFrames) % gaitFrames : 0
  instance.applyPose(
    sequence,
    (p.frame / 256) * Math.max(frameCount - 1, 0),
    gaitSequence,
    gaitFrame,
    BLEND === null ? Math.min(Math.max((p.pitch - (sequences[sequence]?.blendStart ?? -90)) / ((sequences[sequence]?.blendEnd ?? 90) - (sequences[sequence]?.blendStart ?? -90)), 0), 1) : Number(BLEND)
  )

  // The weapon in hand: a `p_*.mdl` posed by bone-merging onto the player.
  const weaponPath = replay.models.get(p.weaponModelIndex)
  const weaponData = weaponPath?.includes('/p_') ? loadModel(weaponPath) : null
  const weapon = weaponData ? new StudioInstance(weaponData) : null
  if (weapon) weapon.followSkeleton(instance)

  const holder = new THREE.Group()
  holder.position.copy(p.position)
  // The body faces where the player is walking, not where they are looking.
  const bodyYaw = p.speed > 12 ? p.moveYaw : p.yaw
  holder.quaternion
    .copy(QUAKE_TO_THREE)
    .multiply(new THREE.Quaternion().setFromAxisAngle(UP_Z, THREE.MathUtils.degToRad(bodyYaw)))
  holder.add(instance.root)
  if (weapon) holder.add(weapon.root)
  holder.updateMatrixWorld(true)

  // Match the browser: models take the baked light of the floor beneath them.
  const lit = map.sampleLight(p.position, new THREE.Color())
  const light = lit ? [lit.r, lit.g, lit.b] : [1, 1, 1]
  const tint = HIGHLIGHT && player.slot === subject.slot ? [1.0, 0.78, 0.3] : light
  playerTriangles += rasteriseStudio(data, instance, tint)
  if (weapon && weaponData) playerTriangles += rasteriseStudio(weaponData, weapon, tint)
  drawnPlayers++
}
console.log(`  ${drawnPlayers} players, ${playerTriangles.toLocaleString()} triangles`)

/** CPU-skins one studio instance and rasterises it. Returns triangles drawn. */
function rasteriseStudio(data, instance, tint) {
  let drawn = 0
  const geometry = data.geometry
  const position = geometry.getAttribute('position')
  const normal = geometry.getAttribute('normal')
  const uv = geometry.getAttribute('uv')
  const skinIndex = geometry.getAttribute('skinIndex')
  const bones = instance.mesh.skeleton.bones

  const world = new THREE.Vector3()
  const worldNormal = new THREE.Vector3()
  const clips = new Array(position.count)
  const shades = new Float32Array(position.count)

  for (let v = 0; v < position.count; v++) {
    const bone = bones[skinIndex.getX(v)]
    world.set(position.getX(v), position.getY(v), position.getZ(v))
    worldNormal.set(normal.getX(v), normal.getY(v), normal.getZ(v))
    if (bone) {
      world.applyMatrix4(bone.matrixWorld)
      worldNormal.transformDirection(bone.matrixWorld)
    }
    clips[v] = toClip(world.x, world.y, world.z)
    // Matches the scene's ambient + single directional light.
    shades[v] = 0.75 + 0.5 * Math.max(worldNormal.dot(KEY_LIGHT), 0)
  }

  const groups = geometry.groups.length
    ? geometry.groups
    : [{ start: 0, count: position.count, materialIndex: 0 }]

  for (const group of groups) {
    const material = data.materials[group.materialIndex] ?? data.materials[0]
    const diffuse = sampler(material?.map)
    if (!diffuse) continue

    for (let i = group.start; i + 2 < group.start + group.count; i += 3) {
      const vertices = []
      for (let k = 0; k < 3; k++) {
        const attr = new Float32Array(5)
        attr[0] = uv.getX(i + k)
        attr[1] = uv.getY(i + k)
        attr[4] = shades[i + k]
        vertices.push({ clip: clips[i + k], attr })
      }
      drawn += emitTriangle(vertices, diffuse, null, tint, null)
    }
  }
  return drawn
}

// --- PNG ------------------------------------------------------------------

const rgb = new Uint8Array(WIDTH * HEIGHT * 3)
for (let i = 0; i < WIDTH * HEIGHT * 3; i++) {
  rgb[i] = Math.max(0, Math.min(255, Math.round(linearToSrgb(Math.min(pixels[i], 1)) * 255)))
}

/** Lazily built CRC table; declared before use so it is not in the TDZ. */
let crcTable = null

writePng(OUT, WIDTH, HEIGHT, rgb)
console.log(`\nWrote ${OUT}`)

function writePng(path, width, height, data) {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0 // filter type: none
    Buffer.from(data.buffer, data.byteOffset + y * width * 3, width * 3).copy(raw, y * (width * 3 + 1) + 1)
  }

  const chunk = (type, payload) => {
    const out = Buffer.alloc(payload.length + 12)
    out.writeUInt32BE(payload.length, 0)
    out.write(type, 4, 'latin1')
    payload.copy(out, 8)
    out.writeInt32BE(crc32(out.subarray(4, 8 + payload.length)), 8 + payload.length)
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
      chunk('IDAT', deflateSync(raw, { level: 9 })),
      chunk('IEND', Buffer.alloc(0))
    ])
  )
}

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
