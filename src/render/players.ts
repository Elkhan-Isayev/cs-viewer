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

/** Height above the player's origin that the name tag floats at. */
const TAG_HEIGHT = 82
/**
 * Share of the viewport's height one tag occupies, held constant with
 * distance. Sized in world units instead, a tag is unreadably small across the
 * map and swallows the screen when the camera is close.
 */
const TAG_SCREEN_FRACTION = 0.022
/** Past this the tag is clutter rather than information. */
const TAG_MAX_DISTANCE = 2600

/** Below this the player counts as standing still and the body faces their aim. */
const GAIT_MOVING_SPEED = 12
/** How fast the body swings round to the direction of travel, per second. */
const GAIT_TURN_RATE = 8

export interface PlayerPose {
  present: boolean
  position: THREE.Vector3
  pitch: number
  yaw: number
  /** Horizontal speed in units per second, used to drive the walk cycle. */
  speed: number
  /** Direction of travel in degrees, meaningful only while `speed` is non-zero. */
  moveYaw: number
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

  out.pitch = lerpWrapped(
    track.data[base + P_PITCH],
    hasNext ? track.data[next + P_PITCH] : track.data[base + P_PITCH],
    alpha,
    360
  )
  out.yaw = lerpWrapped(
    track.data[base + P_YAW],
    hasNext ? track.data[next + P_YAW] : track.data[base + P_YAW],
    alpha,
    360
  )

  if (hasNext && span > 1e-6) {
    const dx = track.data[next + P_X] - track.data[base + P_X]
    const dy = track.data[next + P_Y] - track.data[base + P_Y]
    out.speed = Math.hypot(dx, dy) / span
    // Quake yaw 0 faces +X, and the track is still in Quake coordinates here.
    out.moveYaw = out.speed > 1e-3 ? THREE.MathUtils.radToDeg(Math.atan2(dy, dx)) : out.yaw
  } else {
    out.speed = 0
    out.moveYaw = out.yaw
  }

  out.sequence = track.data[base + P_SEQUENCE]
  // `frame` is a 0..255 phase that wraps as the clip loops, and the engine only
  // samples it ~10 times a second. Taken raw it reads as a random pose every
  // snapshot; interpolated the short way round the cycle it becomes the smooth
  // animation it actually is. A sequence change breaks the continuity, so hold
  // the current phase rather than sweeping across an unrelated clip.
  const sequenceHeld = !hasNext || track.data[next + P_SEQUENCE] === track.data[base + P_SEQUENCE]
  out.frame = sequenceHeld
    ? lerpWrapped(track.data[base + P_FRAME], hasNext ? track.data[next + P_FRAME] : track.data[base + P_FRAME], alpha, 256)
    : track.data[base + P_FRAME]
  out.gaitSequence = track.data[base + P_GAIT]
  out.modelIndex = track.data[base + P_MODEL]
  out.weaponModelIndex = track.data[base + P_WEAPON_MODEL]
  out.present = true
  return out
}

/** Signed difference from `a` to `b` in degrees, taking the short way round. */
function shortestAngle(a: number, b: number): number {
  return ((b - a + 540) % 360) - 180
}

/**
 * Interpolates a cyclic quantity the short way round, so a value crossing the
 * wrap point eases through it instead of spinning the long way back.
 * `period` is 360 for angles and 256 for the engine's animation phase.
 */
function lerpWrapped(a: number, b: number, alpha: number, period: number): number {
  const half = period / 2
  const delta = ((b - a + half + period) % period) - half
  return a + delta * alpha
}

