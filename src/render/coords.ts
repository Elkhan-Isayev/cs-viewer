import * as THREE from 'three'

/**
 * GoldSrc is Z-up and right-handed; Three.js is Y-up and right-handed.
 * Rotating -90° about X maps one to the other without mirroring, so a Quake
 * yaw of 0 (facing +X) still faces +X here.
 */
export function quakeToThree(x: number, y: number, z: number): [number, number, number] {
  return [x, z, -y]
}

/** Inverse of {@link quakeToThree}. */
export function threeToQuake(x: number, y: number, z: number): [number, number, number] {
  return [x, -z, y]
}

export function quakeToVector(x: number, y: number, z: number, target = new THREE.Vector3()): THREE.Vector3 {
  return target.set(x, z, -y)
}

/** Converts a Quake yaw (degrees, counter-clockwise from +X) to a Three.js Y rotation. */
export function yawToRadians(yaw: number): number {
  return THREE.MathUtils.degToRad(yaw)
}

/** Unit forward vector for a Quake pitch/yaw pair, in Three.js space. */
export function anglesToForward(pitch: number, yaw: number, target = new THREE.Vector3()): THREE.Vector3 {
  const p = THREE.MathUtils.degToRad(pitch)
  const y = THREE.MathUtils.degToRad(yaw)
  const cosPitch = Math.cos(p)
  // Quake forward = (cos(yaw)cos(pitch), sin(yaw)cos(pitch), -sin(pitch)).
  return quakeToVector(
    Math.cos(y) * cosPitch,
    Math.sin(y) * cosPitch,
    -Math.sin(p),
    target
  ).normalize()
}

/** Eye height above a player's origin, matching the engine's standing view offset. */
export const PLAYER_VIEW_HEIGHT = 28
