import * as THREE from 'three'
import { parseMdl, readAnimChannel, STUDIO_NF_ADDITIVE, STUDIO_NF_CHROME, STUDIO_NF_MASKED, type Mdl } from './parser.ts'

/**
 * Turns a parsed studio model into a Three.js `SkinnedMesh` and evaluates its
 * sequences at runtime.
 *
 * Every studio vertex is bound to exactly one bone, so skinning is a single
 * index/weight pair and the GPU can do all of it.
 */

/**
 * Studio bone rotations use GoldSrc's `AngleQuaternion`, which composes
 * R = Rz * Ry * Rx. That is Three.js's 'ZYX' Euler order — 'XYZ' produces a
 * different quaternion and collapses the skeleton.
 */
const STUDIO_EULER_ORDER = 'ZYX'
const scratchEuler = new THREE.Euler(0, 0, 0, STUDIO_EULER_ORDER)

const eulerToQuaternion = (x: number, y: number, z: number, target: THREE.Quaternion): THREE.Quaternion =>
  target.setFromEuler(scratchEuler.set(x, y, z, STUDIO_EULER_ORDER))

export interface StudioModelData {
  mdl: Mdl
  geometry: THREE.BufferGeometry
  materials: THREE.Material[]
  /** Rest-pose skeleton template; each instance clones it. */
  boneNames: string[]
  boneParents: number[]
}

/**
 * Builds the shared, immutable part of a model: geometry, textures and the
 * bone hierarchy. Instances share all of it.
 */
export function buildStudioModel(bytes: Uint8Array): StudioModelData {
  const mdl = parseMdl(bytes)
  const view = new DataView(mdl.bytes.buffer, mdl.bytes.byteOffset, mdl.bytes.byteLength)

  const positions: number[] = []
  const normals: number[] = []
  const uvs: number[] = []
  const skinIndices: number[] = []
  const skinWeights: number[] = []
  const groups: { start: number; count: number; textureIndex: number }[] = []
  let indexCursor = 0

  const skin = mdl.skinFamilies[0]

  // Only the first sub-model of each body part is drawn — that is the default
  // body configuration, which is what players always use in CS.
  for (const part of mdl.bodyParts) {
    const model = part.models[0]
    if (!model) continue

    for (const mesh of model.meshes) {
      const textureIndex = skin[mesh.skinRef] ?? 0
      const texture = mdl.textures[textureIndex]
      const sWidth = texture?.width || 1
      const tHeight = texture?.height || 1
      const startIndex = indexCursor

      // Triangle commands: a positive run is a strip, a negative run a fan,
      // and zero ends the mesh.
      let at = mesh.triangleCommandOffset
      for (;;) {
        const command = view.getInt16(at, true)
        at += 2
        if (command === 0) break

        const isFan = command < 0
        const vertexCount = Math.abs(command)
        const run: { position: number; normal: number; s: number; t: number }[] = []
        for (let i = 0; i < vertexCount; i++) {
          run.push({
            position: view.getUint16(at, true),
            normal: view.getUint16(at + 2, true),
            s: view.getInt16(at + 4, true),
            t: view.getInt16(at + 6, true)
          })
          at += 8
        }

        const emit = (a: number, b: number, c: number) => {
          for (const index of [a, b, c]) {
            const v = run[index]
            const vertexOffset = model.vertexOffset + v.position * 12
            const normalOffset = model.normalOffset + v.normal * 12
            positions.push(
              view.getFloat32(vertexOffset, true),
              view.getFloat32(vertexOffset + 4, true),
              view.getFloat32(vertexOffset + 8, true)
            )
            normals.push(
              view.getFloat32(normalOffset, true),
              view.getFloat32(normalOffset + 4, true),
              view.getFloat32(normalOffset + 8, true)
            )
            uvs.push(v.s / sWidth, v.t / tHeight)
            const bone = mdl.bytes[model.vertexBoneOffset + v.position]
            skinIndices.push(bone, 0, 0, 0)
            skinWeights.push(1, 0, 0, 0)
            indexCursor++
          }
        }

        for (let i = 0; i + 2 < vertexCount; i++) {
          if (isFan) {
            emit(0, i + 1, i + 2)
          } else if (i % 2 === 0) {
            emit(i, i + 1, i + 2)
          } else {
            // Odd strip triangles are wound the other way.
            emit(i + 1, i, i + 2)
          }
        }
      }

      if (indexCursor > startIndex) {
        groups.push({ start: startIndex, count: indexCursor - startIndex, textureIndex })
      }
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4))
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4))

  // One material per distinct texture, addressed through geometry groups.
  const materialByTexture = new Map<number, number>()
  const materials: THREE.Material[] = []
  for (const group of groups) {
    let materialIndex = materialByTexture.get(group.textureIndex)
    if (materialIndex === undefined) {
      materialIndex = materials.length
      materialByTexture.set(group.textureIndex, materialIndex)
      materials.push(createMaterial(mdl, group.textureIndex))
    }
    geometry.addGroup(group.start, group.count, materialIndex)
  }
  geometry.computeBoundingSphere()

  return {
    mdl,
    geometry,
    materials,
    boneNames: mdl.bones.map((b, i) => `${b.name || 'bone'}_${i}`),
    boneParents: mdl.bones.map((b) => b.parent)
  }
}

