/**
 * Headless smoke test for the rendering pipeline: parses the extracted map and
 * player models, builds the same geometry the browser would, and asserts the
 * results are sane. Catches format bugs without needing a GPU.
 *
 *   node --experimental-strip-types scripts/check-assets.mjs
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { parseBsp } from '../src/bsp/parser.ts'
import { buildMapScene } from '../src/bsp/scene.ts'
import { parseMdl } from '../src/mdl/parser.ts'
import { buildStudioModel, StudioInstance } from '../src/mdl/model.ts'

const assets = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'assets')
let failures = 0

const check = (label, condition, detail = '') => {
  if (condition) {
    console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
    failures++
  }
}

const allFinite = (array) => {
  for (let i = 0; i < array.length; i++) if (!Number.isFinite(array[i])) return false
  return true
}

// --- maps -----------------------------------------------------------------
const mapsDir = join(assets, 'maps')
for (const file of existsSync(mapsDir) ? readdirSync(mapsDir).filter((f) => f.endsWith('.bsp')) : []) {
  console.log(`\n${file}`)
  const bsp = parseBsp(new Uint8Array(readFileSync(join(mapsDir, file))))
  check('faces', bsp.faces.length > 1000, `${bsp.faces.length}`)
  check('textures', bsp.textures.length > 0, `${bsp.textures.length}`)
  check('texinfo', bsp.texInfo.length > 0, `${bsp.texInfo.length}`)
  check('models', bsp.models.length > 0, `${bsp.models.length} brush models`)
  check('entities', bsp.entities.length > 0, `${bsp.entities.length}`)

  const decoded = bsp.textures.filter((t) => t.pixels)
  check('textures decoded', decoded.length > 0, `${decoded.length}/${bsp.textures.length}`)

  const built = buildMapScene(bsp)
  let triangles = 0
  let meshes = 0
  built.root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return
    meshes++
    triangles += (object.geometry.getIndex()?.count ?? 0) / 3
    const position = object.geometry.getAttribute('position')
    if (!allFinite(position.array)) {
      check(`${object.name} positions finite`, false)
    }
  })
  check('meshes built', meshes > 0, `${meshes} draw batches`)
  check('triangles built', triangles > 5000, `${triangles.toLocaleString()} triangles`)

  const size = built.bounds.getSize(new THREE.Vector3())
  check(
    'bounds plausible',
    size.x > 500 && size.y > 100 && size.z > 500 && size.x < 20000,
    `${size.x.toFixed(0)} x ${size.y.toFixed(0)} x ${size.z.toFixed(0)} units`
  )
  built.dispose()
}

// --- player models --------------------------------------------------------
const playersDir = join(assets, 'models', 'player')
for (const folder of existsSync(playersDir) ? readdirSync(playersDir) : []) {
  const file = join(playersDir, folder, `${folder}.mdl`)
  if (!existsSync(file)) continue
  console.log(`\n${folder}.mdl`)
  const bytes = new Uint8Array(readFileSync(file))

  const mdl = parseMdl(bytes)
  check('bones', mdl.bones.length > 10, `${mdl.bones.length}`)
  check('sequences', mdl.sequences.length > 10, `${mdl.sequences.length}`)
  check('textures', mdl.textures.length > 0, `${mdl.textures.length}`)
  check('body parts', mdl.bodyParts.length > 0, `${mdl.bodyParts.length}`)
  check(
    'has a spine bone (gait split)',
    mdl.bones.some((b) => b.name === 'Bip01 Spine'),
    mdl.bones.slice(0, 3).map((b) => b.name).join(', ') + ' …'
  )

  const data = buildStudioModel(bytes)
  const position = data.geometry.getAttribute('position')
  const skinIndex = data.geometry.getAttribute('skinIndex')
  check('vertices', position.count > 500, `${position.count}`)
  check('positions finite', allFinite(position.array))
  check('materials', data.materials.length > 0, `${data.materials.length}`)
  check('geometry groups', data.geometry.groups.length > 0, `${data.geometry.groups.length}`)

  let maxBone = 0
  for (let i = 0; i < skinIndex.count; i++) maxBone = Math.max(maxBone, skinIndex.getX(i))
  check('bone indices in range', maxBone < mdl.bones.length, `max ${maxBone} < ${mdl.bones.length}`)

  // Pose the skeleton across several sequences and make sure nothing degenerates.
  const instance = new StudioInstance(data)
  let bad = 0
  for (const sequence of [0, 1, 3, 6, 10]) {
    const info = mdl.sequences[sequence]
    if (!info) continue
    for (const frame of [0, Math.floor(info.frameCount / 2), Math.max(info.frameCount - 1, 0)]) {
      instance.applyPose(sequence, frame, 1, frame)
      instance.root.updateMatrixWorld(true)
      instance.mesh.skeleton.update()
      for (const matrix of instance.mesh.skeleton.boneMatrices) {
        if (!Number.isFinite(matrix)) bad++
      }
    }
  }
  check('skeleton poses finite', bad === 0, bad ? `${bad} bad matrix entries` : 'all sequences sampled')

  const totalFrames = mdl.sequences.reduce((sum, s) => sum + s.frameCount, 0)
  check('animation data present', totalFrames > 50, `${totalFrames} frames across all sequences`)
}

// --- camera / replay integration -----------------------------------------
const demo = join(assets, '..', 'demos', 'demo.dem')
if (existsSync(demo)) {
  console.log('\ncamera against demo.dem')
  const { parseReplay } = await import('../src/demo/replay.ts')
  const { samplePlayer, createPose } = await import('../src/render/players.ts')
  const { CameraRig } = await import('../src/render/cameraRig.ts')
  const { anglesToForward } = await import('../src/render/coords.ts')

  const replay = parseReplay(new Uint8Array(readFileSync(demo)))
  check('replay has players', replay.players.length > 0, `${replay.players.length}`)

  const rig = new CameraRig(16 / 9)
  rig.smoothing = 1 // no easing, so one update settles fully
  const pose = createPose()
  let behind = 0
  let samples = 0

  for (const player of replay.players.slice(0, 6)) {
    for (const fraction of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      samplePlayer(player, replay.duration * fraction, pose)
      if (!pose.present) continue
      samples++

      rig.update({ position: pose.position.clone(), pitch: pose.pitch, yaw: pose.yaw }, true)

      // The camera should sit opposite the way the player is facing.
      const forward = anglesToForward(0, pose.yaw)
      const toCamera = rig.camera.position.clone().sub(pose.position).setY(0).normalize()
      if (forward.dot(toCamera) < -0.5) behind++
    }
  }
  check('third-person camera sits behind the player', samples > 0 && behind === samples, `${behind}/${samples} samples`)

  // In eye mode the camera must look the same way the player is aiming.
  let aligned = 0
  let eyeSamples = 0
  rig.mode = 'eye'
  for (const player of replay.players.slice(0, 6)) {
    samplePlayer(player, replay.duration * 0.5, pose)
    if (!pose.present) continue
    eyeSamples++
    rig.update({ position: pose.position.clone(), pitch: pose.pitch, yaw: pose.yaw }, true)
    const look = new THREE.Vector3()
    rig.camera.getWorldDirection(look)
    if (look.setY(0).normalize().dot(anglesToForward(0, pose.yaw)) > 0.99) aligned++
  }
  check('eye camera looks where the player aims', eyeSamples > 0 && aligned === eyeSamples, `${aligned}/${eyeSamples} samples`)
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
