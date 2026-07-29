import { ByteReader } from '../core/ByteReader.ts'
import { FrameType, type DemoHeader, type DirectoryEntry, type FrameHeader, type NetMsgInfo } from './types.ts'

export const DEMO_HEADER_SIZE = 544
export const DIRECTORY_ENTRY_SIZE = 92

/**
 * Size of the fixed block between a netmsg frame header and its payload
 * length. It is `float timestamp` (4) + `ref_params_t` (232) +
 * `usercmd_t` (52) + `movevars_t` (132) + `vec3 view` (12) +
 * `int viewmodel` (4) + seven netchan sequence ints (28) = 464.
 */
export const NETMSG_INFO_SIZE = 464

// Offsets within that block.
const OFF_REF_PARAMS = 4
const OFF_REF_VIEWORG = OFF_REF_PARAMS + 0
const OFF_REF_VIEWANGLES = OFF_REF_PARAMS + 12
const OFF_REF_PLAYERNUM = OFF_REF_PARAMS + 196
const OFF_SEQUENCES = 436

export function readHeader(bytes: Uint8Array): DemoHeader {
  const r = new ByteReader(bytes)
  const magic = r.strFixed(8)
  if (magic !== 'HLDEMO') {
    throw new Error(`Not a GoldSrc demo: magic is "${magic}", expected "HLDEMO"`)
  }
  const header: DemoHeader = {
    magic,
    demoProtocol: r.i32(),
    netProtocol: r.i32(),
    mapName: r.strFixed(260),
    gameDir: r.strFixed(260),
    mapCrc: r.i32(),
    directoryOffset: r.i32()
  }
  if (header.demoProtocol !== 5) {
    throw new Error(`Unsupported demo protocol ${header.demoProtocol} (only 5 is supported)`)
  }
  return header
}

export function readDirectory(bytes: Uint8Array, header: DemoHeader): DirectoryEntry[] {
  const r = new ByteReader(bytes, header.directoryOffset)
  const count = r.i32()
  if (count < 0 || count > 1024) {
    throw new Error(`Demo directory is corrupt (claims ${count} entries)`)
  }
  const entries: DirectoryEntry[] = []
  for (let i = 0; i < count; i++) {
    entries.push({
      type: r.i32(),
      description: r.strFixed(64),
      flags: r.i32(),
      cdTrack: r.i32(),
      trackTime: r.f32(),
      frameCount: r.i32(),
      offset: r.i32(),
      length: r.i32()
    })
  }
  return entries
}

/** Reads the 9-byte frame header at `offset`. */
export function readFrameHeader(r: ByteReader, offset: number): FrameHeader {
  r.seek(offset)
  const type = r.u8() as FrameType
  const time = r.f32()
  const frame = r.i32()
  return { type, time, frame, bodyOffset: r.offset }
}

export function readNetMsgInfo(bytes: Uint8Array, bodyOffset: number): NetMsgInfo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const f = (o: number) => view.getFloat32(bodyOffset + o, true)
  const i = (o: number) => view.getInt32(bodyOffset + o, true)
  return {
    timestamp: f(0),
    viewOrigin: [f(OFF_REF_VIEWORG), f(OFF_REF_VIEWORG + 4), f(OFF_REF_VIEWORG + 8)],
    viewAngles: [f(OFF_REF_VIEWANGLES), f(OFF_REF_VIEWANGLES + 4), f(OFF_REF_VIEWANGLES + 8)],
    playerNum: i(OFF_REF_PLAYERNUM),
    incomingSequence: i(OFF_SEQUENCES),
    outgoingSequence: i(OFF_SEQUENCES + 16)
  }
}

/**
 * Returns the byte offset of the frame following the one whose header is
 * `frame`, or -1 when this frame ends the section.
 *
 * Every frame kind has a fixed body size except netmsg (length-prefixed),
 * sound (embedded sample name) and the demo buffer blob.
 */
export function nextFrameOffset(r: ByteReader, frame: FrameHeader): number {
  const at = frame.bodyOffset
  switch (frame.type) {
    case FrameType.NetMsgStart:
    case FrameType.NetMsg: {
      const length = r.seek(at + NETMSG_INFO_SIZE).i32()
      return at + NETMSG_INFO_SIZE + 4 + length
    }
    case FrameType.DemoStart:
      return at
    case FrameType.ConsoleCommand:
      return at + 64
    case FrameType.ClientData:
      return at + 32
    case FrameType.NextSection:
      return -1
    case FrameType.Event:
      return at + 84
    case FrameType.WeaponAnim:
      return at + 8
    case FrameType.Sound: {
      const sampleLength = r.seek(at + 4).i32()
      // channel + sample length + sample + attenuation, volume, flags, pitch
      return at + 8 + sampleLength + 16
    }
    case FrameType.DemoBuffer: {
      const length = r.seek(at).i32()
      return at + 4 + length
    }
    default:
      throw new Error(`Unknown demo frame type ${frame.type} at offset ${frame.bodyOffset - 9}`)
  }
}

/** Returns the netmsg payload for a netmsg frame. */
export function netMsgPayload(r: ByteReader, frame: FrameHeader): Uint8Array {
  const at = frame.bodyOffset + NETMSG_INFO_SIZE
  const length = r.seek(at).i32()
  return r.slice(length)
}
