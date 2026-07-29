import * as THREE from 'three'
import { LightmapAtlas } from './lightmapAtlas.ts'
import type { Bsp } from './parser.ts'
import { quakeToThree } from '../render/coords.ts'

/** GoldSrc samples lightmaps once every 16 world units. */
const LUMEL_SIZE = 16

/**
 * Tool textures the compiler leaves in the BSP but the engine never draws.
 * Rendering them would wall the map off with opaque orange slabs.
 */
const INVISIBLE_TEXTURES = new Set([
  'aaatrigger', 'clip', 'clipbevel', 'origin', 'skip', 'hint', 'null',
  'bevel', 'nodraw', 'trigger', 'contentwater', 'contentempty', 'black_hidden'
])

const isSky = (name: string): boolean => name.toLowerCase().startsWith('sky')

/**
 * Vertex-shaded lightmapping: albedo modulated by the baked lightmap, with the
 * overbright factor GoldSrc applies so lit surfaces reach full white.
 */
const WORLD_VERTEX_SHADER = /* glsl */ `
  attribute vec2 lightmapUv;
  varying vec2 vUv;
  varying vec2 vLightmapUv;
  void main() {
    vUv = uv;
    vLightmapUv = lightmapUv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const WORLD_FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D diffuseMap;
  uniform sampler2D lightmap;
  uniform float overbright;
  uniform float brightness;
  uniform bool masked;
  varying vec2 vUv;
  varying vec2 vLightmapUv;
  void main() {
    vec4 albedo = texture2D(diffuseMap, vUv);
    if (masked && albedo.a < 0.5) discard;
    vec3 light = texture2D(lightmap, vLightmapUv).rgb * overbright;
    gl_FragColor = vec4(albedo.rgb * light * brightness, 1.0);
  }
`

export interface BuiltMap {
  root: THREE.Object3D
  /** World-space bounding box, in Three.js coordinates. */
  bounds: THREE.Box3
  /** Adjusts the lighting multiplier applied to every surface. */
  setBrightness(value: number): void
  dispose(): void
}

interface FaceGeometry {
  positions: number[]
  uvs: number[]
  lightmapUvs: number[]
  indices: number[]
}

