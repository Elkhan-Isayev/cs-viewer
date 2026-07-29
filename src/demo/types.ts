/** Frame kinds in the GoldSrc demo container. */
export const FrameType = {
  /** Network message frame; the payload is a chunk of the server's netchan stream. */
  NetMsgStart: 0,
  NetMsg: 1,
  DemoStart: 2,
  ConsoleCommand: 3,
  ClientData: 4,
  NextSection: 5,
  Event: 6,
  WeaponAnim: 7,
  Sound: 8,
  DemoBuffer: 9
} as const

export type FrameType = (typeof FrameType)[keyof typeof FrameType]

export interface DemoHeader {
  magic: string
  demoProtocol: number
  netProtocol: number
  mapName: string
  gameDir: string
  mapCrc: number
  directoryOffset: number
}

export interface DirectoryEntry {
  type: number
  description: string
  flags: number
  cdTrack: number
  trackTime: number
  frameCount: number
  offset: number
  length: number
}

export interface FrameHeader {
  type: FrameType
  time: number
  frame: number
  /** Byte offset of the frame's payload (just past the 9-byte header). */
  bodyOffset: number
}

/** The per-frame view/movement block that precedes a netmsg payload. */
export interface NetMsgInfo {
  timestamp: number
  /** Recording client's eye position. All zeros in HLTV demos. */
  viewOrigin: [number, number, number]
  viewAngles: [number, number, number]
  /** Player slot the recording client was viewing, or -1. */
  playerNum: number
  incomingSequence: number
  outgoingSequence: number
}

export interface PlayerInfo {
  slot: number
  userId: number
  name: string
  model: string
  steamId: string
  /** 1 = Terrorist, 2 = Counter-Terrorist, 0 = unassigned/spectator. */
  team: number
  connected: boolean
}

/** One entity's state at a point in time, in demo (Quake) coordinates. */
export interface EntityState {
  entityIndex: number
  origin: [number, number, number]
  angles: [number, number, number]
  modelIndex: number
  sequence: number
  frame: number
  gaitSequence: number
  animTime: number
  health: number
  weaponModel: number
  /** Bit flags from `entity_state_t.effects`. */
  effects: number
  renderMode: number
  /** True while the delta stream is actively updating this entity. */
  alive: boolean
}

export interface Snapshot {
  /** Seconds from the start of the recording. */
  time: number
  entities: Map<number, EntityState>
}

export interface ChatLine {
  time: number
  text: string
}

export interface KillEvent {
  time: number
  attacker: string
  victim: string
  weapon: string
  headshot: boolean
  attackerTeam: number
  victimTeam: number
}

export interface RoundMarker {
  time: number
  label: string
}
