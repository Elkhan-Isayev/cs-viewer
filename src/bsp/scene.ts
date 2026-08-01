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
 * Lightmap value treated as "ordinarily lit", i.e. a shading multiplier of 1.
 * Measured across de_inferno at the feet of every player in the sample demo,
 * the distribution is sharply bimodal — a median of 215 out in the sunlit
 * streets against 35..69 in the fifth to twenty-fifth percentile indoors — so
 * the open street is what a model's own skin brightness should correspond to.
 */
const LIGHT_REFERENCE = 215
/** A player in deep shade stays readable; one in sunlight stops short of white. */
const LIGHT_FLOOR = 0.45
const LIGHT_CEILING = 1.15

const shade = (texel: number): number =>
  Math.min(Math.max(texel / LIGHT_REFERENCE, LIGHT_FLOOR), LIGHT_CEILING)

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
  /**
   * Shading multiplier for a model standing at `point`, from the baked light
   * of the floor beneath it. Returns null when nothing is below — outside the
   * map, or mid-jump over a pit.
   */
  sampleLight(point: THREE.Vector3, out: THREE.Color): THREE.Color | null
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
      // Not flipped, unlike the skybox: GoldSrc's `vs` texture coordinate and
      // an unflipped upload both start at the image's top row and increase
      // downward, so the two conventions already agree.
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
      // Quake winds a front face clockwise; OpenGL calls that a back face.
      // Measured on de_inferno, 9342 of 9347 faces are wound opposite their
      // outward normal, so single-sided rendering makes it a coin-flip whether
      // a surface you are looking at survives culling — and any that loses is
      // a hole in the map. Drawing both sides costs some overdraw on a mesh of
      // barely 13k triangles and guarantees the map matches the game.
      side: THREE.DoubleSide
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

  // --- point lighting -------------------------------------------------------
  //
  // GoldSrc shades a studio model by the lightmap of the surface under it, not
  // by scene lights, which is why a player walking into shadow goes dark. The
  // same trick works here: drop a ray, find the floor, read the texel that the
  // world shader would have used at that spot.
  const raycaster = new THREE.Raycaster()
  raycaster.far = 512
  const DOWN = new THREE.Vector3(0, -1, 0)
  const from = new THREE.Vector3()
  const bary = new THREE.Vector3()
  const triangle = new THREE.Triangle()

  const sampleLight = (point: THREE.Vector3, out: THREE.Color): THREE.Color | null => {
    // Start above the origin, which sits at the player's feet and can be a
    // hair inside the floor.
    from.copy(point).y += 24
    raycaster.set(from, DOWN)
    const hit = raycaster.intersectObject(root, true)[0]
    if (!hit || !hit.face || !(hit.object instanceof THREE.Mesh)) return null

    const lightmapUv = hit.object.geometry.getAttribute('lightmapUv')
    const position = hit.object.geometry.getAttribute('position')
    if (!lightmapUv || !position) return null

    // Three reports which triangle was hit but interpolates only `uv`, so the
    // lightmap coordinate has to be barycentrically weighted by hand.
    const { a, b, c } = hit.face
    triangle.set(
      new THREE.Vector3().fromBufferAttribute(position, a),
      new THREE.Vector3().fromBufferAttribute(position, b),
      new THREE.Vector3().fromBufferAttribute(position, c)
    )
    if (!triangle.getBarycoord(hit.object.worldToLocal(hit.point.clone()), bary)) return null

    const u = lightmapUv.getX(a) * bary.x + lightmapUv.getX(b) * bary.y + lightmapUv.getX(c) * bary.z
    const v = lightmapUv.getY(a) * bary.x + lightmapUv.getY(b) * bary.y + lightmapUv.getY(c) * bary.z

    const x = Math.min(Math.max(Math.round(u * atlas.size), 0), atlas.size - 1)
    const y = Math.min(Math.max(Math.round(v * atlas.size), 0), atlas.size - 1)
    const at = (y * atlas.size + x) * 4
    // Expressed relative to a normally-lit surface rather than as a raw
    // fraction. The world shader multiplies its lightmap in gamma space while
    // models are lit in linear space by three, so the engine's overbright does
    // not carry across — reusing it washes every player out to a pale ghost.
    // Anchoring on the mid-tone instead keeps a model's own skin brightness
    // where the map is ordinarily lit, and only real shade or real sunlight
    // moves it. The clamp stops a black corner erasing a player altogether.
    out.setRGB(
      shade(atlas.pixels[at]),
      shade(atlas.pixels[at + 1]),
      shade(atlas.pixels[at + 2])
    )
    return out
  }

  return {
    root,
    bounds,
    sampleLight,
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
