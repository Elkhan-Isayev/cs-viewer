/**
 * Command-line demo inspector — decodes a .dem and prints a summary.
 * Useful for checking a recording before loading it in the browser.
 *
 *   node --experimental-strip-types scripts/parse-demo.mjs <file.dem>
 */
import { readFileSync } from 'node:fs'
import { parseReplay, PLAYER_STRIDE, P_X, P_Y, P_Z, P_YAW, TEAM_T, TEAM_CT } from '../src/demo/replay.ts'

const file = process.argv[2]
if (!file) {
  console.error('usage: node --experimental-strip-types scripts/parse-demo.mjs <file.dem>')
  process.exit(1)
}

const started = Date.now()
const replay = parseReplay(new Uint8Array(readFileSync(file)))
const elapsed = Date.now() - started

const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
const teamName = (t) => (t === TEAM_T ? 'T ' : t === TEAM_CT ? 'CT' : '--')

console.log(`map        ${replay.mapName}`)
console.log(`server     ${replay.hostName}`)
console.log(`duration   ${mmss(replay.duration)} (${replay.duration.toFixed(1)}s)`)
console.log(`decoded in ${elapsed} ms`)
console.log(`players    ${replay.players.length}`)
console.log(`kills      ${replay.kills.length}`)
console.log(`chat       ${replay.chat.length}`)
console.log(`rounds     ${replay.rounds.length}`)

console.log('\nslot team name                 model     samples  first position')
for (const p of replay.players) {
  const t = p.track
  const i = 0
  const pos = t.count
    ? `(${t.valueAt(i, P_X).toFixed(0)}, ${t.valueAt(i, P_Y).toFixed(0)}, ${t.valueAt(i, P_Z).toFixed(0)}) yaw ${t.valueAt(i, P_YAW).toFixed(0)}°`
    : '-'
  console.log(
    `${String(p.slot).padStart(4)} ${teamName(p.team)}   ${p.name.padEnd(20).slice(0, 20)} ${p.model.padEnd(9)} ${String(t.count).padStart(7)}  ${pos}`
  )
}

// Sanity check: positions must stay inside a plausible GoldSrc world.
let min = [Infinity, Infinity, Infinity]
let max = [-Infinity, -Infinity, -Infinity]
let samples = 0
for (const p of replay.players) {
  for (let i = 0; i < p.track.count; i++) {
    samples++
    for (let axis = 0; axis < 3; axis++) {
      const v = p.track.data[i * PLAYER_STRIDE + axis]
      if (v < min[axis]) min[axis] = v
      if (v > max[axis]) max[axis] = v
    }
  }
}
console.log(`\nplayer samples ${samples}`)
console.log(`world bounds   min (${min.map((v) => v.toFixed(0)).join(', ')})  max (${max.map((v) => v.toFixed(0)).join(', ')})`)

console.log('\nfirst 12 kills:')
for (const k of replay.kills.slice(0, 12)) {
  console.log(`  ${mmss(k.time).padStart(6)}  ${k.attacker} -> ${k.victim}  [${k.weapon}${k.headshot ? ', HS' : ''}]`)
}

console.log('\nfirst 8 round events:')
for (const rd of replay.rounds.slice(0, 8)) console.log(`  ${mmss(rd.time).padStart(6)}  ${rd.label}`)

console.log('\nfirst 6 chat lines:')
for (const c of replay.chat.slice(0, 6)) console.log(`  ${mmss(c.time).padStart(6)}  ${c.text}`)
