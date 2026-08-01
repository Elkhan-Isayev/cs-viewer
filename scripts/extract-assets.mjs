/**
 * Pulls the game content a demo needs into `public/assets/`, either from an
 * installed copy of Counter-Strike 1.6 or from a `valve.zip` built by the
 * neighbouring cs16-web project.
 *
 * Nothing is redistributed: the content comes from your own machine.
 *
 *   node scripts/extract-assets.mjs --game "/path/to/Half-Life"
 *   node scripts/extract-assets.mjs --zip  "/path/to/valve.zip"
 *   node scripts/extract-assets.mjs --map de_dust2 --map de_nuke
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openContentSource } from './lib/source.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, '..')
const assetsDir = join(projectRoot, 'public', 'assets')

const args = process.argv.slice(2)
const readOption = (flag) => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

const maps = args.includes('--map')
  ? args.filter((a, i) => args[i - 1] === '--map')
  : ['de_inferno']

const zip = openContentSource({
  game: readOption('--game'),
  zip: readOption('--zip'),
  defaultZip: join(projectRoot, '..', 'cs16-web', 'valve.zip')
})

console.log(`Reading ${zip.label}`)

let written = 0
function emit(relativePath, buffer) {
  const target = join(assetsDir, relativePath)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, buffer)
  written++
  console.log(`  ${relativePath.padEnd(46)} ${(buffer.length / 1024).toFixed(0).padStart(7)} KiB`)
}

/**
 * Reads the texture lump and returns the names of textures the map does *not*
 * embed. GoldSrc marks those with a zero data offset; they have to come from a
 * WAD listed in worldspawn.
 */
function externalTextures(bsp) {
  const lumpOffset = bsp.readInt32LE(4 + 2 * 8)
  const count = bsp.readUInt32LE(lumpOffset)
  const names = []
  for (let i = 0; i < count; i++) {
    const offset = bsp.readInt32LE(lumpOffset + 4 + i * 4)
    if (offset < 0) continue
    const miptex = lumpOffset + offset
    const name = bsp.toString('latin1', miptex, miptex + 16).replace(/\0.*$/, '')
    if (bsp.readUInt32LE(miptex + 24) === 0) names.push(name.toLowerCase())
  }
  return names
}

/** Reads a key out of the map's worldspawn entity. */
function worldspawnValue(bsp, key) {
  const entitiesOffset = bsp.readUInt32LE(4)
  const entitiesLength = bsp.readUInt32LE(8)
  const entities = bsp.toString('latin1', entitiesOffset, entitiesOffset + entitiesLength)
  const match = entities.match(new RegExp(`"${key}"\\s+"([^"]*)"`))
  return match ? match[1] : null
}

/** The worldspawn entity lists the WADs a map's textures come from. */
function wadsReferencedBy(bsp) {
  const entitiesOffset = bsp.readUInt32LE(4)
  const entitiesLength = bsp.readUInt32LE(8)
  const entities = bsp.toString('latin1', entitiesOffset, entitiesOffset + entitiesLength)
  const match = entities.match(/"wad"\s+"([^"]*)"/)
  if (!match) return []
  return match[1]
    .split(';')
    .map((path) => path.trim().replace(/\\/g, '/').split('/').pop())
    .filter((name) => name && name.toLowerCase().endsWith('.wad'))
}

/** Reads a WAD3 directory into a map of lowercase name -> raw lump bytes. */
function readWad(buffer) {
  const lumps = new Map()
  if (buffer.toString('latin1', 0, 4) !== 'WAD3') return lumps
  const count = buffer.readInt32LE(4)
  const directory = buffer.readInt32LE(8)
  for (let i = 0; i < count; i++) {
    const at = directory + i * 32
    if (at + 32 > buffer.length) break
    const filePos = buffer.readInt32LE(at)
    const diskSize = buffer.readInt32LE(at + 4)
    const type = buffer.readUInt8(at + 12)
    const compression = buffer.readUInt8(at + 13)
    const name = buffer.toString('latin1', at + 16, at + 32).replace(/\0.*$/, '').toLowerCase()
    // Type 0x43 is a miptex; compressed lumps never occur in shipped WADs.
    if (type !== 0x43 || compression !== 0) continue
    lumps.set(name, buffer.subarray(filePos, filePos + diskSize))
  }
  return lumps
}