export function createPose(): PlayerPose {
  return {
    present: false,
    position: new THREE.Vector3(),
    pitch: 0,
    yaw: 0,
    speed: 0,
    moveYaw: 0,
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
  /** Positioned, never rotated — so the name tag stays overhead. */
  readonly root = new THREE.Group()
  /** Carries the Quake-to-scene rotation and the player's yaw. */
  private readonly body = new THREE.Group()
  private instance: StudioInstance | null = null
  private currentModelPath = ''
  private weapon: StudioInstance | null = null
  private currentWeaponPath = ''
  private readonly label: THREE.Sprite
  /** Canvas size of the tag, in pixels, for the constant-size maths. */
  private readonly labelPixels: { width: number; height: number }
  /** Accumulated walk-cycle phase, advanced by the ground the player covers. */
  private gaitPhase = 0
  /** Direction the body faces, which lags the view while moving. */
  private gaitYaw = 0
  /** Bone-controller dials, slots 0..3 being the torso twist. */
  private readonly controllers = [0.5, 0.5, 0.5, 0.5]
  private readonly fallback: THREE.Mesh

  readonly player: ReplayPlayer
  private readonly library: ModelLibrary
  private readonly replay: Replay

  constructor(player: ReplayPlayer, library: ModelLibrary, replay: Replay) {
    this.player = player
    this.library = library
    this.replay = replay
    this.root.add(this.body)

    this.label = createNameTag(player.name, TEAM_COLORS[player.team] ?? TEAM_COLORS[0])
    this.labelPixels = { width: this.label.scale.x, height: this.label.scale.y }
    // On `root`, not `body`: the tag must hang above the player's head rather
    // than swing around them as they turn.
    this.label.position.set(0, TAG_HEIGHT, 0)
    this.root.add(this.label)

    // Shown until a model arrives, and if none ever does. Centred on the
    // origin, not raised: a player's origin is the middle of their hull, and
    // the studio model straddles it too — measured at -36.8..26.4 in its own
    // frame. Sitting it 36 higher left a capsule floating a body above the
    // ground.
    this.fallback = new THREE.Mesh(
      new THREE.CapsuleGeometry(14, 34, 4, 8),
      new THREE.MeshLambertMaterial({ color: TEAM_COLORS[player.team] ?? TEAM_COLORS[0] })
    )
    this.root.add(this.fallback)
    this.root.visible = false
  }

  /**
   * The model named in the player's connect-time userinfo.
   *
   * Used when the entity's `modelindex` has not arrived yet, which happens for
   * anyone still unassigned at the start of a round. Without it they spend
   * that time as a coloured capsule.
   */
  private userinfoModel(): string | null {
    const name = this.player.model
    return name ? `models/player/${name}/${name}.mdl` : null
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
    const gaitYaw = this.updateGaitYaw(pose, delta)
    // Studio models are authored in Quake space (Z-up, facing +X). Rotate about
    // the model's own Z by the gait yaw, then map Quake axes onto the Y-up
    // scene. The gait yaw, not the view yaw: the body follows where the player
    // is walking, and only their aim follows where they are looking.
    SPIN.setFromAxisAngle(UP_Z, THREE.MathUtils.degToRad(gaitYaw))
    this.body.quaternion.copy(QUAKE_TO_THREE).multiply(SPIN)

    this.ensureModel(pose.modelIndex)

    const instance = this.instance
    if (!instance) return

    const studio = this.studioFrames(instance, pose)
    this.advanceGait(instance, studio.gaitSequence, pose.speed, delta)
    instance.applyPose(
      studio.sequence,
      studio.frame,
      studio.gaitSequence,
      studio.gaitFrame,
      studio.blend,
      this.controllers
    )

    // The gun must be posed after the player, since it rides those bones.
    this.ensureWeapon(pose.weaponModelIndex)
    this.weapon?.followSkeleton(instance)
  }

  /**
   * Puts the currently-held weapon in the player's hands. The demo's
   * `weaponmodel` field indexes the precache table and points at a `p_*.mdl`,
   * the third-person model — `w_*.mdl` is the one lying on the ground.
   */
  private ensureWeapon(weaponModelIndex: number): void {
    const path = this.replay.models.get(weaponModelIndex)
    // Knives, grenades mid-throw and the moment after a death all legitimately
    // resolve to nothing; drop whatever was in hand rather than leaving it.
    if (!path || !path.includes('/p_')) {
      if (this.weapon) {
        this.body.remove(this.weapon.root)
        this.weapon.dispose()
        this.weapon = null
      }
      this.currentWeaponPath = ''
      return
    }
    if (path === this.currentWeaponPath) return
    this.currentWeaponPath = path

    void this.library.load(path).then((data) => {
      if (!data || this.currentWeaponPath !== path) return
      if (this.weapon) {
        this.body.remove(this.weapon.root)
        this.weapon.dispose()
      }
      this.weapon = new StudioInstance(data)
      this.body.add(this.weapon.root)
    })
  }

  /**
   * Tracks which way the body faces, the way the engine's `StudioProcessGait`
   * does: standing still it snaps to where the player is looking, and once
   * they move it eases round to the direction they are travelling.
   *
   * Also fills the torso controllers with the difference between the two, so
   * models that carry Half-Life's spine dials twist to keep facing the aim.
   */
  private updateGaitYaw(pose: PlayerPose, delta: number): number {
    if (pose.speed < GAIT_MOVING_SPEED) {
      this.gaitYaw = pose.yaw
    } else {
      const toward = shortestAngle(this.gaitYaw, pose.moveYaw)
      this.gaitYaw += toward * Math.min(delta * GAIT_TURN_RATE, 1)
    }

    // Running backwards would otherwise spin the body to face away from the
    // view. The engine flips the gait by half a turn instead and lets the legs
    // cycle backwards, which keeps the player facing roughly where they aim.
    let twist = shortestAngle(this.gaitYaw, pose.yaw)
    if (twist > 120) {
      this.gaitYaw += 180
      twist -= 180
    } else if (twist < -120) {
      this.gaitYaw -= 180
      twist += 180
    }

    // Slots 0..3 each take a quarter of the twist, over a -30..30 degree range.
    const dial = Math.min(Math.max(twist / 4 + 30, 0), 60) / 60
    this.controllers[0] = dial
    this.controllers[1] = dial
    this.controllers[2] = dial
    this.controllers[3] = dial
    return this.gaitYaw
  }

  /**
   * Advances the walk cycle by the ground actually covered.
   *
   * A gait sequence records how far it carries the model in `linearMovement`,
   * so dividing the distance travelled by it steps the animation exactly in
   * time with the player — walking, running and standing still each read as
   * themselves, and the feet stop sliding over the floor.
   */
  private advanceGait(instance: StudioInstance, gaitSequence: number, speed: number, delta: number): void {
    const sequence = instance.sequenceInfo[gaitSequence]
    if (!sequence || sequence.frameCount < 2) {
      this.gaitPhase = 0
      return
    }
    const stride = sequence.linearMovement?.[0] ?? 0
    if (stride > 1) {
      this.gaitPhase += ((speed * delta) / stride) * sequence.frameCount
    } else if (speed > GAIT_MOVING_SPEED) {
      // An idle-in-place cycle carries no distance; run it at its own rate.
      this.gaitPhase += delta * sequence.fps
    }
  }

  private studioFrames(
    instance: StudioInstance,
    pose: PlayerPose
  ): { sequence: number; frame: number; gaitSequence: number; gaitFrame: number; blend: number } {
    const sequences = instance.sequenceInfo
    const sequence = Math.max(0, Math.min(Math.round(pose.sequence), sequences.length - 1))
    const gaitSequence = Math.max(0, Math.min(Math.round(pose.gaitSequence), sequences.length - 1))

    // The engine transmits `frame` as 0..255 across the whole sequence.
    const frameCount = sequences[sequence]?.frameCount ?? 1
    const frame = (pose.frame / 256) * Math.max(frameCount - 1, 0)

    const gaitFrameCount = sequences[gaitSequence]?.frameCount ?? 1
    const gaitFrame = gaitFrameCount > 1 ? ((this.gaitPhase % gaitFrameCount) + gaitFrameCount) % gaitFrameCount : 0

    // Where along the aim sequence's blend axis this player is looking. The
    // model declares the range that axis spans — -90..90 degrees of pitch for
    // every `ref_aim_*` in the CS player models — so the view pitch maps
    // straight onto it.
    //
    // Not from the entity's `blending[0]`, though it is on the wire and was
    // the obvious candidate: for players the engine never transmits it, the
    // client computes the aim blend locally in `StudioPlayerBlend`. Measured
    // against the recorded view pitch it correlates at 0.02 — no relationship
    // at all — and driving the torso from it doubles a player over while they
    // are looking straight ahead.
    const aim = sequences[sequence]
    const span = aim ? aim.blendEnd - aim.blendStart : 0
    const blend = span > 0.1 ? Math.min(Math.max((pose.pitch - aim.blendStart) / span, 0), 1) : 0.5

    return { sequence, frame, gaitSequence, gaitFrame, blend }
  }

  private ensureModel(modelIndex: number): void {
    const path = this.replay.models.get(modelIndex) ?? this.userinfoModel()
    if (!path || path === this.currentModelPath) return
    this.currentModelPath = path

    void this.library.load(path).then((data) => {
      if (!data || this.currentModelPath !== path) return
      if (this.instance) {
        this.body.remove(this.instance.root)
        this.instance.dispose()
      }
      this.instance = new StudioInstance(data)
      this.body.add(this.instance.root)
      this.fallback.visible = false
    })
  }

  /**
   * Shows the tag, holding it at a fixed size on screen.
   *
   * A sprite is measured in world units, so its apparent size falls off with
   * distance like everything else. Scaling by the height the view spans at the
   * player's distance cancels that out exactly.
   */
  updateLabel(camera: THREE.PerspectiveCamera, visible: boolean): void {
    const distance = camera.position.distanceTo(this.root.position)
    if (!visible || distance > TAG_MAX_DISTANCE) {
      this.label.visible = false
      return
    }
    this.label.visible = true

    const viewHeight = 2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))
    const scale = (TAG_SCREEN_FRACTION * viewHeight) / this.labelPixels.height
    this.label.scale.set(this.labelPixels.width * scale, this.labelPixels.height * scale, 1)
  }

  /** Tints the model by the light where the player is standing. */
  setLight(color: THREE.Color): void {
    this.instance?.setLight(color)
    this.weapon?.setLight(color)
    ;(this.fallback.material as THREE.MeshLambertMaterial).color.copy(color).multiplyScalar(0.9)
  }

  dispose(): void {
    this.instance?.dispose()
    this.weapon?.dispose()
    this.fallback.geometry.dispose()
    ;(this.fallback.material as THREE.Material).dispose()
    this.label.material.map?.dispose()
    this.label.material.dispose()
  }
}

