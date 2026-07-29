import * as THREE from 'three'
import { PLAYER_VIEW_HEIGHT } from './coords.ts'

/**
 * Returns how far along `from` -> `to` the view stays clear, 0..1.
 * Both points are in Three.js space.
 */
export type LineOfSight = (from: THREE.Vector3, to: THREE.Vector3) => number

/** Closest the chase camera may be pulled in, as a fraction of its distance. */
const MIN_CHASE_FRACTION = 0.3

export type CameraMode = 'third-person' | 'eye' | 'free'

export interface FollowTarget {
  /** Player origin in Three.js space. */
  position: THREE.Vector3
  /** Quake view angles, degrees. */
  pitch: number
  yaw: number
}

/**
 * Drives the camera in three modes:
 *
 * - `third-person` orbits behind the followed player (the default),
 * - `eye` sits at their view height looking down their aim,
 * - `free` is a detached fly camera.
 */
export class CameraRig {
  readonly camera: THREE.PerspectiveCamera
  mode: CameraMode = 'third-person'

  /** Chase distance in world units. */
  distance = 110
  /** Height above the player's origin that the chase camera looks at. */
  shoulderHeight = 50
  /** Extra orbit applied on top of the player's own yaw, in radians. */
  orbitYaw = 0
  orbitPitch = 0.28
  /** Smoothing factor for chase motion; 1 disables smoothing. */
  smoothing = 0.18

  /** Free-camera state. */
  readonly freePosition = new THREE.Vector3()
  freeYaw = 0
  freePitch = 0
  freeSpeed = 600

  /** Keeps the chase camera out of walls; set by the viewer once a map loads. */
  lineOfSight: LineOfSight | null = null

  private readonly smoothedTarget = new THREE.Vector3()
  private readonly desired = new THREE.Vector3()
  private readonly lookAt = new THREE.Vector3()
  private readonly pivot = new THREE.Vector3()
  private initialised = false

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(75, aspect, 4, 12000)
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect
    this.camera.updateProjectionMatrix()
  }

  /** Places the free camera where the chase camera currently is. */
  detach(): void {
    this.freePosition.copy(this.camera.position)
    const forward = new THREE.Vector3()
    this.camera.getWorldDirection(forward)
    this.freeYaw = Math.atan2(-forward.x, -forward.z)
    this.freePitch = Math.asin(THREE.MathUtils.clamp(forward.y, -1, 1))
  }

  /** Moves the free camera along its own axes. `delta` is in seconds. */
  moveFree(forward: number, right: number, up: number, delta: number, boost: boolean): void {
    const speed = this.freeSpeed * delta * (boost ? 3 : 1)
    const sinYaw = Math.sin(this.freeYaw)
    const cosYaw = Math.cos(this.freeYaw)
    const cosPitch = Math.cos(this.freePitch)

    this.freePosition.x += (-sinYaw * cosPitch * forward + cosYaw * right) * speed
    this.freePosition.z += (-cosYaw * cosPitch * forward - sinYaw * right) * speed
    this.freePosition.y += (Math.sin(this.freePitch) * forward + up) * speed
  }

  lookFree(deltaYaw: number, deltaPitch: number): void {
    this.freeYaw -= deltaYaw
    this.freePitch = THREE.MathUtils.clamp(this.freePitch - deltaPitch, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01)
  }

  orbit(deltaYaw: number, deltaPitch: number): void {
    this.orbitYaw -= deltaYaw
    this.orbitPitch = THREE.MathUtils.clamp(this.orbitPitch - deltaPitch, -1.2, 1.35)
  }

  zoom(amount: number): void {
    this.distance = THREE.MathUtils.clamp(this.distance * (1 + amount), 30, 900)
  }

  update(target: FollowTarget | null, instant = false): void {
    if (this.mode === 'free' || !target) {
      this.camera.position.copy(this.freePosition)
      this.camera.rotation.set(0, 0, 0, 'YXZ')
      this.camera.rotateY(this.freeYaw)
      this.camera.rotateX(this.freePitch)
      return
    }

    if (this.mode === 'eye') {
      this.camera.position.copy(target.position)
      this.camera.position.y += PLAYER_VIEW_HEIGHT
      this.camera.rotation.set(0, 0, 0, 'YXZ')
      // Quake yaw 0 faces +X, which is -Z rotated by yaw - 90° in this space.
      this.camera.rotateY(THREE.MathUtils.degToRad(target.yaw) - Math.PI / 2)
      this.camera.rotateX(THREE.MathUtils.degToRad(-target.pitch))
      return
    }

    // Third person: sit behind the player's facing, offset by the manual orbit.
    if (!this.initialised || instant) {
      this.smoothedTarget.copy(target.position)
      this.initialised = true
    } else {
      this.smoothedTarget.lerp(target.position, this.smoothing)
    }

    // Sit opposite the player's facing so the camera looks over their shoulder.
    const yaw = THREE.MathUtils.degToRad(target.yaw) - Math.PI / 2 + this.orbitYaw
    const horizontal = Math.cos(this.orbitPitch) * this.distance
    this.desired.set(
      this.smoothedTarget.x + Math.sin(yaw) * horizontal,
      this.smoothedTarget.y + this.shoulderHeight + Math.sin(this.orbitPitch) * this.distance,
      this.smoothedTarget.z + Math.cos(yaw) * horizontal
    )

    // Trace from the player's head to the ideal camera spot and stop short of
    // whatever is in the way, so the view never ends up inside geometry.
    this.pivot.copy(this.smoothedTarget)
    this.pivot.y += this.shoulderHeight * 0.6
    if (this.lineOfSight) {
      const clear = this.lineOfSight(this.pivot, this.desired)
      // Keep a floor on the pull-in; jamming the camera into the player's head
      // is worse than letting a corner clip the very edge of the view.
      if (clear < 1) this.desired.lerpVectors(this.pivot, this.desired, Math.max(clear, MIN_CHASE_FRACTION))
    }

    this.camera.position.copy(this.desired)
    this.lookAt.copy(this.pivot)
    this.camera.lookAt(this.lookAt)
  }
}
