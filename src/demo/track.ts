/**
 * A growable, flat sample track: one timestamp plus `stride` floats per sample.
 *
 * Demos run for over an hour at ~16 snapshots per second, so per-sample
 * objects are far too expensive. Everything lands in two typed arrays that the
 * viewer can binary-search and interpolate directly.
 */
export class SampleTrack {
  readonly stride: number
  times: Float32Array
  data: Float32Array
  count = 0

  constructor(stride: number, capacity = 256) {
    this.stride = stride
    this.times = new Float32Array(capacity)
    this.data = new Float32Array(capacity * stride)
  }

  push(time: number, values: ArrayLike<number>): void {
    if (this.count === this.times.length) this.grow()
    this.times[this.count] = time
    this.data.set(values, this.count * this.stride)
    this.count++
  }

  private grow(): void {
    const times = new Float32Array(this.times.length * 2)
    times.set(this.times)
    this.times = times
    const data = new Float32Array(this.data.length * 2)
    data.set(this.data)
    this.data = data
  }

  /** Trims the backing arrays to exactly `count` samples. */
  compact(): void {
    this.times = this.times.slice(0, this.count)
    this.data = this.data.slice(0, this.count * this.stride)
  }

  /** Index of the last sample at or before `time`, or -1 if `time` precedes the track. */
  indexAt(time: number): number {
    let lo = 0
    let hi = this.count - 1
    let best = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (this.times[mid] <= time) {
        best = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    return best
  }

  valueAt(index: number, component: number): number {
    return this.data[index * this.stride + component]
  }
}

/** A serialisable snapshot of a track, cheap to hand across a worker boundary. */
export interface SerialTrack {
  stride: number
  count: number
  times: Float32Array
  data: Float32Array
}

export function serializeTrack(track: SampleTrack): SerialTrack {
  track.compact()
  return { stride: track.stride, count: track.count, times: track.times, data: track.data }
}

export function deserializeTrack(serial: SerialTrack): SampleTrack {
  const track = new SampleTrack(serial.stride, 1)
  track.times = serial.times
  track.data = serial.data
  track.count = serial.count
  return track
}
