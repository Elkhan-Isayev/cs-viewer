import { BitReader } from '../core/BitReader.ts'
import { ByteReader } from '../core/ByteReader.ts'
import { readDelta, readDeltaDescription, type DeltaTable, type DeltaValues } from './delta.ts'

/** GoldSrc network protocol 48 server-to-client message ids. */
export const SVC = {
  BAD: 0,
  NOP: 1,
  DISCONNECT: 2,
  EVENT: 3,
  VERSION: 4,
  SETVIEW: 5,
  SOUND: 6,
  TIME: 7,
  PRINT: 8,
  STUFFTEXT: 9,
  SETANGLE: 10,
  SERVERINFO: 11,
  LIGHTSTYLE: 12,
  UPDATEUSERINFO: 13,
  DELTADESCRIPTION: 14,
  CLIENTDATA: 15,
  STOPSOUND: 16,
  PINGS: 17,
  PARTICLE: 18,
  DAMAGE: 19,
  SPAWNSTATIC: 20,
  EVENT_RELIABLE: 21,
  SPAWNBASELINE: 22,
  TEMPENTITY: 23,
  SETPAUSE: 24,
  SIGNONNUM: 25,
  CENTERPRINT: 26,
  KILLEDMONSTER: 27,
  FOUNDSECRET: 28,
  SPAWNSTATICSOUND: 29,
  INTERMISSION: 30,
  FINALE: 31,
  CDTRACK: 32,
  RESTORE: 33,
  CUTSCENE: 34,
  WEAPONANIM: 35,
  DECALNAME: 36,
  ROOMTYPE: 37,
  ADDANGLE: 38,
  NEWUSERMSG: 39,
  PACKETENTITIES: 40,
  DELTAPACKETENTITIES: 41,
  CHOKE: 42,
  RESOURCELIST: 43,
  NEWMOVEVARS: 44,
  RESOURCEREQUEST: 45,
  CUSTOMIZATION: 46,
  CROSSHAIRANGLE: 47,
  SOUNDFADE: 48,
  FILETXFERFAILED: 49,
  HLTV: 50,
  DIRECTOR: 51,
  VOICEINIT: 52,
  VOICEDATA: 53,
  SENDEXTRAINFO: 54,
  TIMESCALE: 55,
  RESOURCELOCATION: 56,
  SENDCVARVALUE: 57,
  SENDCVARVALUE2: 58,
} as const

export type SVC = (typeof SVC)[keyof typeof SVC]

/** Resource kinds in `svc_resourcelist`. */
export const RESOURCE_SOUND = 0
export const RESOURCE_MODEL = 2
export const RESOURCE_EVENT = 5

/** `SND_*` bits in the `svc_sound` flag word. */
const SND_VOLUME = 1 << 0
const SND_ATTENUATION = 1 << 1
const SND_LARGE_INDEX = 1 << 2
const SND_PITCH = 1 << 3
const SND_SENTENCE = 1 << 4
const SND_STOP = 1 << 5

/** One `svc_sound`: the server telling the client to play a precached sample. */
export interface SoundCue {
  /** Index into the sound precache, or a sentence index when `sentence` is set. */
  index: number
  sentence: boolean
  /** Entity the sound is attached to; player slots are 1..maxPlayers. */
  entity: number
  /** Emission point, when the server bothered to send one. */
  origin: [number, number, number] | null
  /** 0..1. */
  volume: number
  /** 100 is unshifted. */
  pitch: number
}

/** One entry of an `svc_event`: a client-side effect script the server fired. */
export interface EventCue {
  /** Index into the event precache (`events/*.sc`). */
  index: number
  /** Entity that fired it, when the delta carried one — usually it does not. */
  entity: number
  /**
   * Slot of the firing entity within the last packet's entity array, or -1.
   *
   * This, not `entindex`, is how the engine identifies a shooter: the server
   * writes the position the entity occupies in the packet it just sent, and the
   * client looks it up in the array it just rebuilt. Packet entities go out in
   * ascending entity-number order and players hold the low numbers, so for a
   * player-fired weapon this resolves to `packetIndex + 1`.
   */
  packetIndex: number
  origin: [number, number, number] | null
  /** Seconds the client should wait before playing it. */
  delay: number
}

export interface UserMessageDef {
  index: number
  /** Fixed payload size, or -1 when the message is length-prefixed. */
  size: number
  name: string
}

/** An entity update carried by `svc_packetentities` / `svc_deltapacketentities`. */
export interface EntityUpdate {
  entityIndex: number
  /** True when the delta stream says this entity left the PVS. */
  removed: boolean
  values: DeltaValues
}

