import * as THREE from 'three'
import { buildStudioModel, StudioInstance, type StudioModelData } from '../mdl/model.ts'
import {
  PLAYER_STRIDE,
  P_FRAME,
  P_GAIT,
  P_MODEL,
  P_PITCH,
  P_SEQUENCE,
  P_WEAPON_MODEL,
  P_X,
  P_Y,
  P_YAW,
  P_Z,
  TEAM_CT,
  TEAM_T,
  teamAt,
  type Replay,
  type ReplayPlayer
} from '../demo/replay.ts'
import { quakeToVector } from './coords.ts'

/** Longest gap between samples before a player counts as absent (dead/disconnected). */
const PRESENCE_TIMEOUT = 0.6

export const TEAM_COLORS: Record<number, number> = {
  [TEAM_T]: 0xe6683c,
  [TEAM_CT]: 0x4f9ad6,
  0: 0xaaaaaa
}

/** Maps Quake's Z-up axes onto the scene's Y-up axes. */
const QUAKE_TO_THREE = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2)
const UP_Z = new THREE.Vector3(0, 0, 1)
const SPIN = new THREE.Quaternion()

/** Model folder names that belong to the Terrorist side. */
const T_MODELS = new Set(['terror', 'leet', 'arctic', 'guerilla'])

export interface PlayerPose {
  present: boolean
  position: THREE.Vector3
  pitch: number
  yaw: number
  /** Horizontal speed in units per second, used to drive the walk cycle. */
  speed: number
  sequence: number
  frame: number
  gaitSequence: number
  modelIndex: number
  weaponModelIndex: number
}

/**
 * Samples a player's track at `time`, interpolating position and angles
 * between the two surrounding snapshots.
 */
export function samplePlayer(player: ReplayPlayer, time: number, out: PlayerPose): PlayerPose {
  const track = player.track
  const index = track.indexAt(time)
  out.present = false
  if (index < 0 || track.count === 0) return out

  const t0 = track.times[index]
  // A long gap means the player left the world rather than stood still.
  if (time - t0 > PRESENCE_TIMEOUT) return out

  const base = index * PLAYER_STRIDE
  const hasNext = index + 1 < track.count
  const t1 = hasNext ? track.times[index + 1] : t0
  const span = t1 - t0
  const alpha = hasNext && span > 1e-6 ? Math.min((time - t0) / span, 1) : 0
  const next = (index + 1) * PLAYER_STRIDE

  const lerp = (component: number): number => {
    const a = track.data[base + component]
    if (!hasNext) return a
    return a + (track.data[next + component] - a) * alpha
  }

  const x = lerp(P_X)
  const y = lerp(P_Y)
  const z = lerp(P_Z)
  quakeToVector(x, y, z, out.position)

  out.pitch = track.data[base + P_PITCH]
  out.yaw = lerpAngle(
    track.data[base + P_YAW],
    hasNext ? track.data[next + P_YAW] : track.data[base + P_YAW],
    alpha
  )

  if (hasNext && span > 1e-6) {
    const dx = track.data[next + P_X] - track.data[base + P_X]
    const dy = track.data[next + P_Y] - track.data[base + P_Y]
    out.speed = Math.hypot(dx, dy) / span
  } else {
    out.speed = 0
  }

  out.sequence = track.data[base + P_SEQUENCE]
  out.frame = track.data[base + P_FRAME]
  out.gaitSequence = track.data[base + P_GAIT]
  out.modelIndex = track.data[base + P_MODEL]
  out.weaponModelIndex = track.data[base + P_WEAPON_MODEL]
  out.present = true
  return out
}

/** Interpolates angles the short way around the circle. */
function lerpAngle(a: number, b: number, alpha: number): number {
  let delta = ((b - a + 540) % 360) - 180
  return a + delta * alpha
}

export function createPose(): PlayerPose {
  return {
    present: false,
    position: new THREE.Vector3(),
    pitch: 0,
    yaw: 0,
    speed: 0,
    sequence: 0,
    frame: 0,
    gaitSequence: 0,
    modelIndex: 0,
    weaponModelIndex: 0
  }
}

/** Loads and caches studio models, keyed by asset path. */
export class ModelLibrary {
  private readonly cache = new Map<string, Promise<StudioModelData | null>>()
  private readonly baseUrl: string

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl
  }

  load(path: string): Promise<StudioModelData | null> {
    let pending = this.cache.get(path)
    if (!pending) {
      pending = fetch(`${this.baseUrl}/${path}`)
        .then((response) => (response.ok ? response.arrayBuffer() : Promise.reject(new Error(String(response.status)))))
        .then((buffer) => buildStudioModel(new Uint8Array(buffer)))
        .catch((error) => {
          console.warn(`Could not load model ${path}:`, error.message)
          return null
        })
      this.cache.set(path, pending)
    }
    return pending
  }
}

/**
 * One rendered player: a studio instance plus a name tag, kept in sync with
 * the replay's sampled pose.
 */
