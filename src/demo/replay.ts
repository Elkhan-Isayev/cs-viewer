import { ByteReader } from '../core/ByteReader.ts'
import { netMsgPayload, nextFrameOffset, readDirectory, readFrameHeader, readHeader } from './container.ts'
import { createDeltaTable } from './delta.ts'
import { parseNetMessages, RESOURCE_MODEL, type EntityUpdate, type ParserState, type UserMessageDef } from './messages.ts'
import { SampleTrack } from './track.ts'
import { FrameType, type ChatLine, type KillEvent, type RoundMarker } from './types.ts'

/** Floats per player sample. */
export const PLAYER_STRIDE = 11
export const P_X = 0
export const P_Y = 1
export const P_Z = 2
export const P_PITCH = 3
export const P_YAW = 4
export const P_SEQUENCE = 5
export const P_GAIT = 6
export const P_FRAME = 7
export const P_BLEND = 8
export const P_WEAPON_MODEL = 9
/** Precache index of the player model in this frame; teams swap at halftime. */
export const P_MODEL = 10

/** Longest gap between samples before an entity counts as gone from the world. */
const ENTITY_TIMEOUT = 0.75

export const TEAM_UNASSIGNED = 0
export const TEAM_T = 1
export const TEAM_CT = 2

export interface TeamChange {
  time: number
  team: number
}

export interface ReplayPlayer {
  slot: number
  name: string
  steamId: string
  /** Player model short name from the connect-time userinfo, e.g. `leet`. */
  model: string
  /** Team at the end of the recording; use `teamAt` for a point in time. */
  team: number
  /** Team assignments over time — sides swap at halftime. */
  teamChanges: TeamChange[]
  isHltvProxy: boolean
  track: SampleTrack
}

/** Team a player belonged to at `time`. */
export function teamAt(player: ReplayPlayer, time: number): number {
  const changes = player.teamChanges
  let team = TEAM_UNASSIGNED
  for (let i = 0; i < changes.length && changes[i].time <= time; i++) team = changes[i].team
  return team
}

export interface Replay {
  mapName: string
  hostName: string
  /** Playback length in seconds. */
  duration: number
  players: ReplayPlayer[]
  /** Precache index -> model path. */
  models: Map<number, string>
  kills: KillEvent[]
  chat: ChatLine[]
  rounds: RoundMarker[]
}

export interface ParseProgress {
  /** 0..1 */
  fraction: number
  stage: string
}

/** Mutable per-entity accumulator used while walking the delta stream. */
interface LiveEntity {
  values: Record<string, number>
  lastSeen: number
  /** Set once the delta stream has given this entity a real position. */
  hasOrigin: boolean
}

const num = (v: number | string | undefined, fallback = 0): number =>
  typeof v === 'number' ? v : fallback

/** Splits a GoldSrc infostring (`\key\value\key\value`). */
function parseInfoString(info: string): Record<string, string> {
  const out: Record<string, string> = {}
  const parts = info.split('\\')
  // A leading backslash produces an empty first element.
  for (let i = parts[0] === '' ? 1 : 0; i + 1 < parts.length; i += 2) {
    out[parts[i]] = parts[i + 1]
  }
  return out
}

const TEAM_BY_NAME: Record<string, number> = {
  TERRORIST: TEAM_T,
  CT: TEAM_CT
}

/** Round-outcome tokens CS broadcasts through `TextMsg`. */
const ROUND_MESSAGES: Record<string, string> = {
  '#Game_Commencing': 'Game commencing',
  '#Game_will_restart_in': 'Restarting',
  '#Round_Draw': 'Round draw',
  '#Terrorists_Win': 'Terrorists win',
  '#CTs_Win': 'Counter-Terrorists win',
  '#Target_Bombed': 'Target bombed',
  '#Bomb_Defused': 'Bomb defused',
  '#All_Hostages_Rescued': 'Hostages rescued',
  '#Hostages_Not_Rescued': 'Hostages not rescued',
  '#Target_Saved': 'Target saved',
  '#Terrorists_Escaped': 'Terrorists escaped',
  '#CTs_PreventEscape': 'Escape prevented',
  '#VIP_Assassinated': 'VIP assassinated',
  '#VIP_Escaped': 'VIP escaped'
}