/**
 * Callbacks the replay builder supplies. Everything the viewer does not care
 * about is still *parsed* (so the stream stays in sync) but not reported.
 */
export interface MessageSink {
  onServerInfo?(info: { maxPlayers: number; mapFileName: string; hostName: string }): void
  onTime?(time: number): void
  onResource?(type: number, index: number, name: string): void
  onUserInfo?(slot: number, rawInfo: string): void
  onBaseline?(updates: EntityUpdate[]): void
  onPacketEntities?(updates: EntityUpdate[], delta: boolean): void
  onUserMessage?(def: UserMessageDef, payload: Uint8Array): void
  onPrint?(text: string): void
  onDirector?(payload: Uint8Array): void
  onSound?(sound: SoundCue): void
  onEvent?(event: EventCue): void
  /** Diagnostics: fired for every message with the byte range it consumed. */
  onMessage?(type: number, start: number, end: number): void
}

export interface ParserState {
  /** Set once svc_hltv is seen; changes how svc_clientdata is framed. */
  hltv: boolean
  deltas: DeltaTable
  userMessages: Map<number, UserMessageDef>
  maxPlayers: number
}

/**
 * Parses one netmsg payload, dispatching every message in it.
 *
 * The stream is a packed sequence of `[id][body]` with no length prefixes, so
 * a single mis-sized body desynchronises everything after it. Bodies we do not
 * need are still skipped by their exact size.
 */
export function parseNetMessages(payload: Uint8Array, state: ParserState, sink: MessageSink): void {
  const r = new ByteReader(payload)

  while (r.remaining > 0) {
    const start = r.offset
    const type = r.u8()

    // Everything past the engine's own range is a mod-defined user message.
    if (type > SVC.SENDCVARVALUE2) readUserMessage(r, type, state, sink)
    else readServerMessage(r, type, state, sink)

    sink.onMessage?.(type, start, r.offset)
  }
}

function readUserMessage(r: ByteReader, type: number, state: ParserState, sink: MessageSink): void {
  const def = state.userMessages.get(type)
  // Unregistered ids can only be length-prefixed; guessing any other size
  // would desync the rest of the packet.
  const size = def && def.size > -1 ? def.size : r.u8()
  const payload = r.slice(size)
  if (def) sink.onUserMessage?.(def, payload)
}

