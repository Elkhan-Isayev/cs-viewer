/**
 * A uniform way to read game content, whether it comes from a real
 * Counter-Strike installation on disk or from a packed `valve.zip`.
 *
 * Both expose the same shape: forward-slash paths rooted at the game folder,
 * e.g. `cstrike/maps/de_inferno.bsp`.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { ZipFile } from './zip.mjs'

/** @typedef {{ label: string, has(name: string): boolean, list(predicate?: (name: string) => boolean): string[], read(name: string): Buffer, close(): void }} ContentSource */

/** Reads straight out of an installed game directory. */
function directorySource(root) {
  const files = []
  const walk = (directory, prefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(absolute, relative)
      else if (entry.isFile()) files.push(relative)
    }
  }

  // Only the two folders we ever read from, so a full Steam library does not
  // get walked.
  for (const folder of ['cstrike', 'valve']) {
    const absolute = join(root, folder)
    if (existsSync(absolute) && statSync(absolute).isDirectory()) walk(absolute, folder)
  }

  // Case-insensitive lookup: GoldSrc paths are inconsistently cased, and macOS
  // and Linux disagree about whether that matters.
  const byLower = new Map(files.map((f) => [f.toLowerCase(), f]))

  return {
    label: root,
    has: (name) => byLower.has(name.toLowerCase()),
    list: (predicate) => (predicate ? files.filter(predicate) : files.slice()),
    read(name) {
      const actual = byLower.get(name.toLowerCase())
      if (!actual) throw new Error(`No such file in ${root}: ${name}`)
      return readFileSync(join(root, actual.split('/').join(sep)))
    },
    close() {}
  }
}

/** Reads out of a `valve.zip` produced by the cs16-web project. */
function zipSource(path) {
  const zip = new ZipFile(path)
  const byLower = new Map(zip.list().map((f) => [f.toLowerCase(), f]))
  return {
    label: path,
    has: (name) => byLower.has(name.toLowerCase()),
    list: (predicate) => zip.list(predicate),
    read(name) {
      const actual = byLower.get(name.toLowerCase())
      if (!actual) throw new Error(`No such entry in ${path}: ${name}`)
      return zip.read(actual)
    },
    close: () => zip.close()
  }
}

/**
 * Picks a content source.
 *
 * @param {{ game?: string, zip?: string, defaultZip: string }} options
 * @returns {ContentSource}
 */
export function openContentSource({ game, zip, defaultZip }) {
  if (game) {
    const root = resolve(game)
    if (!existsSync(root)) fail(`No such folder: ${root}`)
    // Accept either the Half-Life root or the cstrike folder itself.
    const candidate = existsSync(join(root, 'cstrike')) ? root : resolve(root, '..')
    if (!existsSync(join(candidate, 'cstrike'))) {
      fail(
        `${root} does not look like a Counter-Strike install.\n` +
          'Point --game at the folder that contains "cstrike" (e.g. .../steamapps/common/Half-Life).'
      )
    }
    return directorySource(candidate)
  }

  const path = resolve(zip ?? defaultZip)
  if (!existsSync(path)) {
    fail(
      `Cannot find game content at ${path}\n\n` +
        'Give it one of:\n' +
        '  --game "/path/to/Half-Life"   an installed Counter-Strike 1.6 (has a cstrike folder)\n' +
        '  --zip  "/path/to/valve.zip"   a valve.zip built by the cs16-web project'
    )
  }
  return zipSource(path)
}

function fail(message) {
  console.error(message)
  process.exit(1)
}
