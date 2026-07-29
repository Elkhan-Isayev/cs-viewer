/**
 * Development harness: parses a demo end-to-end and reports what the delta
 * stream actually contains, so the replay builder can be written against real
 * field names instead of guesses.
 *
 *   node --experimental-strip-types scripts/probe-demo.mjs <file.dem>
 */
import { readFileSync } from 'node:fs'
import { ByteReader } from '../src/core/ByteReader.ts'
import { readHeader, readDirectory, readFrameHeader, nextFrameOffset, netMsgPayload } from '../src/demo/container.ts'
import { createDeltaTable } from '../src/demo/delta.ts'
import { parseNetMessages, RESOURCE_MODEL, SVC } from '../src/demo/messages.ts'
import { FrameType } from '../src/demo/types.ts'

const file = process.argv[2]
const bytes = new Uint8Array(readFileSync(file))
const header = readHeader(bytes)
const directory = readDirectory(bytes, header)
console.log('header:', header)
console.log('directory:', directory)

const state = { hltv: false, deltas: createDeltaTable(), userMessages: new Map(), maxPlayers: 32 }
const models = new Map()
const userInfos = new Map()
const userMsgHits = new Map()
const playerFieldStats = new Map()
const entityFieldStats = new Map()
let serverTime = 0
let sampleEntities = null
let printCount = 0

const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1)

const NAMES = Object.fromEntries(Object.entries(SVC).map(([k, v]) => [v, k]))
let trace = []
const sink = {
  onMessage: (type, start, end) => {
    trace.push(`${NAMES[type] ?? 'usermsg' + type}[${start}..${end}]`)
    if (trace.length > 40) trace.shift()
  },
  onServerInfo: (i) => console.log('serverinfo:', i),
  onTime: (t) => { serverTime = t },
  onResource: (type, index, name) => { if (type === RESOURCE_MODEL) models.set(index, name) },
  onUserInfo: (slot, raw) => { if (raw) userInfos.set(slot, raw) },
  onUserMessage: (def, payload) => { bump(userMsgHits, `${def.name}/${def.size}`), payload },
  onPrint: (t) => { if (printCount++ < 6) console.log('print:', JSON.stringify(t.slice(0, 120))) },
  onBaseline: (u) => console.log('baseline entities:', u.length),
  onPacketEntities: (updates) => {
    for (const u of updates) {
      if (u.removed) continue
      const isPlayer = u.entityIndex > 0 && u.entityIndex <= state.maxPlayers
      const stats = isPlayer ? playerFieldStats : entityFieldStats
      for (const k of Object.keys(u.values)) bump(stats, k)
    }
    if (!sampleEntities && serverTime > 200) {
      sampleEntities = updates.filter((u) => !u.removed && u.entityIndex <= 12).slice(0, 6)
    }
  }
}

const r = new ByteReader(bytes)
let netMsgFrames = 0
let totalFrames = 0
const t0 = Date.now()

for (const entry of directory) {
  let offset = entry.offset
  const end = entry.offset + entry.length
  while (offset < end) {
    const frame = readFrameHeader(r, offset)
    totalFrames++
    if (frame.type === FrameType.NetMsg || frame.type === FrameType.NetMsgStart) {
      netMsgFrames++
      const payload = netMsgPayload(r, frame)
      try {
        parseNetMessages(payload, state, sink)
      } catch (err) {
        console.error(`\nFAILED at frame ${totalFrames} (t=${frame.time.toFixed(2)}s, offset ${offset}):`, err.message)
        console.error('payload', payload.length, 'bytes; last messages:\n ', trace.join('\n  '))
        console.error('hex head:', Buffer.from(payload.subarray(0, 96)).toString('hex'))
        process.exit(1)
      }
    }
    const next = nextFrameOffset(r, frame)
    if (next < 0) break
    offset = next
  }
}

console.log(`\nparsed ${totalFrames} frames (${netMsgFrames} netmsg) in ${Date.now() - t0} ms`)
console.log('delta layouts:', Object.keys(state.deltas).map((k) => `${k}(${state.deltas[k].length})`).join(' '))
console.log('\nentity_state_player_t fields seen:', [...playerFieldStats.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' '))
console.log('\nentity_state_t fields seen:', [...entityFieldStats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, v]) => `${k}:${v}`).join(' '))
console.log('\nuser messages:', [...userMsgHits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25))
console.log('\nplayers:')
for (const [slot, raw] of [...userInfos].slice(0, 16)) console.log(' ', slot, raw.slice(0, 160))
console.log('\nsample entity updates mid-demo:')
for (const e of sampleEntities ?? []) console.log(' ', e.entityIndex, JSON.stringify(e.values))
console.log('\nsome precached models:')
for (const [i, n] of [...models].filter(([, n]) => n.includes('player')).slice(0, 12)) console.log(' ', i, n)