function readServerMessage(r: ByteReader, type: number, state: ParserState, sink: MessageSink): void {
  switch (type) {
    case SVC.BAD:
      throw new Error('svc_bad encountered — network stream is desynchronised')

    case SVC.NOP:
      return

    case SVC.DISCONNECT:
      r.str()
      return

    case SVC.EVENT:
      readEvents(r, state, sink)
      return

    case SVC.VERSION:
      r.u32()
      return

    case SVC.SETVIEW:
      r.i16()
      return

    case SVC.SOUND:
      readSound(r, sink)
      return

    case SVC.TIME: {
      // NB: read into a local first. `sink.onTime?.(r.f32())` would skip the
      // read entirely when no handler is installed, desynchronising the stream.
      const time = r.f32()
      sink.onTime?.(time)
      return
    }

    case SVC.PRINT: {
      const text = r.str()
      sink.onPrint?.(text)
      return
    }

    case SVC.STUFFTEXT:
      r.str()
      return

    case SVC.SETANGLE:
      r.skip(6)
      return

    case SVC.SERVERINFO:
      readServerInfo(r, state, sink)
      return

    case SVC.LIGHTSTYLE:
      r.u8()
      r.str()
      return

    case SVC.UPDATEUSERINFO: {
      const slot = r.u8()
      r.u32() // user id
      const info = r.str()
      r.skip(16) // CD key hash
      sink.onUserInfo?.(slot, info)
      return
    }

    case SVC.DELTADESCRIPTION: {
      const name = r.str()
      const fieldCount = r.u16()
      const bs = new BitReader(r.bytes, r.offset)
      readDeltaDescription(bs, state.deltas, name, fieldCount)
      r.seek(bs.byteAlignedEnd())
      return
    }

    case SVC.CLIENTDATA:
      // HLTV proxies emit svc_clientdata as a bare marker: there is no local
      // client to describe, so the message carries no body at all. Parsing one
      // anyway would swallow the following message and desync the packet.
      if (!state.hltv) readClientData(r, state)
      return

    case SVC.STOPSOUND:
      r.skip(2)
      return

    case SVC.PINGS:
      readPings(r)
      return

    case SVC.PARTICLE:
      r.skip(11)
      return

    case SVC.DAMAGE:
      return

    case SVC.SPAWNSTATIC:
      readSpawnStatic(r)
      return

    case SVC.EVENT_RELIABLE:
      readEventReliable(r, state)
      return

    case SVC.SPAWNBASELINE:
      readSpawnBaseline(r, state, sink)
      return

    case SVC.TEMPENTITY:
      readTempEntity(r)
      return

    case SVC.SETPAUSE:
      r.skip(1)
      return

    case SVC.SIGNONNUM:
      r.skip(1)
      return

    case SVC.CENTERPRINT:
      r.str()
      return

    case SVC.KILLEDMONSTER:
    case SVC.FOUNDSECRET:
    case SVC.INTERMISSION:
      return

    case SVC.SPAWNSTATICSOUND:
      r.skip(14)
      return

    case SVC.FINALE:
    case SVC.CUTSCENE:
      r.str()
      return

    case SVC.CDTRACK:
      r.skip(2)
      return

    case SVC.RESTORE: {
      r.str()
      const mapCount = r.u8()
      for (let i = 0; i < mapCount; i++) r.str()
      return
    }

    case SVC.WEAPONANIM:
      r.skip(2)
      return

    case SVC.DECALNAME:
      r.u8()
      r.str()
      return

    case SVC.ROOMTYPE:
      r.skip(2)
      return

    case SVC.ADDANGLE:
      r.skip(2)
      return

    case SVC.NEWUSERMSG: {
      const def: UserMessageDef = { index: r.u8(), size: r.i8(), name: r.strFixed(16) }
      state.userMessages.set(def.index, def)
      return
    }

    case SVC.PACKETENTITIES: {
      const updates = readPacketEntities(r, state, false)
      sink.onPacketEntities?.(updates, false)
      return
    }

    case SVC.DELTAPACKETENTITIES: {
      const updates = readPacketEntities(r, state, true)
      sink.onPacketEntities?.(updates, true)
      return
    }

    case SVC.CHOKE:
      return

    case SVC.RESOURCELIST:
      readResourceList(r, sink)
      return

    case SVC.NEWMOVEVARS:
      r.skip(4 * 16 + 1 + 4 * 8)
      r.str() // sky name
      return

    case SVC.RESOURCEREQUEST:
      r.skip(8)
      return

    case SVC.CUSTOMIZATION: {
      r.skip(2)
      r.str()
      r.skip(2 + 4)
      const flags = r.u8()
      if (flags & 4) r.skip(16)
      return
    }

    case SVC.CROSSHAIRANGLE:
      r.skip(2)
      return

    case SVC.SOUNDFADE:
      r.skip(4)
      return

    case SVC.FILETXFERFAILED:
      r.str()
      return

    case SVC.HLTV:
      state.hltv = true
      r.skip(1)
      return

    case SVC.DIRECTOR: {
      const length = r.u8()
      const payload = r.slice(length)
      sink.onDirector?.(payload)
      return
    }

    case SVC.VOICEINIT:
      r.str()
      r.skip(1)
      return

    case SVC.VOICEDATA: {
      r.u8()
      const size = r.u16()
      r.skip(size)
      return
    }

    case SVC.SENDEXTRAINFO:
      r.str()
      r.skip(1)
      return

    case SVC.TIMESCALE:
      r.skip(4)
      return

    case SVC.RESOURCELOCATION:
      r.str()
      return

    case SVC.SENDCVARVALUE:
      r.str()
      return

    case SVC.SENDCVARVALUE2:
      r.skip(4)
      r.str()
      return

    default:
      throw new Error(`Unhandled svc message ${type}`)
  }
}

// --- individual message bodies -------------------------------------------

function readServerInfo(r: ByteReader, state: ParserState, sink: MessageSink): void {
  r.i32() // protocol
  r.i32() // spawn count
  r.i32() // map CRC
  r.skip(16) // client dll hash
  const maxPlayers = r.u8()
  r.u8() // this client's player index
  r.u8() // deathmatch flag
  r.str() // game dir
  const hostName = r.str()
  const mapFileName = r.str()
  r.str() // map cycle
  r.skip(1)
  state.maxPlayers = maxPlayers
  sink.onServerInfo?.({ maxPlayers, mapFileName, hostName })
}