function createMaterial(mdl: Mdl, textureIndex: number): THREE.Material {
  const texture = mdl.textures[textureIndex]
  if (!texture) return new THREE.MeshBasicMaterial({ color: 0x888888 })

  const map = new THREE.DataTexture(texture.pixels, texture.width, texture.height, THREE.RGBAFormat)
  map.wrapS = THREE.RepeatWrapping
  map.wrapT = THREE.RepeatWrapping
  map.minFilter = THREE.LinearMipmapLinearFilter
  map.magFilter = THREE.LinearFilter
  map.generateMipmaps = true
  // Player skins are low resolution and almost always seen at a grazing angle,
  // where trilinear alone smears them into mush.
  map.anisotropy = 4
  map.colorSpace = THREE.SRGBColorSpace
  map.needsUpdate = true

  const additive = (texture.flags & STUDIO_NF_ADDITIVE) !== 0
  return new THREE.MeshLambertMaterial({
    map,
    transparent: additive,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    alphaTest: (texture.flags & STUDIO_NF_MASKED) !== 0 ? 0.5 : 0,
    // Chrome-mapped parts are environment reflections in the engine; plain
    // diffuse is close enough and avoids a second UV set.
    side: (texture.flags & STUDIO_NF_CHROME) !== 0 ? THREE.DoubleSide : THREE.FrontSide
  } as THREE.MeshLambertMaterialParameters)
}

/** Bones at or below this one follow the upper-body sequence, not the gait. */
const TORSO_ROOT = 'Bip01 Spine'

export class StudioInstance {
  readonly root: THREE.Group
  readonly mesh: THREE.SkinnedMesh
  /**
   * Bones by their raw studio name, so a weapon can ride the player's arm.
   * Deliberately not keyed on `data.boneNames`, which suffixes the index to
   * keep three.js names unique — those indices differ between a 53-bone player
   * and a 13-bone weapon, and matching on them works only by coincidence.
   */
  readonly boneByName = new Map<string, THREE.Bone>()
  private readonly bones: THREE.Bone[]
  private readonly materials: THREE.Material[]
  private readonly data: StudioModelData
  /** True for bones the upper-body sequence drives. */
  private readonly isTorso: boolean[]

  private readonly position = new THREE.Vector3()
  private readonly quaternion = new THREE.Quaternion()

  /** Sequence metadata, so callers can map engine frame numbers onto clips. */
  get sequenceInfo(): { label: string; frameCount: number; fps: number }[] {
    return this.data.mdl.sequences
  }

  constructor(data: StudioModelData) {
    this.data = data
    const { mdl } = data

    this.bones = mdl.bones.map(() => new THREE.Bone())
    mdl.bones.forEach((bone, i) => {
      this.bones[i].name = data.boneNames[i]
      if (bone.name) this.boneByName.set(bone.name, this.bones[i])
      if (bone.parent >= 0) this.bones[bone.parent].add(this.bones[i])
    })

    // Mark the torso subtree so the gait can drive the legs independently.
    this.isTorso = mdl.bones.map(() => false)
    mdl.bones.forEach((bone, i) => {
      if (bone.name === TORSO_ROOT) this.isTorso[i] = true
      else if (bone.parent >= 0 && this.isTorso[bone.parent]) this.isTorso[i] = true
    })

    // Cloned so each player can be tinted by the light where they stand;
    // `data` is shared by every instance of the same model.
    this.materials = data.materials.map((material) => material.clone())
    this.mesh = new THREE.SkinnedMesh(data.geometry, this.materials)
    this.mesh.frustumCulled = false

    const roots = this.bones.filter((_, i) => mdl.bones[i].parent < 0)
    this.root = new THREE.Group()
    for (const bone of roots) this.root.add(bone)
    this.root.add(this.mesh)

    this.applyPose(0, 0, 0, 0)

    // Studio vertices are stored in their own bone's local space, so the world
    // position is simply `bone.matrixWorld * vertex`. Three multiplies by
    // `bone.matrixWorld * boneInverse`, which means the inverse binds must be
    // identities — letting Skeleton derive them from the rest pose would apply
    // the pose twice and collapse the model.
    const identityInverses = this.bones.map(() => new THREE.Matrix4())
    this.mesh.bind(new THREE.Skeleton(this.bones, identityInverses), new THREE.Matrix4())
  }