export function buildMapScene(bsp: Bsp): BuiltMap {
  const atlas = new LightmapAtlas(2048)
  const atlasTexture = new THREE.DataTexture(atlas.pixels, atlas.size, atlas.size, THREE.RGBAFormat)
  atlasTexture.minFilter = THREE.LinearFilter
  atlasTexture.magFilter = THREE.LinearFilter
  atlasTexture.generateMipmaps = false
  atlasTexture.colorSpace = THREE.SRGBColorSpace

  const diffuseTextures = new Map<number, THREE.Texture>()
  const materials: THREE.ShaderMaterial[] = []
  const geometryByTexture = new Map<number, FaceGeometry>()

  // Brush entities (doors, breakables, glass) are separate BSP models placed
  // by an entity's origin; collect those offsets so they land in the map.
  const modelOffsets = new Map<number, [number, number, number]>()
  for (const entity of bsp.entities) {
    const model = entity.model
    if (!model || !model.startsWith('*')) continue
    const index = Number.parseInt(model.slice(1), 10)
    if (!Number.isFinite(index)) continue
    const origin = entity.origin?.split(/\s+/).map(Number)
    if (origin && origin.length === 3 && origin.every(Number.isFinite)) {
      modelOffsets.set(index, origin as [number, number, number])
    }
  }

  let skippedLightmaps = 0

  for (let modelIndex = 0; modelIndex < bsp.models.length; modelIndex++) {
    const model = bsp.models[modelIndex]
    const offset = modelOffsets.get(modelIndex) ?? [0, 0, 0]

    for (let f = 0; f < model.faceCount; f++) {
      const face = bsp.faces[model.firstFace + f]
      if (!face) continue
      const texInfo = bsp.texInfo[face.texInfo]
      if (!texInfo) continue
      const texture = bsp.textures[texInfo.textureIndex]
      if (!texture) continue

      const name = texture.name.toLowerCase()
      if (INVISIBLE_TEXTURES.has(name) || isSky(name)) continue
      if (!texture.pixels || texture.width === 0) continue

      // Gather the face's winding by walking its surfedges.
      const points: [number, number, number][] = []
      for (let e = 0; e < face.edgeCount; e++) {
        const surfEdge = bsp.surfEdges[face.firstEdge + e]
        const edgeIndex = Math.abs(surfEdge) * 2
        // A negative surfedge means the edge is traversed backwards.
        const vertexIndex = surfEdge >= 0 ? bsp.edges[edgeIndex] : bsp.edges[edgeIndex + 1]
        const v = vertexIndex * 3
        points.push([
          bsp.vertices[v] + offset[0],
          bsp.vertices[v + 1] + offset[1],
          bsp.vertices[v + 2] + offset[2]
        ])
      }
      if (points.length < 3) continue

      // Texture coordinates, and the lightmap extents derived from them.
      const us: number[] = []
      const vs: number[] = []
      for (const p of points) {
        us.push(p[0] * texInfo.s[0] + p[1] * texInfo.s[1] + p[2] * texInfo.s[2] + texInfo.sShift)
        vs.push(p[0] * texInfo.t[0] + p[1] * texInfo.t[1] + p[2] * texInfo.t[2] + texInfo.tShift)
      }
      const minU = Math.floor(Math.min(...us) / LUMEL_SIZE)
      const maxU = Math.ceil(Math.max(...us) / LUMEL_SIZE)
      const minV = Math.floor(Math.min(...vs) / LUMEL_SIZE)
      const maxV = Math.ceil(Math.max(...vs) / LUMEL_SIZE)
      const lightmapWidth = maxU - minU + 1
      const lightmapHeight = maxV - minV + 1

      let rect = null
      if (lightmapWidth > 0 && lightmapHeight > 0 && lightmapWidth <= 64 && lightmapHeight <= 64) {
        rect = atlas.allocate(lightmapWidth, lightmapHeight)
      }
      if (rect) {
        const hasLight = face.lightmapOffset >= 0 && face.styles[0] !== 255
        if (hasLight && face.lightmapOffset + lightmapWidth * lightmapHeight * 3 <= bsp.lighting.length) {
          atlas.write(rect.x, rect.y, lightmapWidth, lightmapHeight, bsp.lighting, face.lightmapOffset)
        } else {
          atlas.writeWhite(rect.x, rect.y, lightmapWidth, lightmapHeight)
        }
      } else {
        skippedLightmaps++
      }

      let group = geometryByTexture.get(texInfo.textureIndex)
      if (!group) {
        group = { positions: [], uvs: [], lightmapUvs: [], indices: [] }
        geometryByTexture.set(texInfo.textureIndex, group)
      }

      const baseIndex = group.positions.length / 3
      for (let i = 0; i < points.length; i++) {
        const [x, y, z] = quakeToThree(points[i][0], points[i][1], points[i][2])
        group.positions.push(x, y, z)
        group.uvs.push(us[i] / texture.width, vs[i] / texture.height)

        if (rect) {
          // Sample at lumel centres inside the packed block.
          const lu = us[i] / LUMEL_SIZE - minU + 0.5
          const lv = vs[i] / LUMEL_SIZE - minV + 0.5
          group.lightmapUvs.push((rect.x + lu) / atlas.size, (rect.y + lv) / atlas.size)
        } else {
          group.lightmapUvs.push(0.5 / atlas.size, 0.5 / atlas.size)
        }
      }

      // BSP faces are convex, so a triangle fan is always valid.
      for (let i = 1; i < points.length - 1; i++) {
        group.indices.push(baseIndex, baseIndex + i, baseIndex + i + 1)
      }
    }
  }

  atlasTexture.needsUpdate = true

  const root = new THREE.Group()
  root.name = 'map'
  const bounds = new THREE.Box3()

  for (const [textureIndex, group] of geometryByTexture) {
    if (group.indices.length === 0) continue
    const texture = bsp.textures[textureIndex]

    let diffuse = diffuseTextures.get(textureIndex)
    if (!diffuse) {
      diffuse = new THREE.DataTexture(texture.pixels!, texture.width, texture.height, THREE.RGBAFormat)
      diffuse.wrapS = THREE.RepeatWrapping
      diffuse.wrapT = THREE.RepeatWrapping
      diffuse.minFilter = THREE.LinearMipmapLinearFilter
      diffuse.magFilter = THREE.LinearFilter
      diffuse.generateMipmaps = true
      diffuse.anisotropy = 4
      diffuse.colorSpace = THREE.SRGBColorSpace
      diffuse.needsUpdate = true
      diffuseTextures.set(textureIndex, diffuse)
    }

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(group.positions, 3))
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(group.uvs, 2))
    geometry.setAttribute('lightmapUv', new THREE.Float32BufferAttribute(group.lightmapUvs, 2))
    geometry.setIndex(group.indices)
    geometry.computeBoundingSphere()
    geometry.computeBoundingBox()
    if (geometry.boundingBox) bounds.union(geometry.boundingBox)

    const material = new THREE.ShaderMaterial({
      uniforms: {
        diffuseMap: { value: diffuse },
        lightmap: { value: atlasTexture },
        overbright: { value: 2.0 },
        brightness: { value: 1.0 },
        masked: { value: texture.name.startsWith('{') }
      },
      vertexShader: WORLD_VERTEX_SHADER,
      fragmentShader: WORLD_FRAGMENT_SHADER,
      side: THREE.FrontSide
    })
    materials.push(material)

    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = texture.name
    mesh.frustumCulled = true
    root.add(mesh)
  }

  if (skippedLightmaps > 0) {
    console.warn(`${skippedLightmaps} faces exceeded the lightmap atlas and fell back to flat lighting`)
  }

  return {
    root,
    bounds,
    setBrightness(value: number) {
      for (const material of materials) material.uniforms.brightness.value = value
    },
    dispose() {
      root.traverse((object) => {
        if (object instanceof THREE.Mesh) object.geometry.dispose()
      })
      for (const material of materials) material.dispose()
      for (const texture of diffuseTextures.values()) texture.dispose()
      atlasTexture.dispose()
    }
  }
}