function readSound(r: ByteReader, sink: MessageSink): void {
  const bs = new BitReader(r.bytes, r.offset)
  const flags = bs.read(9)
  const volume = flags & SND_VOLUME ? bs.read(8) / 255 : 1
  if (flags & SND_ATTENUATION) bs.skip(8)
  bs.skip(3) // channel
  const entity = bs.read(11)
  const index = bs.read(flags & SND_LARGE_INDEX ? 16 : 8)

  // Each axis is present only if its flag bit is set.
  const present = [bs.read(1), bs.read(1), bs.read(1)]
  const coords = present.map((flag) => (flag ? bs.readCoord() : 0))
  const origin = present.some(Boolean) ? ([coords[0], coords[1], coords[2]] as [number, number, number]) : null

  const pitch = flags & SND_PITCH ? bs.read(8) : 100
  r.seek(bs.byteAlignedEnd())

  // `SND_STOP` silences a channel rather than starting anything.
  if (!(flags & SND_STOP)) {
    sink.onSound?.({ index, sentence: (flags & SND_SENTENCE) !== 0, entity, origin, volume, pitch })
  }
}

function readEvents(r: ByteReader, state: ParserState, sink: MessageSink): void {
  const bs = new BitReader(r.bytes, r.offset)
  const count = bs.read(5)
  for (let i = 0; i < count; i++) {
    const index = bs.read(10)
    let args: Record<string, number | string> | null = null
    // Identifies the firing entity by its slot in the last packet's entity
    // list rather than by number. See `EventCue.packetIndex`.
    let packetIndex = -1
    if (bs.read(1)) {
      packetIndex = bs.read(11)
      if (bs.read(1)) args = readDelta(bs, state.deltas.event_t)
    }
    // Sent as 1/100ths of a second.
    const delay = bs.read(1) ? bs.read(16) / 100 : 0

    const at = (key: string): number => (typeof args?.[key] === 'number' ? (args[key] as number) : 0)
    const hasOrigin = args !== null && ('origin[0]' in args || 'origin[1]' in args || 'origin[2]' in args)
    sink.onEvent?.({
      index,
      entity: at('entindex'),
      packetIndex,
      origin: hasOrigin ? [at('origin[0]'), at('origin[1]'), at('origin[2]')] : null,
      delay
    })
  }
  r.seek(bs.byteAlignedEnd())
}

function readEventReliable(r: ByteReader, state: ParserState): void {
  const bs = new BitReader(r.bytes, r.offset)
  bs.skip(10) // event index
  readDelta(bs, state.deltas.event_t)
  if (bs.read(1)) bs.skip(16) // delay
  r.seek(bs.byteAlignedEnd())
}

function readClientData(r: ByteReader, state: ParserState): void {
  const bs = new BitReader(r.bytes, r.offset)
  if (bs.read(1)) bs.skip(8) // delta sequence number
  readDelta(bs, state.deltas.clientdata_t)
  // Zero or more weapon slots, each flagged by a leading set bit.
  while (bs.read(1)) {
    bs.skip(6) // weapon index
    readDelta(bs, state.deltas.weapon_data_t)
  }
  r.seek(bs.byteAlignedEnd())
}

function readPings(r: ByteReader): void {
  const bs = new BitReader(r.bytes, r.offset)
  while (bs.read(1)) bs.skip(24) // slot, ping, loss
  r.seek(bs.byteAlignedEnd())
}

function readSpawnStatic(r: ByteReader): void {
  r.skip(2 + 1 + 1 + 2 + 1) // model index, sequence, frame, colormap, skin
  r.skip(3 * 3) // interleaved position (short) + rotation (byte) per axis
  const renderMode = r.i8()
  if (renderMode) r.skip(1 + 3 + 1) // amount, colour, fx
}

function readResourceList(r: ByteReader, sink: MessageSink): void {
  const bs = new BitReader(r.bytes, r.offset)
  const count = bs.read(12)
  for (let i = 0; i < count; i++) {
    const type = bs.read(4)
    const name = bs.readString()
    const index = bs.read(12)
    bs.skip(24) // download size
    const flags = bs.read(3)
    if (flags & 4) bs.skip(128) // md5 hash
    if (bs.read(1)) bs.skip(256) // extra info
    sink.onResource?.(type, index, name)
  }
  // Optional consistency list.
  if (bs.read(1)) {
    while (bs.read(1)) bs.skip(bs.read(1) ? 5 : 10)
  }
  r.seek(bs.byteAlignedEnd())
}

/** Chooses the delta layout for an entity, which depends on its slot. */
function entityLayout(state: ParserState, entityIndex: number, custom: boolean): string {
  // Slots 1..maxPlayers are players and use the wider player layout.
  if (entityIndex > 0 && entityIndex <= state.maxPlayers) return 'entity_state_player_t'
  return custom ? 'custom_entity_state_t' : 'entity_state_t'
}

