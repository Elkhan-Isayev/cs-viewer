import * as THREE from 'three'
import { buildMapScene, type BuiltMap } from '../bsp/scene.ts'
import { parseBsp } from '../bsp/parser.ts'
import { buildHull, traceLine, type Hull } from '../bsp/trace.ts'
import { threeToQuake } from './coords.ts'
import { buildSkybox, loadSkyFaces, type Skybox } from './skybox.ts'
import type { Replay, ReplayPlayer } from '../demo/replay.ts'
import { CameraRig, type CameraMode } from './cameraRig.ts'
import { createPose, ModelLibrary, PlayerActor, samplePlayer, type PlayerPose } from './players.ts'
import { ReplayAudio } from './audio.ts'

export interface ViewerOptions {
  canvas: HTMLCanvasElement
  assetBaseUrl: string
  volume: number
}

/**
 * How long the followed player may be missing before the camera moves on.
 * Long enough to ride out the gap between rounds and the odd dropped snapshot,
 * short enough that a death does not leave you staring at an empty street.
 */
const FOLLOW_GRACE = 1.5

/**
 * Renders a parsed replay: the map, the players, and a camera that can chase
 * any of them in third person.
 */
export class Viewer {
  readonly scene = new THREE.Scene()
  readonly rig: CameraRig
  private readonly renderer: THREE.WebGLRenderer
  private readonly library: ModelLibrary
  private readonly actors = new Map<number, PlayerActor>()
  private readonly pose: PlayerPose = createPose()
  private map: BuiltMap | null = null
  private sky: Skybox | null = null
  private hull: Hull | null = null
  private replay: Replay | null = null
  readonly audio: ReplayAudio

  /** Slot of the player the camera follows, or null for a free look. */
  followSlot: number | null = null
  showNameTags = true
  /** Called when the viewer picks a different player on its own. */
  onFollowChange: ((slot: number) => void) | null = null

  /** Replay time at which the followed player went missing, if they have. */
  private followAbsentSince: number | null = null
  /** Round-robin position for per-player relighting. */
  private relightCursor = 0
  private readonly lightScratch = new THREE.Color()

  private lastFrameAt = performance.now()
  private running = false
  private readonly options: ViewerOptions

