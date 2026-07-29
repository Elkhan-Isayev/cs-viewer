import type { BitReader } from '../core/BitReader.ts'

/** Field type flags from GoldSrc's `delta_description_t.fieldType`. */
export const DT = {
  BYTE: 1 << 0,
  SHORT: 1 << 1,
  FLOAT: 1 << 2,
  INTEGER: 1 << 3,
  ANGLE: 1 << 4,
  TIMEWINDOW_8: 1 << 5,
  TIMEWINDOW_BIG: 1 << 6,
  STRING: 1 << 7,
  SIGNED: 1 << 31
} as const

export interface DeltaField {
  name: string
  bits: number
  divisor: number
  flags: number
}

/** One named delta layout, e.g. `entity_state_player_t`. */
export type DeltaDecoder = DeltaField[]

/** All layouts the server described to us, keyed by struct name. */
export type DeltaTable = Record<string, DeltaDecoder>

/** A decoded struct: field name -> numeric or string value. */
export type DeltaValues = Record<string, number | string>

/**
 * The bootstrap layout. `svc_deltadescription` messages are themselves delta
 * encoded, using this fixed description of `delta_description_t` to decode the
 * descriptions of every other struct.
 */
const DELTA_DESCRIPTION_T: DeltaDecoder = [
  { name: 'flags', bits: 32, divisor: 1, flags: DT.INTEGER },
  { name: 'name', bits: 8, divisor: 1, flags: DT.STRING },
  { name: 'offset', bits: 16, divisor: 1, flags: DT.INTEGER },
  { name: 'size', bits: 8, divisor: 1, flags: DT.INTEGER },
  { name: 'bits', bits: 8, divisor: 1, flags: DT.INTEGER },
  { name: 'divisor', bits: 32, divisor: 4000, flags: DT.FLOAT },
  { name: 'preMultiplier', bits: 32, divisor: 4000, flags: DT.FLOAT }
]

export function createDeltaTable(): DeltaTable {
  return { delta_description_t: DELTA_DESCRIPTION_T.slice() }
}

/**
 * Reads one delta-encoded struct.
 *
 * Layout: a 3-bit count of mask bytes, that many mask bytes, then one encoded
 * value per set mask bit — in field order. Fields whose bit is clear are
 * simply absent and keep whatever the caller already had.
 */
export function readDelta(bs: BitReader, decoder: DeltaDecoder): DeltaValues {
  const out: DeltaValues = {}
  const maskByteCount = bs.read(3)
  const mask: number[] = []
  for (let i = 0; i < maskByteCount; i++) mask.push(bs.read(8))

  for (let byte = 0; byte < maskByteCount; byte++) {
    for (let bit = 0; bit < 8; bit++) {
      const index = byte * 8 + bit
      // The mask is rounded up to whole bytes, so it can be wider than the
      // field list; the trailing bits are padding.
      if (index >= decoder.length) return out
      if ((mask[byte] & (1 << bit)) === 0) continue

      const field = decoder[index]
      out[field.name] = readField(bs, field)
    }
  }

  return out
}

function readField(bs: BitReader, field: DeltaField): number | string {
  const { flags, bits, divisor } = field

  if (flags & DT.STRING) return bs.readString()

  if (flags & DT.ANGLE) {
    // Angles are stored as a fraction of a full turn across `bits` bits.
    return bs.read(bits) * (360 / (1 << bits))
  }

  // Everything else is an integer-encoded scalar. GoldSrc writes the sign as
  // a separate leading bit rather than using two's complement, so a signed
  // field carries its magnitude in `bits - 1` bits.
  if (flags & DT.SIGNED) {
    const negative = bs.read(1)
    const magnitude = bs.read(bits - 1)
    return (negative ? -magnitude : magnitude) / divisor
  }
  return bs.read(bits) / divisor
}

/**
 * Reads the field descriptions carried by a `svc_deltadescription` message and
 * installs them in the table under `name`.
 */
export function readDeltaDescription(
  bs: BitReader,
  table: DeltaTable,
  name: string,
  fieldCount: number
): DeltaDecoder {
  const fields: DeltaDecoder = []
  for (let i = 0; i < fieldCount; i++) {
    const d = readDelta(bs, table.delta_description_t)
    fields.push({
      name: String(d.name ?? ''),
      bits: Number(d.bits ?? 0),
      // A divisor of 0 would produce Infinity/NaN for every value in the
      // field; treat it as "unscaled", which is what the engine's default is.
      divisor: Number(d.divisor) || 1,
      flags: Number(d.flags ?? 0)
    })
  }
  table[name] = fields
  return fields
}