function readSpawnBaseline(r: ByteReader, state: ParserState, sink: MessageSink): void {
  const bs = new BitReader(r.bytes, r.offset)
  const updates: EntityUpdate[] = []

  for (;;) {
    const entityIndex = bs.read(11)
    if (entityIndex === (1 << 11) - 1) break // 0x7FF terminates the list

    const kind = bs.read(2)
    const layout = kind & 1 ? entityLayout(state, entityIndex, false) : 'custom_entity_state_t'
    updates.push({ entityIndex, removed: false, values: readDelta(bs, state.deltas[layout]) })
  }

  const footer = bs.read(5)
  if (footer !== (1 << 5) - 1) {
    throw new Error('Corrupt svc_spawnbaseline footer')
  }

  // "Extra" baselines used by the client for prediction; parsed to stay in sync.
  const extraCount = bs.read(6)
  for (let i = 0; i < extraCount; i++) readDelta(bs, state.deltas.entity_state_t)

  r.seek(bs.byteAlignedEnd())
  sink.onBaseline?.(updates)
}

/**
 * Reads an entity packet.
 *
 * Entity numbers are written as a delta against a running cursor: one bit
 * says "the next entity", otherwise a second bit chooses between an 11-bit
 * absolute number and a 6-bit relative jump. A 16-bit zero word terminates.
 */
function readPacketEntities(r: ByteReader, state: ParserState, delta: boolean): EntityUpdate[] {
  const bs = new BitReader(r.bytes, r.offset)
  bs.skip(16) // entity count — not trustworthy, the terminator is authoritative
  if (delta) bs.skip(8) // delta sequence number

  const updates: EntityUpdate[] = []
  let entityIndex = 0

  for (;;) {
    if (bs.bitsLeft < 16 || bs.peek(16) === 0) {
      bs.skip(16)
      break
    }

    let removed = false
    if (delta) {
      removed = bs.read(1) !== 0
      if (bs.read(1)) entityIndex = bs.read(11)
      else entityIndex += bs.read(6)
    } else if (bs.read(1)) {
      // Non-delta packets have no removal bit; a leading 1 means "next slot".
      entityIndex++
    } else if (bs.read(1)) {
      entityIndex = bs.read(11)
    } else {
      entityIndex += bs.read(6)
    }

    if (removed) {
      updates.push({ entityIndex, removed: true, values: {} })
      continue
    }

    const custom = bs.read(1) !== 0
    if (!delta && bs.read(1)) bs.skip(6) // baseline index

    const layout = entityLayout(state, entityIndex, custom)
    updates.push({ entityIndex, removed: false, values: readDelta(bs, state.deltas[layout]) })
  }

  r.seek(bs.byteAlignedEnd())
  return updates
}

/**
 * Fixed payload sizes for `svc_temp_entity` effects, indexed by TE type.
 * Anything absent from this table is either variable-length (handled below)
 * or unused by Counter-Strike.
 */
const TEMP_ENTITY_SIZES: Record<number, number> = {
  0: 24, 1: 20, 2: 6, 3: 11, 4: 6, 5: 10, 6: 12, 7: 17, 8: 16, 9: 6,
  10: 6, 11: 6, 12: 8, 14: 9, 15: 19, 17: 10, 18: 16, 19: 24, 20: 24,
  21: 24, 22: 10, 23: 11, 24: 16, 25: 19, 27: 12, 28: 16, 30: 17, 31: 17,
  99: 2, 100: 10, 101: 14, 102: 12, 103: 14, 104: 9, 105: 5, 106: 17,
  107: 13, 108: 24, 109: 9, 110: 17, 111: 7, 112: 10, 113: 19, 114: 19,
  115: 12, 116: 7, 117: 7, 118: 9, 119: 16, 120: 18, 121: 5, 122: 10,
  123: 9, 124: 7, 125: 1, 126: 18, 127: 15
}

const TE_BSPDECAL = 13
const TE_TEXTMESSAGE = 29

function readTempEntity(r: ByteReader): void {
  const type = r.u8()

  if (type === TE_BSPDECAL) {
    r.skip(8)
    const entityIndex = r.i16()
    if (entityIndex) r.skip(2)
    return
  }

  if (type === TE_TEXTMESSAGE) {
    r.skip(1 + 2 + 2) // channel, x, y
    const effect = r.i8()
    r.skip(4 + 4) // text colour, effect colour
    r.skip(2 + 2 + 2) // fade in, fade out, hold
    if (effect) r.skip(2) // effect time
    r.str()
    return
  }

  const size = TEMP_ENTITY_SIZES[type]
  if (size === undefined) {
    throw new Error(`Unknown temp entity type ${type}`)
  }
  r.skip(size)
}