/** Builds a WAD3 archive containing exactly `lumps` (name -> bytes). */
function buildWad(lumps) {
  const entries = [...lumps.entries()]
  const headerSize = 12
  let dataSize = 0
  for (const [, data] of entries) dataSize += data.length
  const buffer = Buffer.alloc(headerSize + dataSize + entries.length * 32)

  buffer.write('WAD3', 0, 'latin1')
  buffer.writeInt32LE(entries.length, 4)
  buffer.writeInt32LE(headerSize + dataSize, 8)

  let at = headerSize
  const positions = []
  for (const [, data] of entries) {
    positions.push(at)
    data.copy(buffer, at)
    at += data.length
  }
  entries.forEach(([name, data], i) => {
    const dir = headerSize + dataSize + i * 32
    buffer.writeInt32LE(positions[i], dir)
    buffer.writeInt32LE(data.length, dir + 4)
    buffer.writeInt32LE(data.length, dir + 8)
    buffer.writeUInt8(0x43, dir + 12)
    buffer.write(name.slice(0, 15), dir + 16, 'latin1')
  })
  return buffer
}

console.log('\nMaps:')
/** @type {Map<string, string[]>} map name -> textures it needs from a WAD */
const mapNeeds = new Map()
for (const map of maps) {
  const entry = `cstrike/maps/${map}.bsp`
  if (!zip.has(entry)) {
    console.error(`  ${map}: not found in archive — skipping`)
    continue
  }
  const bsp = zip.read(entry)
  emit(`maps/${map}.bsp`, bsp)
  const needed = externalTextures(bsp)
  mapNeeds.set(map, { needed, wads: wadsReferencedBy(bsp) })
  console.log(`    ${needed.length} of its textures live outside the .bsp`)

  // Skybox: six images named <skyname>{rt,lf,ft,bk,up,dn}, either TGA or BMP.
  const skyName = worldspawnValue(bsp, 'skyname')
  if (skyName) {
    let found = 0
    for (const side of ['rt', 'lf', 'ft', 'bk', 'up', 'dn']) {
      for (const extension of ['tga', 'bmp']) {
        const candidate = `cstrike/gfx/env/${skyName}${side}.${extension}`
        const fallback = `valve/gfx/env/${skyName}${side}.${extension}`
        const entry = zip.has(candidate) ? candidate : zip.has(fallback) ? fallback : null
        if (!entry) continue
        emit(`env/${skyName}${side}.${extension}`, zip.read(entry))
        found++
        break
      }
    }
    console.log(`    skybox "${skyName}": ${found}/6 faces`)
  }
}

// Rather than shipping whole WADs (halflife.wad alone is 37 MiB), build one
// small archive per map holding only the textures that map is missing.
console.log('\nPer-map texture packs:')
const wadLocations = new Map()
for (const name of zip.list((n) => n.toLowerCase().endsWith('.wad'))) {
  const base = name.split('/').pop().toLowerCase()
  // Prefer the mod's copy over the base game's when both exist.
  if (!wadLocations.has(base) || name.startsWith('cstrike/')) wadLocations.set(base, name)
}

for (const [map, { needed, wads }] of mapNeeds) {
  if (needed.length === 0) {
    console.log(`  ${map}: fully self-contained, no texture pack needed`)
    continue
  }
  const wanted = new Set(needed)
  const collected = new Map()
  // Search the map's own WAD list first, then everything else as a fallback.
  const search = [...wads.map((w) => w.toLowerCase()), ...wadLocations.keys()]
  for (const wadName of search) {
    if (collected.size === wanted.size) break
    const source = wadLocations.get(wadName)
    if (!source) continue
    for (const [name, data] of readWad(zip.read(source))) {
      if (wanted.has(name) && !collected.has(name)) collected.set(name, data)
    }
  }
  emit(`maps/${map}.wad`, buildWad(collected))
  const absent = [...wanted].filter((n) => !collected.has(n))
  if (absent.length) console.log(`    missing textures: ${absent.join(' ')}`)
}

console.log('\nPlayer models:')
for (const name of zip.list((n) => /^cstrike\/models\/player\/[^/]+\/[^/]+\.mdl$/.test(n))) {
  const parts = name.split('/')
  const folder = parts[parts.length - 2]
  const file = parts[parts.length - 1]
  // Skip the high-definition variants and per-model texture files (`*T.mdl`).
  if (file !== `${folder}.mdl`) continue
  emit(`models/player/${folder}/${file}`, zip.read(name))
}

// Weapon models. `p_*` are the ones held in a player's hands, and are what the
// demo's `weaponmodel` field actually points at; `w_*` are the dropped pickups.
console.log('\nWeapon models:')
for (const name of zip.list((n) => /^cstrike\/models\/[pw]_[a-z0-9_]+\.mdl$/.test(n))) {
  emit(`models/${name.split('/').pop()}`, zip.read(name))
}

zip.close()
console.log(`\nWrote ${written} files to public/assets/`)
