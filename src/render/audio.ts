import * as THREE from 'three'
import type { SoundEvent } from '../demo/replay.ts'
import { quakeToVector } from './coords.ts'

/**
 * Plays a replay's sounds through WebAudio, positioned in the world.
 *
 * The demo gives an ordered list of cues; playback walks that list in step with
 * the transport, so the audio follows scrubbing and speed changes rather than
 * running on a clock of its own.
 */

/**
 * Distance at which a sound is still at full volume. GoldSrc units are roughly
 * an inch, and its default attenuation reaches about this far before it starts
 * dropping off noticeably.
 */
const REFERENCE_DISTANCE = 180
/** Beyond this a sound contributes nothing and is not worth a node. */
const MAX_DISTANCE = 4000

/**
 * A single entity re-firing the same sample inside this window is ignored.
 * Keyed per entity, not per sample: two players landing a footstep in the same
 * tick are two footsteps and should both be heard from their own directions.
 */
const DEDUPE_WINDOW = 0.05

/**
 * Ceiling on sounds started within {@link DEDUPE_WINDOW}. Round starts stack
 * dozens of identical buy-menu and reload cues on one frame — measured at 35
 * copies of one sample in 50 ms — which is loud enough to clip the output on
 * its own and carries no more information than a few of them do.
 */
const MAX_VOICES_PER_WINDOW = 12

/** Time jump beyond which we assume a seek and drop everything in between. */
const SEEK_THRESHOLD = 1.0

export interface AudioOptions {
  baseUrl: string
  volume: number
}

export class ReplayAudio {
  private readonly context: AudioContext
  private readonly master: GainNode
  private readonly baseUrl: string
  /** Decoded samples, and `null` for ones the server named but we cannot serve. */
  private readonly buffers = new Map<string, AudioBuffer | null>()
  private readonly pending = new Set<string>()

  private cues: SoundEvent[] = []
  /** Index of the next cue to consider; playback is a walk over `cues`. */
  private cursor = 0
  private lastTime = 0
  /** Last emission of each `sample|entity` pair, to collapse retriggers. */
  private readonly lastPlayed = new Map<string, number>()
  /** Start of the window the voice cap is counting over, and its tally. */
  private voiceWindowAt = 0
  private voices = 0

  private readonly scratch = new THREE.Vector3()

  constructor(options: AudioOptions) {
    this.baseUrl = options.baseUrl
    this.context = new AudioContext()
    this.master = this.context.createGain()
    this.master.gain.value = options.volume
    this.master.connect(this.context.destination)
  }

  get volume(): number {
    return this.master.gain.value
  }

  setVolume(value: number): void {
    this.master.gain.value = Math.max(0, Math.min(value, 1))
  }

  /**
   * Browsers start an `AudioContext` suspended until a gesture, so this has to
   * be called from a real click — the widget's play button.
   */
  resume(): void {
    if (this.context.state === 'suspended') void this.context.resume()
  }

  suspend(): void {
    if (this.context.state === 'running') void this.context.suspend()
  }

  setReplay(sounds: SoundEvent[], time: number): void {
    this.cues = sounds
    this.seek(time)
  }

  /** Re-points the cursor after a jump, without playing the skipped cues. */
  seek(time: number): void {
    this.lastTime = time
    this.lastPlayed.clear()
    let low = 0
    let high = this.cues.length
    while (low < high) {
      const mid = (low + high) >> 1
      if (this.cues[mid].time < time) low = mid + 1
      else high = mid
    }
    this.cursor = low
  }

