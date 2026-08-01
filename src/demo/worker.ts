/**
 * Decodes a demo off the main thread.
 *
 * A 50 MB HLTV recording is ~140,000 frames; doing that inline would freeze
 * the page for the better part of a second and block the loading UI.
 */
import { parseReplay, type Replay } from './replay.ts'
import { serializeTrack, type SerialTrack } from './track.ts'
import type { ChatLine, KillEvent, RoundMarker } from './types.ts'
import type { SoundEvent, TeamChange } from './replay.ts'

export interface WorkerRequest {
  bytes: ArrayBuffer
}

export interface SerialPlayer {
  slot: number
  name: string
  steamId: string
  model: string
  team: number
  teamChanges: TeamChange[]
  track: SerialTrack
}

export type WorkerResponse =
  | { type: 'progress'; fraction: number; stage: string }
  | {
      type: 'done'
      mapName: string
      hostName: string
      duration: number
      players: SerialPlayer[]
      models: [number, string][]
      kills: KillEvent[]
      chat: ChatLine[]
      rounds: RoundMarker[]
      sounds: SoundEvent[]
    }
  | { type: 'error'; message: string }

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  try {
    let lastPosted = 0
    const replay: Replay = parseReplay(new Uint8Array(event.data.bytes), (progress) => {
      // Throttle: posting on every chunk costs more than the parse itself.
      const now = performance.now()
      if (now - lastPosted < 80 && progress.fraction < 1) return
      lastPosted = now
      post({ type: 'progress', fraction: progress.fraction, stage: progress.stage })
    })

    const players: SerialPlayer[] = replay.players.map((player) => ({
      slot: player.slot,
      name: player.name,
      steamId: player.steamId,
      model: player.model,
      team: player.team,
      teamChanges: player.teamChanges,
      track: serializeTrack(player.track)
    }))

    const transfers: ArrayBuffer[] = []
    for (const player of players) {
      transfers.push(player.track.times.buffer as ArrayBuffer, player.track.data.buffer as ArrayBuffer)
    }

    post(
      {
        type: 'done',
        mapName: replay.mapName,
        hostName: replay.hostName,
        duration: replay.duration,
        players,
        models: [...replay.models],
        kills: replay.kills,
        chat: replay.chat,
        rounds: replay.rounds,
        sounds: replay.sounds
      },
      transfers
    )
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}

function post(message: WorkerResponse, transfers: ArrayBuffer[] = []): void {
  ;(self as unknown as Worker).postMessage(message, transfers)
}