  constructor(options: ViewerOptions) {
    this.options = options
    this.renderer = new THREE.WebGLRenderer({
      canvas: options.canvas,
      antialias: true,
      powerPreference: 'high-performance'
    })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.outputColorSpace = THREE.SRGBColorSpace

    this.scene.background = new THREE.Color(0x0b0e13)
    this.scene.fog = new THREE.Fog(0x0b0e13, 3000, 9000)

    // Players are tinted by the map's own lightmap where they stand, so these
    // only shape the model — they must average out near 1, or the baked light
    // is multiplied twice and every figure blows out to white.
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.75))
    const key = new THREE.DirectionalLight(0xffffff, 0.5)
    key.position.set(0.4, 1, 0.25)
    this.scene.add(key)

    this.library = new ModelLibrary(options.assetBaseUrl)
    this.audio = new ReplayAudio({ baseUrl: options.assetBaseUrl, volume: options.volume })
    this.rig = new CameraRig(this.aspect)
    this.resize()
  }

  private get aspect(): number {
    const { clientWidth, clientHeight } = this.options.canvas
    return clientHeight > 0 ? clientWidth / clientHeight : 1
  }

  resize(): void {
    const canvas = this.options.canvas
    const width = canvas.clientWidth
    const height = canvas.clientHeight
    if (width === 0 || height === 0) return
    this.renderer.setSize(width, height, false)
    this.rig.resize(width / height)
  }

  async loadMap(mapName: string): Promise<void> {
    const response = await fetch(`${this.options.assetBaseUrl}/maps/${mapName}.bsp`)
    if (!response.ok) {
      throw new Error(
        `Map "${mapName}" is not in public/assets/maps. Run: npm run assets -- --map ${mapName}`
      )
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    const bsp = parseBsp(bytes)

    this.map?.dispose()
    this.map = buildMapScene(bsp)
    this.scene.add(this.map.root)

    // The BSP's sky faces are skipped, so without a backdrop outdoor areas
    // would show flat background where the sky should be.
    this.sky?.dispose()
    this.sky = null
    const skyName = bsp.entities.find((entity) => entity.skyname)?.skyname
    if (skyName) {
      const faces = await loadSkyFaces(this.options.assetBaseUrl, skyName)
      if (faces) {
        this.sky = buildSkybox(faces)
        if (this.sky) this.scene.add(this.sky.mesh)
        else console.warn(`Skybox "${skyName}" could not be decoded`)
      } else {
        console.warn(`Skybox "${skyName}" is not in the extracted assets; run npm run assets`)
      }
    }

    this.hull = buildHull(bytes)
    this.rig.lineOfSight = this.hull
      ? (from, to) => {
          const start = threeToQuake(from.x, from.y, from.z)
          const end = threeToQuake(to.x, to.y, to.z)
          const result = traceLine(this.hull!, start, end)
          // Starting inside solid means the player is clipped into geometry;
          // pulling the camera all the way in would be worse than leaving it.
          return result.startSolid ? 1 : result.fraction
        }
      : null

    // Start the free camera somewhere sensible in case nobody is followed.
    const centre = this.map.bounds.getCenter(new THREE.Vector3())
    this.rig.freePosition.copy(centre).add(new THREE.Vector3(0, 400, 0))
  }

  setReplay(replay: Replay): void {
    for (const actor of this.actors.values()) {
      this.scene.remove(actor.root)
      actor.dispose()
    }
    this.actors.clear()

    this.replay = replay
    for (const player of replay.players) {
      const actor = new PlayerActor(player, this.library, replay)
      this.actors.set(player.slot, actor)
      this.scene.add(actor.root)
    }
    this.followSlot ??= replay.players[0]?.slot ?? null
    this.audio.setReplay(replay.sounds, 0)
  }

  /** Points the camera at a player, cutting rather than sweeping to them. */
  setFollow(slot: number | null): void {
    if (slot === this.followSlot) return
    this.followSlot = slot
    this.followAbsentSince = null
    this.rig.reframe()
  }

  setMode(mode: CameraMode): void {
    if (mode === 'free' && this.rig.mode !== 'free') this.rig.detach()
    this.rig.mode = mode
  }

  setBrightness(value: number): void {
    this.map?.setBrightness(value)
  }

  /**
   * Relights one player per frame, round-robin.
   *
   * Each sample is a raycast against the whole map, so doing all fourteen every
   * frame would cost more than drawing them. Spread out, a full team refreshes
   * several times a second — far quicker than anyone crosses a shadow.
   */
  private relightOnePlayer(present: number[]): void {
    if (!this.map || present.length === 0) return
    this.relightCursor = (this.relightCursor + 1) % present.length
    const actor = this.actors.get(present[this.relightCursor])
    if (!actor) return

    const light = this.map.sampleLight(actor.root.position, this.lightScratch)
    // Nothing underneath — mid-jump, or over a gap. Keep the last value rather
    // than flashing the model to black.
    if (!light) return
    actor.setLight(light)
  }

  /**
   * Chooses who to watch when the followed player is gone. Staying on their
   * team keeps the thread of the round; failing that, anyone still alive.
   */
  private pickSubstitute(present: number[], time: number): number | null {
    if (present.length === 0) return null

    const previous = this.followSlot !== null ? this.actors.get(this.followSlot) : undefined
    const wantedTeam = previous ? previous.teamAtTime(time, -1) : 0

    let fallback: number | null = null
    const scratch = createPose()
    for (const slot of present) {
      const actor = this.actors.get(slot)
      if (!actor) continue
      fallback ??= slot
      const pose = samplePlayer(actor.player, time, scratch)
      if (actor.teamAtTime(time, pose.modelIndex) === wantedTeam) return slot
    }
    return fallback
  }

  /** Players present in the world at `time`, for the scoreboard. */
  presentPlayers(time: number): { player: ReplayPlayer; team: number }[] {
    if (!this.replay) return []
    const out: { player: ReplayPlayer; team: number }[] = []
    for (const actor of this.actors.values()) {
      const pose = samplePlayer(actor.player, time, createPose())
      if (!pose.present) continue
      out.push({ player: actor.player, team: actor.teamAtTime(time, pose.modelIndex) })
    }
    return out
  }

  /** Draws one frame at replay time `time`. */
  render(time: number): void {
    const now = performance.now()
    const delta = Math.min((now - this.lastFrameAt) / 1000, 0.1)
    this.lastFrameAt = now

    let followTarget: { position: THREE.Vector3; pitch: number; yaw: number } | null = null
    const present: number[] = []

    for (const [slot, actor] of this.actors) {
      const pose = samplePlayer(actor.player, time, this.pose)
      actor.update(pose, delta)
      actor.updateLabel(this.rig.camera, this.showNameTags && slot !== this.followSlot)
      if (pose.present) present.push(slot)

      if (slot === this.followSlot && pose.present) {
        followTarget = {
          position: pose.position.clone(),
          pitch: pose.pitch,
          yaw: pose.yaw
        }
      }
    }

    // Players spend a lot of a match out of the world — dead, spectating, or
    // between rounds — and a camera bolted to one of them would spend just as
    // long looking at nothing. Move to someone still playing.
    if (followTarget) {
      this.followAbsentSince = null
    } else if (this.followSlot !== null && present.length > 0) {
      this.followAbsentSince ??= time
      // Compared with `abs` so that scrubbing backwards counts as a jump too.
      const gone = Math.abs(time - this.followAbsentSince)
      if (gone > FOLLOW_GRACE || !this.rig.framed) {
        const next = this.pickSubstitute(present, time)
        const actor = next === null ? undefined : this.actors.get(next)
        if (actor && next !== null && next !== this.followSlot) {
          this.followSlot = next
          this.followAbsentSince = null
          const pose = samplePlayer(actor.player, time, this.pose)
          followTarget = { position: pose.position.clone(), pitch: pose.pitch, yaw: pose.yaw }
          // Cut rather than sweep across the map to the new subject.
          this.rig.reframe()
          this.onFollowChange?.(next)
        }
      }
    }

    this.relightOnePlayer(present)

    // In eye mode the followed player's own model would fill the screen.
    const followed = this.followSlot !== null ? this.actors.get(this.followSlot) : undefined
    if (followed) followed.root.visible = followed.root.visible && this.rig.mode !== 'eye'

    this.rig.update(followTarget)
    // Keep the backdrop centred on the camera so it never moves relative to it.
    if (this.sky) this.sky.mesh.position.copy(this.rig.camera.position)
    this.renderer.render(this.scene, this.rig.camera)

    // After the render, so the camera's world matrix is the one just drawn
    // from. Cues attached to a player carry no coordinates, so they are
    // placed at wherever that player is standing this frame.
    this.audio.update(time, this.rig.camera, (entity) => {
      const actor = this.actors.get(entity)
      return actor && actor.root.visible ? actor.root.position : null
    })
  }

  start(getTime: () => number): void {
    if (this.running) return
    this.running = true
    const loop = () => {
      if (!this.running) return
      this.render(getTime())
      requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
  }

  stop(): void {
    this.running = false
  }

  dispose(): void {
    this.stop()
    this.map?.dispose()
    this.sky?.dispose()
    for (const actor of this.actors.values()) actor.dispose()
    this.audio.dispose()
    this.renderer.dispose()
  }
}