  /**
   * Plays everything between the previous frame and `time`.
   *
   * `positionOf` resolves an entity to where it is right now, since cues
   * attached to a player carry no coordinates of their own.
   */
  update(time: number, camera: THREE.Camera, positionOf: (entity: number) => THREE.Vector3 | null): void {
    if (this.context.state !== 'running') {
      this.lastTime = time
      return
    }

    // Scrubbing, or playing backwards: resync rather than firing a burst of
    // everything that was skipped over.
    if (time < this.lastTime || time - this.lastTime > SEEK_THRESHOLD) {
      this.seek(time)
      return
    }

    this.updateListener(camera)

    while (this.cursor < this.cues.length && this.cues[this.cursor].time <= time) {
      const cue = this.cues[this.cursor++]

      const key = `${cue.path}|${cue.entity}`
      const previous = this.lastPlayed.get(key)
      if (previous !== undefined && cue.time - previous < DEDUPE_WINDOW) continue
      this.lastPlayed.set(key, cue.time)

      if (cue.time - this.voiceWindowAt >= DEDUPE_WINDOW) {
        this.voiceWindowAt = cue.time
        this.voices = 0
      }
      if (++this.voices > MAX_VOICES_PER_WINDOW) continue

      this.play(cue, positionOf)
    }

    // The dedupe keys are per entity and sample, so the map would otherwise
    // grow for the length of the match.
    if (this.lastPlayed.size > 512) {
      for (const [key, at] of this.lastPlayed) {
        if (time - at > DEDUPE_WINDOW) this.lastPlayed.delete(key)
      }
    }

    this.lastTime = time
  }

  private updateListener(camera: THREE.Camera): void {
    const listener = this.context.listener
    camera.getWorldPosition(this.scratch)
    const { x, y, z } = this.scratch
    const forward = camera.getWorldDirection(new THREE.Vector3())
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion)

    // The modern properties are AudioParams; Safari still only has the setters.
    if (listener.positionX) {
      listener.positionX.value = x
      listener.positionY.value = y
      listener.positionZ.value = z
      listener.forwardX.value = forward.x
      listener.forwardY.value = forward.y
      listener.forwardZ.value = forward.z
      listener.upX.value = up.x
      listener.upY.value = up.y
      listener.upZ.value = up.z
    } else {
      listener.setPosition(x, y, z)
      listener.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z)
    }
  }

  private play(cue: SoundEvent, positionOf: (entity: number) => THREE.Vector3 | null): void {
    const buffer = this.buffers.get(cue.path)
    if (buffer === undefined) {
      // Not loaded yet. Fetch it so the next one lands; missing this instance
      // is better than stalling playback on the network.
      void this.load(cue.path)
      return
    }
    if (buffer === null) return

    const where = cue.origin
      ? quakeToVector(cue.origin[0], cue.origin[1], cue.origin[2], new THREE.Vector3())
      : positionOf(cue.entity)

    const source = this.context.createBufferSource()
    source.buffer = buffer
    source.playbackRate.value = cue.pitch

    const gain = this.context.createGain()
    gain.gain.value = cue.volume

    if (where) {
      const panner = this.context.createPanner()
      panner.panningModel = 'equalpower'
      panner.distanceModel = 'inverse'
      panner.refDistance = REFERENCE_DISTANCE
      panner.maxDistance = MAX_DISTANCE
      // As with the listener, Safari only has the deprecated setter.
      if (panner.positionX) {
        panner.positionX.value = where.x
        panner.positionY.value = where.y
        panner.positionZ.value = where.z
      } else {
        panner.setPosition(where.x, where.y, where.z)
      }
      source.connect(gain).connect(panner).connect(this.master)
    } else {
      // No position: the world speaking, so play it flat.
      source.connect(gain).connect(this.master)
    }

    source.start()
  }

  private async load(path: string): Promise<void> {
    if (this.pending.has(path)) return
    this.pending.add(path)
    try {
      const response = await fetch(`${this.baseUrl}/sound/${path}`)
      if (!response.ok) throw new Error(String(response.status))
      this.buffers.set(path, await this.context.decodeAudioData(await response.arrayBuffer()))
    } catch {
      // Remember the failure: without this a missing sample is re-fetched on
      // every footstep for the rest of the match.
      this.buffers.set(path, null)
    } finally {
      this.pending.delete(path)
    }
  }

  dispose(): void {
    void this.context.close()
  }
}
