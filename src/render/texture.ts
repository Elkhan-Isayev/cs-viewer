import * as THREE from 'three'

/**
 * Builds a `DataTexture` from an image the parsers produced top-down.
 *
 * GoldSrc stores every image with its first row at the top — TGA skyboxes,
 * WAD/BSP miptextures, studio skins. OpenGL is the other way up: the first row
 * of an uploaded array sits at v = 0, the *bottom* of the surface. Three.js
 * cannot paper over that for us here, because `DataTexture` forces
 * `flipY = false` and `UNPACK_FLIP_Y_WEBGL` is ignored for typed-array uploads,
 * so setting `flipY` back to true has no effect at all.
 *
 * This only bites where the UVs follow the image convention rather than
 * GoldSrc's. Map faces and studio skins are safe — their `t` coordinate also
 * starts at the top row and grows downward, so the two conventions agree. A
 * `BoxGeometry`, though, puts v = 1 at the top of each face, so the skybox
 * comes out mirrored: horizon along the bottom of the screen, ground along the
 * top. Flip those rows once, here, on the way to the GPU.
 */
export function createImageTexture(pixels: Uint8Array, width: number, height: number): THREE.DataTexture {
  return new THREE.DataTexture(flipRows(pixels, width, height), width, height, THREE.RGBAFormat)
}

/** Returns a copy of an RGBA8 image with its rows in the opposite order. */
export function flipRows(pixels: Uint8Array, width: number, height: number): Uint8Array {
  const stride = width * 4
  const out = new Uint8Array(pixels.length)
  for (let y = 0; y < height; y++) {
    out.set(pixels.subarray(y * stride, y * stride + stride), (height - 1 - y) * stride)
  }
  return out
}