export function parseReplay(bytes: Uint8Array, onProgress?: (p: ParseProgress) => void): Replay {
  const header = readHeader(bytes)
  const directory = readDirectory(bytes, header)

  const state: ParserState = {
    hltv: false,
    deltas: createDeltaTable(),
    userMessages: new Map(),
    maxPlayers: 32
  }

  const models = new Map<number, string>()
  const live = new Map<number, LiveEntity>()
  const playerTracks = new Map<number, SampleTrack>()
  const identities = new Map<number, { name: string; steamId: string; model: string; hltv: boolean }>()
  const teams = new Map<number, number>()
  const teamHistory = new Map<number, TeamChange[]>()

  const setTeam = (slot: number, team: number): void => {
    if (teams.get(slot) === team) return
    teams.set(slot, team)
    let history = teamHistory.get(slot)
    if (!history) teamHistory.set(slot, (history = []))
    history.push({ time: frameTime, team })
  }
  const kills: KillEvent[] = []
  const chat: ChatLine[] = []
  const rounds: RoundMarker[] = []

  let hostName = ''
  let frameTime = 0
  let duration = 0
  const scratch = new Float32Array(PLAYER_STRIDE)

  const playerName = (slot: number): string => identities.get(slot)?.name ?? `Player ${slot}`

  const applyUpdates = (updates: EntityUpdate[], delta: boolean): void => {
    if (!delta) {
      // A full snapshot re-states the world; anything it omits is gone.
      live.clear()
    }
    for (const update of updates) {
      if (update.removed) {
        live.delete(update.entityIndex)
        continue
      }
      let entity = live.get(update.entityIndex)
      if (!entity) {
        entity = { values: {}, lastSeen: frameTime, hasOrigin: false }
        live.set(update.entityIndex, entity)
      }
      // Deltas are partial: absent fields keep their previous value.
      for (const [key, value] of Object.entries(update.values)) {
        if (typeof value !== 'number') continue
        entity.values[key] = value
        if (key === 'origin[0]' || key === 'origin[1]') entity.hasOrigin = true
      }
      entity.lastSeen = frameTime
      // Baselines arrive before any position does; sampling them would pin
      // every entity to the world origin for the first frames.
      if (entity.hasOrigin) recordSample(update.entityIndex, entity)
    }
  }

  const recordSample = (index: number, entity: LiveEntity): void => {
    const v = entity.values
    if (index > 0 && index <= state.maxPlayers) {
      let track = playerTracks.get(index)
      if (!track) {
        track = new SampleTrack(PLAYER_STRIDE, 4096)
        playerTracks.set(index, track)
      }
      scratch[P_X] = num(v['origin[0]'])
      scratch[P_Y] = num(v['origin[1]'])
      scratch[P_Z] = num(v['origin[2]'])
      scratch[P_PITCH] = num(v['angles[0]'])
      scratch[P_YAW] = num(v['angles[1]'])
      scratch[P_SEQUENCE] = num(v.sequence)
      scratch[P_GAIT] = num(v.gaitsequence)
      scratch[P_FRAME] = num(v.frame)
      scratch[P_BLEND] = num(v['blending[0]'])
      scratch[P_WEAPON_MODEL] = num(v.weaponmodel)
      scratch[P_MODEL] = num(v.modelindex)
      track.push(frameTime, scratch.subarray(0, PLAYER_STRIDE))
    }
    // Non-player entities (grenades, dropped weapons, the bomb) are decoded but
    // not sampled — nothing draws them yet.
  }

  const handleUserMessage = (def: UserMessageDef, payload: Uint8Array): void => {
    const r = new ByteReader(payload)
    try {
      switch (def.name) {
        case 'TeamInfo': {
          const slot = r.u8()
          setTeam(slot, TEAM_BY_NAME[r.str()] ?? TEAM_UNASSIGNED)
          return
        }
        case 'DeathMsg': {
          const attacker = r.u8()
          const victim = r.u8()
          const headshot = r.u8() !== 0
          const weapon = r.str()
          kills.push({
            time: frameTime,
            attacker: attacker === 0 ? 'World' : playerName(attacker),
            victim: playerName(victim),
            weapon,
            headshot,
            attackerTeam: teams.get(attacker) ?? TEAM_UNASSIGNED,
            victimTeam: teams.get(victim) ?? TEAM_UNASSIGNED
          })
          return
        }
        case 'SayText': {
          r.u8() // sender slot
          // The payload is a localisation token followed by its substitutions
          // (usually the speaker's name and the message); join what is there.
          const parts: string[] = []
          while (r.remaining > 0) {
            const part = r.str().replace(/[\x00-\x1f]/g, '').trim()
            if (part) parts.push(part)
          }
          const named = parts.filter((part) => !part.startsWith('#'))
          const text = (named.length ? named : parts).join(': ')
          if (text) chat.push({ time: frameTime, text })
          return
        }
        case 'TextMsg': {
          r.u8() // destination
          const token = r.str()
          const label = ROUND_MESSAGES[token]
          // CS repeats the restart countdown once per second; keep one marker.
          const previous = rounds[rounds.length - 1]
          if (label && !(previous?.label === label && frameTime - previous.time < 5)) {
            rounds.push({ time: frameTime, label })
          }
          return
        }
        case 'ScoreInfo': {
          const slot = r.u8()
          r.i16() // frags
          r.i16() // deaths
          r.i16() // class
          const team = r.i16()
          if (team === TEAM_T || team === TEAM_CT) setTeam(slot, team)
          return
        }
        default:
          return
      }
    } catch {
      // User-message layouts vary between mods; a malformed one must never
      // abort the parse, since the outer stream stays byte-accurate anyway.
    }
  }

  const sink = {
    onServerInfo: (info: { maxPlayers: number; mapFileName: string; hostName: string }) => {
      hostName = info.hostName
    },
    onResource: (type: number, index: number, name: string) => {
      if (type === RESOURCE_MODEL) models.set(index, name)
    },
    onUserInfo: (slot: number, raw: string) => {
      if (!raw) {
        identities.delete(slot)
        return
      }
      const info = parseInfoString(raw)
      identities.set(slot, {
        name: info.name ?? `Player ${slot}`,
        steamId: info['*sid'] ?? '',
        model: info.model ?? 'terror',
        hltv: info['*hltv'] === '1'
      })
    },
    onBaseline: (updates: EntityUpdate[]) => applyUpdates(updates, false),
    onPacketEntities: (updates: EntityUpdate[], delta: boolean) => applyUpdates(updates, delta),
    onUserMessage: handleUserMessage
  }

  const r = new ByteReader(bytes)
  const playback = directory.find((entry) => entry.type === 1) ?? directory[directory.length - 1]

  for (const entry of directory) {
    let offset = entry.offset
    const end = entry.offset + entry.length
    const isPlayback = entry === playback
    let sinceProgress = 0

    while (offset < end) {
      const frame = readFrameHeader(r, offset)
      if (isPlayback) {
        frameTime = frame.time
        if (frame.time > duration) duration = frame.time
      }

      if (frame.type === FrameType.NetMsg || frame.type === FrameType.NetMsgStart) {
        parseNetMessages(netMsgPayload(r, frame), state, sink)
      }

      if (isPlayback && onProgress && ++sinceProgress >= 4096) {
        sinceProgress = 0
        onProgress({ fraction: (offset - entry.offset) / entry.length, stage: 'Decoding demo' })
      }

      const next = nextFrameOffset(r, frame)
      if (next < 0) break
      offset = next
    }
  }

  const players: ReplayPlayer[] = []
  for (const [slot, track] of playerTracks) {
    const identity = identities.get(slot)
    // The HLTV proxy occupies a player slot but never has a body to draw.
    if (!identity || identity.hltv || track.count === 0) continue
    track.compact()
    players.push({
      slot,
      name: identity.name,
      steamId: identity.steamId,
      model: identity.model,
      team: teams.get(slot) ?? TEAM_UNASSIGNED,
      teamChanges: teamHistory.get(slot) ?? [],
      isHltvProxy: false,
      track
    })
  }
  players.sort((a, b) => a.slot - b.slot)

  onProgress?.({ fraction: 1, stage: 'Ready' })

  return {
    mapName: header.mapName,
    hostName,
    duration,
    players,
    models,
    kills,
    chat,
    rounds
  }
}

export { ENTITY_TIMEOUT }