  /**
   * Poses the skeleton.
   *
   * @param sequence      upper-body sequence index (aiming, shooting, reloading)
   * @param frame         frame within that sequence
   * @param gaitSequence  lower-body sequence index (idle, walk, run)
   * @param gaitFrame     frame within the gait sequence
   */
  applyPose(sequence: number, frame: number, gaitSequence: number, gaitFrame: number): void {
    const { mdl } = this.data
    const upper = mdl.sequences[sequence] ?? mdl.sequences[0]
    const lower = mdl.sequences[gaitSequence] ?? upper

    for (let i = 0; i < mdl.bones.length; i++) {
      const useGait = !this.isTorso[i] && lower !== undefined && gaitSequence > 0
      const active = useGait ? lower : upper
      const activeFrame = useGait ? gaitFrame : frame
      this.poseBone(i, active, activeFrame)
    }
  }

  /**
   * Poses this model by borrowing `host`'s skeleton wherever the bone names
   * agree, which is how GoldSrc draws a weapon in a player's hands.
   *
   * A `p_*.mdl` carries no animation worth the name — one two-frame `idle` —
   * because it is not animated independently. Its bones are a copy of the
   * player's arm chain (`Bip01` → `Pelvis` → `Spine…` → `R Hand`) under the
   * same names, and the engine renders it with the player's bone transforms so
   * the gun tracks the hand through every reload and stumble. Bones the player
   * does not have — a muzzle `flash` locator, say — keep the weapon's own pose.
   *
   * Local transforms are copied rather than world matrices: the shared chain
   * has the same parents in the same order, so the world result is identical
   * and there is nothing to decompose.
   */
  followSkeleton(host: StudioInstance): void {
    const { mdl } = this.data
    const idle = mdl.sequences[0]
    for (let i = 0; i < mdl.bones.length; i++) {
      const shared = host.boneByName.get(mdl.bones[i].name)
      if (shared) {
        this.bones[i].position.copy(shared.position)
        this.bones[i].quaternion.copy(shared.quaternion)
      } else {
        this.poseBone(i, idle, 0)
      }
    }
  }

  private poseBone(boneIndex: number, sequence: { animOffset: number; frameCount: number } | undefined, frame: number): void {
    const bone = this.data.mdl.bones[boneIndex]
    const target = this.bones[boneIndex]

    const values = [0, 0, 0, 0, 0, 0]
    // Studio clips run at 30-ish fps but the demo is played back at whatever
    // the display refreshes at, so land between keyframes and blend them.
    // Sampling only the floor makes every animation step visibly.
    const last = sequence ? sequence.frameCount - 1 : 0
    const whole = Math.min(Math.max(Math.floor(frame), 0), last)
    const nextWhole = Math.min(whole + 1, last)
    const blend = Math.min(Math.max(frame - whole, 0), 1)

    for (let channel = 0; channel < 6; channel++) {
      let value = bone.value[channel]
      if (sequence && sequence.frameCount > 0) {
        const a = readAnimChannel(this.data.mdl.bytes, sequence.animOffset, boneIndex, channel, whole)
        if (a !== null) {
          const b = nextWhole === whole
            ? a
            : readAnimChannel(this.data.mdl.bytes, sequence.animOffset, boneIndex, channel, nextWhole) ?? a
          // Rotations are stored as raw Euler steps; over one frame they never
          // approach a wrap, so a plain lerp is safe and much cheaper than slerp.
          value += (a + (b - a) * blend) * bone.scale[channel]
        }
      }
      values[channel] = value
    }

    this.position.set(values[0], values[1], values[2])
    eulerToQuaternion(values[3], values[4], values[5], this.quaternion)
    target.position.copy(this.position)
    target.quaternion.copy(this.quaternion)
  }

  /** Sets the light this model sits in; GoldSrc lights studio models by point. */
  setLight(color: THREE.Color): void {
    for (const material of this.materials) {
      const tinted = material as THREE.MeshLambertMaterial
      if (tinted.color) tinted.color.copy(color)
    }
  }

  dispose(): void {
    this.mesh.skeleton?.dispose()
    for (const material of this.materials) material.dispose()
  }
}