export class PlayerActor {
  readonly root = new THREE.Group()
  private instance: StudioInstance | null = null
  private currentModelPath = ''
  private readonly label: THREE.Sprite
  /** Accumulated walk-cycle phase, advanced by how fast the player is moving. */
  private gaitPhase = 0
  private readonly fallback: THREE.Mesh

  readonly player: ReplayPlayer
  private readonly library: ModelLibrary
  private readonly replay: Replay

  constructor(player: ReplayPlayer, library: ModelLibrary, replay: Replay) {
    this.player = player
    this.library = library
    this.replay = replay
    this.label = createNameTag(player.name, TEAM_COLORS[player.team] ?? TEAM_COLORS[0])
    this.label.position.set(0, 80, 0)
    this.root.add(this.label)

    // Shown until the real model arrives, and if it never does.
    this.fallback = new THREE.Mesh(
      new THREE.CapsuleGeometry(16, 40, 4, 8),
      new THREE.MeshLambertMaterial({ color: TEAM_COLORS[player.team] ?? TEAM_COLORS[0] })
    )
    this.fallback.position.y = 36
    this.root.add(this.fallback)
    this.root.visible = false
  }

  /** Team at `time`, preferring the model actually worn in that frame. */
  teamAtTime(time: number, modelIndex: number): number {
    const path = this.replay.models.get(modelIndex)
    if (path) {
      const folder = path.split('/').slice(-2, -1)[0]
      if (folder) return T_MODELS.has(folder) ? TEAM_T : TEAM_CT
    }
    return teamAt(this.player, time)
  }

  update(pose: PlayerPose, delta: number): void {
    this.root.visible = pose.present
    if (!pose.present) return

    this.root.position.copy(pose.position)
    // Studio models are authored in Quake space (Z-up, facing +X). Rotate about
    // the model's own Z by the yaw, then map Quake axes onto the Y-up scene.
    SPIN.setFromAxisAngle(UP_Z, THREE.MathUtils.degToRad(pose.yaw))
    this.root.quaternion.copy(QUAKE_TO_THREE).multiply(SPIN)

    this.ensureModel(pose.modelIndex)

    const instance = this.instance
    if (!instance) return

    // The gait cycle is not transmitted; drive it from ground speed so walking
    // and running read correctly.
    this.gaitPhase += delta * (pose.speed / 100) * 12
    const studio = this.studioFrames(instance, pose)
    instance.applyPose(studio.sequence, studio.frame, studio.gaitSequence, studio.gaitFrame)
  }

  private studioFrames(
    instance: StudioInstance,
    pose: PlayerPose
  ): { sequence: number; frame: number; gaitSequence: number; gaitFrame: number } {
    const sequences = instance.sequenceInfo
    const sequence = Math.max(0, Math.min(Math.round(pose.sequence), sequences.length - 1))
    const gaitSequence = Math.max(0, Math.min(Math.round(pose.gaitSequence), sequences.length - 1))

    // The engine transmits `frame` as 0..255 across the whole sequence.
    const frameCount = sequences[sequence]?.frameCount ?? 1
    const frame = (pose.frame / 256) * Math.max(frameCount - 1, 0)

    const gaitFrameCount = sequences[gaitSequence]?.frameCount ?? 1
    const gaitFrame = gaitFrameCount > 1 ? ((this.gaitPhase % gaitFrameCount) + gaitFrameCount) % gaitFrameCount : 0

    return { sequence, frame, gaitSequence, gaitFrame }
  }

  private ensureModel(modelIndex: number): void {
    const path = this.replay.models.get(modelIndex)
    if (!path || path === this.currentModelPath) return
    this.currentModelPath = path

    void this.library.load(path).then((data) => {
      if (!data || this.currentModelPath !== path) return
      if (this.instance) {
        this.root.remove(this.instance.root)
        this.instance.dispose()
      }
      this.instance = new StudioInstance(data)
      this.root.add(this.instance.root)
      this.fallback.visible = false
    })
  }

  setLabelVisible(visible: boolean): void {
    this.label.visible = visible
  }

  dispose(): void {
    this.instance?.dispose()
    this.fallback.geometry.dispose()
    ;(this.fallback.material as THREE.Material).dispose()
    this.label.material.map?.dispose()
    this.label.material.dispose()
  }
}

function createNameTag(text: string, color: number): THREE.Sprite {
  const canvas = document.createElement('canvas')
  const scale = 2
  const context = canvas.getContext('2d')!
  context.font = `${14 * scale}px system-ui, sans-serif`
  const width = Math.ceil(context.measureText(text).width) + 16 * scale
  canvas.width = width
  canvas.height = 24 * scale

  const ctx = canvas.getContext('2d')!
  ctx.font = `${14 * scale}px system-ui, sans-serif`
  ctx.textBaseline = 'middle'
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`
  ctx.fillText(text, 8 * scale, canvas.height / 2)

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true })
  )
  sprite.scale.set(canvas.width / scale, canvas.height / scale, 1)
  sprite.renderOrder = 10
  return sprite
}
