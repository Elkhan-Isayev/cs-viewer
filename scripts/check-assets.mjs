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

  // Every face is drawn double-sided because Quake winds a front face
  // clockwise, the opposite of OpenGL. If this reverts to FrontSide, culling
  // silently eats surfaces and the map fills with holes.
  let singleSided = 0
  built.root.traverse((object) => {
    if (object instanceof THREE.Mesh && object.material.side !== THREE.DoubleSide) singleSided++
  })
  check('world faces are drawn from both sides', singleSided === 0, `${singleSided} single-sided batches`)

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
  const { parseReplay, PLAYER_STRIDE, P_PITCH } = await import('../src/demo/replay.ts')
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

  // Players drop out of the world constantly — dead, spectating, between
  // rounds. A null target used to fall through to the free camera's parked
  // position, teleporting the view into whatever the map centre happens to be.
  rig.mode = 'third-person'
  rig.freePosition.set(9999, 9999, 9999)
  const held = rig.camera.position.clone()
  rig.update(null)
  check(
    'camera holds position when the followed player leaves the world',
    rig.camera.position.distanceTo(held) < 1e-6,
    `stayed at ${held.toArray().map((n) => n.toFixed(0)).join(', ')}`
  )

  // How often that actually happens, so the substitution logic is not
  // guarding against a hypothetical.
  let absent = 0
  const checkpoints = 200
  for (let i = 0; i < checkpoints; i++) {
    const t = (replay.duration * i) / checkpoints
    if (!samplePlayer(replay.players[0], t, pose).present) absent++
  }
  check(
    'the default subject really does leave the world',
    absent > 0,
    `absent at ${absent}/${checkpoints} sampled times`
  )

  // HL stores `pev->angles[0] = -v_angle[0] / 3`, so the wire value is a third
  // of the real view pitch and inverted. Recovered, it must reach real angles.
  let steepest = 0
  for (const player of replay.players) {
    for (let i = 0; i < player.track.count; i += 97) {
      steepest = Math.max(steepest, Math.abs(player.track.data[i * PLAYER_STRIDE + P_PITCH]))
    }
  }
  check(
    'view pitch is recovered to a real range',
    steepest > 60 && steepest <= 90,
    `steepest ${steepest.toFixed(1)}° (a third of it would be ${(steepest / 3).toFixed(1)}°)`
  )

  // The weapon a player holds is bone-merged onto their arm, so its hand bone
  // has to land on the player's hand bone rather than at the model origin.
  const read = (p) => buildStudioModel(new Uint8Array(readFileSync(join(assets, p))))
  const body = new StudioInstance(read('models/player/terror/terror.mdl'))
  const gun = new StudioInstance(read('models/p_m4a1.mdl'))

  body.applyPose(19, 12, 0, 0)
  gun.followSkeleton(body)
  body.root.updateMatrixWorld(true)
  gun.root.updateMatrixWorld(true)

  const hand = new THREE.Vector3().setFromMatrixPosition(body.boneByName.get('Bip01 R Hand').matrixWorld)
  const grip = new THREE.Vector3().setFromMatrixPosition(gun.boneByName.get('Bip01 R Hand').matrixWorld)
  check(
    'the weapon rides the player’s hand bone',
    hand.distanceTo(grip) < 0.01 && hand.length() > 1,
    `hand at ${hand.toArray().map((n) => n.toFixed(1)).join(', ')}, grip ${hand.distanceTo(grip).toFixed(4)} away`
  )

  // A muzzle locator is the weapon's own bone, so it must be posed from the
  // weapon and end up somewhere out in front of the hand, not stuck on it.
  const flash = new THREE.Vector3().setFromMatrixPosition(gun.boneByName.get('flash').matrixWorld)
  check(
    'the weapon keeps its own unshared bones',
    flash.distanceTo(grip) > 1,
    `muzzle sits ${flash.distanceTo(grip).toFixed(1)} units from the grip`
  )

  // Players are lit by the lightmap of the floor under them, which needs a
  // downward raycast to land. Backface culling used to swallow every one of
  // these, leaving all fourteen players lit by a constant.
  // A player's aim sequences carry a blend axis for where they are looking.
  // Reading only the first blend — as this used to — poses every torso at one
  // extreme of it, which is a permanently hunched, twisted figure.
  console.log('\naim blending against demo.dem')
  const terror = parseMdl(new Uint8Array(readFileSync(join(assets, 'models/player/terror/terror.mdl'))))
  const aim = terror.sequences.filter((s) => s.label.startsWith('ref_aim_'))
  check(
    'aim sequences span a blend axis',
    aim.length > 0 && aim.every((s) => s.blendCount > 1),
    `${aim.length} aim sequences, ${aim[0]?.blendCount} blends each`
  )

  const { P_BLEND } = await import('../src/demo/replay.ts')
  let levelish = 0, blendSamples = 0
  const steepDown = [], steepUp = []
  for (const player of replay.players) {
    for (let i = 0; i < player.track.count; i += 7) {
      const blend = player.track.data[i * PLAYER_STRIDE + P_BLEND]
      const pitch = player.track.data[i * PLAYER_STRIDE + P_PITCH]
      blendSamples++
      if (Math.abs(blend - 128) < 32) levelish++
      if (pitch > 25) steepDown.push(blend)
      else if (pitch < -25) steepUp.push(blend)
    }
  }
  const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length
  check(
    'the blend axis centres on a level aim',
    levelish / blendSamples > 0.3,
    `${((100 * levelish) / blendSamples).toFixed(0)}% of samples sit near 128 of 255`
  )
  // Pins which end of the axis is which: blend 0 is aiming fully up.
  check(
    'looking down runs up the blend axis',
    steepDown.length > 0 && steepUp.length > 0 && avg(steepDown) > avg(steepUp),
    `down ${avg(steepDown).toFixed(0)} vs up ${avg(steepUp).toFixed(0)} of 255`
  )

  // Anyone still unassigned at a round start has no `modelindex` yet, and
  // without a fallback spends that time as a coloured capsule.
  const named = replay.players.filter((p) => p.model)
  check(
    'players name a model in their userinfo',
    named.length === replay.players.length,
    `${named.length}/${replay.players.length}, e.g. "${replay.players[0].model}"`
  )
  const missingFallback = [...new Set(named.map((p) => p.model))].filter(
    (m) => !existsSync(join(assets, 'models', 'player', m, `${m}.mdl`))
  )
  check(
    'every userinfo model is on disk',
    missingFallback.length === 0,
    missingFallback.length ? missingFallback.join(', ') : 'all fallbacks resolve'
  )

  console.log('\nlighting against demo.dem')
  const built = buildMapScene(parseBsp(new Uint8Array(readFileSync(join(assets, 'maps', `${replay.mapName}.bsp`)))))
  built.root.updateMatrixWorld(true)
  const colour = new THREE.Color()
  const levels = []
  let noFloor = 0
  for (let t = 60; t < 3000; t += 17) {
    for (const player of replay.players) {
      if (!samplePlayer(player, t, pose).present) continue
      const lit = built.sampleLight(pose.position, colour)
      if (!lit) { noFloor++; continue }
      levels.push((lit.r + lit.g + lit.b) / 3)
    }
  }
  check(
    'the floor is found beneath players',
    noFloor / (levels.length + noFloor) < 0.05,
    `${noFloor} of ${levels.length + noFloor} samples had nothing below`
  )
  levels.sort((a, b) => a - b)
  const spread = levels[Math.floor(levels.length * 0.95)] - levels[Math.floor(levels.length * 0.05)]
  check(
    'light varies between sun and shade',
    spread > 0.3,
    `p05 ${levels[Math.floor(levels.length * 0.05)].toFixed(2)} to p95 ${levels[Math.floor(levels.length * 0.95)].toFixed(2)}`
  )
  built.dispose()

  // Orbiting must not reach straight down: overhead puts the camera through
  // the ceiling of every covered street and lays standing players on their side.
  rig.mode = 'third-person'
  for (let i = 0; i < 200; i++) rig.orbit(0, -0.1)
  check('orbit stops short of overhead', rig.orbitPitch <= 1.0 + 1e-9, `clamped at ${rig.orbitPitch.toFixed(2)} rad`)

  console.log('\nsound against demo.dem')
  const cues = replay.sounds
  check('the demo yields sound cues', cues.length > 1000, `${cues.length} cues`)
  check(
    'cues are in playback order',
    cues.every((cue, i) => i === 0 || cues[i - 1].time <= cue.time),
    'the audio engine walks them with a cursor'
  )

  // Gunfire comes from events, everything else from svc_sound. Both have to
  // resolve to a file that is actually served, or it is silent in practice.
  const cueSamples = [...new Set(cues.map((cue) => cue.path))]
  const unserved = cueSamples.filter((path) => !existsSync(join(assets, 'sound', path)))
  check(
    'every referenced sample is on disk',
    unserved.length === 0,
    unserved.length ? unserved.slice(0, 5).join(', ') : `${cueSamples.length} distinct samples`
  )

  const gunfire = cues.filter((cue) => !cue.origin)
  check('weapon events resolve to a fire sound', gunfire.length > 1000, `${gunfire.length} shots`)

  // The shooter is the entity at `packetIndex` in the packet just sent. If that
  // reconstruction drifts, gunfire detaches and plays from the wrong place —
  // which is silent failure, so pin the agreement rate down.
  const fired = /^weapons\/([a-z0-9]+?)(_unsil)?-?\d?\.wav$/
  const bySlot = new Map(replay.players.map((p) => [p.slot, p]))
  let attributed = 0
  for (const cue of gunfire) {
    const match = fired.exec(cue.path)
    const player = match && bySlot.get(cue.entity)
    if (!player) continue
    samplePlayer(player, cue.time, pose)
    if ((replay.models.get(pose.weaponModelIndex) ?? '').includes(match[1])) attributed++
  }
  const rate = (100 * attributed) / gunfire.length
  check(
    'gunfire is attributed to the player holding that weapon',
    rate > 75,
    `${rate.toFixed(1)}% — reading packetIndex as an entity number scores 21%`
  )

  // Positioning falls back to the emitting player, so a cue with neither an
  // origin nor a resolvable entity plays flat and out of place.
  let placeable = 0
  for (const cue of cues) {
    if (cue.origin) { placeable++; continue }
    const player = bySlot.get(cue.entity)
    if (player && samplePlayer(player, cue.time, pose).present) placeable++
  }
  check(
    'cues can be placed in the world',
    placeable / cues.length > 0.95,
    `${((100 * placeable) / cues.length).toFixed(1)}% positioned`
  )
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