function createNameTag(text: string, color: number): THREE.Sprite {
  // Rendered at 4x and scaled down on screen: the tag is held at a constant
  // fraction of the viewport, so on a tall display it is drawn much larger
  // than the CSS pixel size of the font and a 1x canvas shows every jaggy.
  const scale = 4
  const font = `600 ${14 * scale}px system-ui, -apple-system, "Segoe UI", sans-serif`

  const measure = document.createElement('canvas').getContext('2d')!
  measure.font = font
  const width = Math.ceil(measure.measureText(text).width) + 14 * scale
  const height = 22 * scale

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  ctx.font = font
  ctx.textBaseline = 'middle'

  // A rounded plate rather than a hard rectangle, which at a constant screen
  // size is a large flat block sitting over the match.
  const radius = 6 * scale
  ctx.fillStyle = 'rgba(8, 11, 16, 0.62)'
  ctx.beginPath()
  ctx.roundRect(0, 0, width, height, radius)
  ctx.fill()

  ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`
  ctx.fillText(text, 7 * scale, height / 2)

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.generateMipmaps = true
  texture.anisotropy = 4

  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true }))
  // Carries the canvas size; `updateLabel` rescales it every frame.
  sprite.scale.set(width, height, 1)
  sprite.renderOrder = 10
  return sprite
}
