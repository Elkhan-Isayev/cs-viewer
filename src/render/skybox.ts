import * as THREE from 'three'
import { parseTga } from '../bsp/tga.ts'
import { createImageTexture } from './texture.ts'

/**
 * The map's skybox: six images that GoldSrc names `<sky>{rt,lf,ft,bk,up,dn}`.
 *
 * Without it, every `sky*` face in the BSP — which the renderer skips, because
 * the engine does too — leaves a flat hole in outdoor areas.
 */

/** GoldSrc sky suffixes, in Quake axis order. */
const SUFFIX_BY_QUAKE_AXIS = {
  '+x': 'ft',
  '-x': 'bk',
  '+y': 'lf',
  '-y': 'rt',
  '+z': 'up',
  '-z': 'dn'
} as const

/**
 * Three.js orders box faces +X, -X, +Y, -Y, +Z, -Z. Mapping those onto Quake
 * axes (Three +Y is Quake +Z, Three +Z is Quake -Y) gives this order.
 */
const FACE_ORDER = [
  SUFFIX_BY_QUAKE_AXIS['+x'],
  SUFFIX_BY_QUAKE_AXIS['-x'],
  SUFFIX_BY_QUAKE_AXIS['+z'],
  SUFFIX_BY_QUAKE_AXIS['-z'],
  SUFFIX_BY_QUAKE_AXIS['-y'],
  SUFFIX_BY_QUAKE_AXIS['+y']
] as const

/** Comfortably inside the camera's far plane, and far beyond any GoldSrc map. */
const SKY_SIZE = 8000

export interface Skybox {
  mesh: THREE.Mesh
  dispose(): void
}

export type SkyFaces = Partial<Record<string, Uint8Array>>

/**
 * Loads the six faces for `skyName` from `baseUrl`. Returns null when the map
 * has no sky, or its images are not among the extracted assets.
 */
export async function loadSkyFaces(baseUrl: string, skyName: string): Promise<SkyFaces | null> {
  const faces: SkyFaces = {}
  await Promise.all(
    (['rt', 'lf', 'ft', 'bk', 'up', 'dn'] as const).map(async (side) => {
      for (const extension of ['tga', 'bmp']) {
        try {
          const response = await fetch(`${baseUrl}/env/${skyName}${side}.${extension}`)
          if (!response.ok) continue
          faces[side] = new Uint8Array(await response.arrayBuffer())
          return
        } catch {
          /* try the next extension */
        }
      }
    })
  )
  return Object.keys(faces).length === 6 ? faces : null
}

export function buildSkybox(faces: SkyFaces): Skybox | null {
  const materials: THREE.Material[] = []
  const textures: THREE.Texture[] = []

  for (const side of FACE_ORDER) {
    const bytes = faces[side]
    if (!bytes) return null

    let image
    try {
      image = parseTga(bytes)
    } catch {
      return null
    }

    const texture = createImageTexture(image.pixels, image.width, image.height)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.minFilter = THREE.LinearFilter
    texture.magFilter = THREE.LinearFilter
    // Clamping matters: the faces must not wrap into each other at the seams.
    texture.wrapS = THREE.ClampToEdgeWrapping
    texture.wrapT = THREE.ClampToEdgeWrapping
    texture.needsUpdate = true
    textures.push(texture)

    materials.push(
      new THREE.MeshBasicMaterial({
        map: texture,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false
      })
    )
  }

  const mesh = new THREE.Mesh(new THREE.BoxGeometry(SKY_SIZE, SKY_SIZE, SKY_SIZE), materials)
  mesh.name = 'skybox'
  // Drawn first and never occluding anything: it is a backdrop, not geometry.
  mesh.renderOrder = -1
  mesh.frustumCulled = false

  return {
    mesh,
    dispose() {
      mesh.geometry.dispose()
      for (const material of materials) material.dispose()
      for (const texture of textures) texture.dispose()
    }
  }
}
