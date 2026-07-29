import { deserializeTrack } from './demo/track.ts'
import type { Replay } from './demo/replay.ts'
import { TEAM_CT, TEAM_T } from './demo/replay.ts'
import type { WorkerResponse } from './demo/worker.ts'
import { Viewer } from './render/viewer.ts'
import { TEAM_COLORS } from './render/players.ts'
import type { CameraMode } from './render/cameraRig.ts'

const ASSET_BASE = '/assets'
/** Dropped into `public/demos/` so the page can offer it with one click. */
const BUNDLED_DEMO = '/demos/demo.dem'

const element = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id)
  if (!found) throw new Error(`Missing element #${id}`)
  return found as T
}

const canvas = element<HTMLCanvasElement>('viewport')
const dropHint = element('drop-hint')
const loading = element('loading')
const loadingBar = element('loading-bar')
const loadingStage = element('loading-stage')
const loadingDetail = element('loading-detail')
const errorPanel = element('error')
const errorMessage = element('error-message')
const sidebar = element('sidebar')
const roster = element('roster')
const feed = element('feed')
const hud = element('hud')
const roundBanner = element('round-banner')
const controls = element('controls')
const help = element('help')

const playButton = element<HTMLButtonElement>('play')
const scrubber = element<HTMLInputElement>('scrubber')
const timeLabel = element('time')
const durationLabel = element('duration')
const speedSelect = element<HTMLSelectElement>('speed')
const modeSelect = element<HTMLSelectElement>('mode')
const followSelect = element<HTMLSelectElement>('follow')
const brightness = element<HTMLInputElement>('brightness')

const viewer = new Viewer({ canvas, assetBaseUrl: ASSET_BASE })

let replay: Replay | null = null
let playing = false
let currentTime = 0
let speed = 1
let lastTick = performance.now()

// --- playback clock -------------------------------------------------------

function tick(): number {
  const now = performance.now()
  const delta = (now - lastTick) / 1000
  lastTick = now

  if (playing && replay) {
    currentTime += delta * speed
    if (currentTime >= replay.duration) {
      currentTime = replay.duration
      setPlaying(false)
    }
    syncTransport()
  }
  return currentTime
}

function setPlaying(value: boolean): void {
  playing = value
  playButton.textContent = value ? '❚❚' : '▶'
}

function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(total / 60)
  return `${minutes}:${String(total % 60).padStart(2, '0')}`
}

let lastRosterUpdate = -1

function syncTransport(): void {
  if (!replay) return
  timeLabel.textContent = formatTime(currentTime)
  scrubber.value = String(Math.round((currentTime / replay.duration) * 1000))

  // The roster and kill feed change slowly; refreshing them every frame would
  // rebuild the DOM 60 times a second for no visible gain.
  if (Math.abs(currentTime - lastRosterUpdate) > 0.4) {
    lastRosterUpdate = currentTime
    renderRoster()
    renderFeed()
    renderRoundBanner()
  }
}

function seek(seconds: number): void {
  if (!replay) return
  currentTime = Math.min(Math.max(seconds, 0), replay.duration)
  syncTransport()
}

// --- sidebar --------------------------------------------------------------

function renderRoster(): void {
  if (!replay) return
  const present = viewer.presentPlayers(currentTime)
  const groups: Record<number, typeof present> = { [TEAM_T]: [], [TEAM_CT]: [], 0: [] }
  for (const entry of present) (groups[entry.team] ?? groups[0]).push(entry)

  roster.replaceChildren()
  for (const [team, label, className] of [
    [TEAM_T, 'Terrorists', 't'],
    [TEAM_CT, 'Counter-Terrorists', 'ct'],
    [0, 'Unassigned', '']
  ] as const) {
    const members = groups[team]
    if (!members?.length) continue

    const group = document.createElement('div')
    group.className = 'team-group'
    const heading = document.createElement('div')
    heading.className = `team-label ${className}`
    heading.textContent = `${label} (${members.length})`
    group.append(heading)

    for (const { player } of members) {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'roster-row' + (player.slot === viewer.followSlot ? ' active' : '')
      const dot = document.createElement('span')
      dot.className = 'dot'
      dot.style.background = `#${(TEAM_COLORS[team] ?? TEAM_COLORS[0]).toString(16).padStart(6, '0')}`
      const name = document.createElement('span')
      name.className = 'name'
      name.textContent = player.name
      row.append(dot, name)
      row.addEventListener('click', () => {
        viewer.followSlot = player.slot
        followSelect.value = String(player.slot)
        renderRoster()
      })
      group.append(row)
    }
    roster.append(group)
  }
}

function renderFeed(): void {
  if (!replay) return
  const recent = replay.kills.filter((k) => k.time <= currentTime && k.time > currentTime - 12).slice(-6)
  feed.replaceChildren()
  for (const kill of recent) {
    const row = document.createElement('div')
    row.className = 'kill-row'
    const attacker = document.createElement('span')
    attacker.className = 'a'
    attacker.textContent = kill.attacker
    const victim = document.createElement('span')
    victim.className = 'a'
    victim.textContent = kill.victim
    row.append(attacker, ` — ${kill.weapon}${kill.headshot ? ' ' : ' '} → `, victim)
    if (kill.headshot) {
      const hs = document.createElement('span')
      hs.className = 'hs'
      hs.textContent = ' HS'
      row.append(hs)
    }
    feed.append(row)
  }
}

function renderRoundBanner(): void {
  if (!replay) return
  const marker = [...replay.rounds].reverse().find((r) => r.time <= currentTime && r.time > currentTime - 6)
  roundBanner.textContent = marker?.label ?? ''
  roundBanner.classList.toggle('show', Boolean(marker))
}

function fillFollowSelect(): void {
  if (!replay) return
  followSelect.replaceChildren()
  for (const player of replay.players) {
    const option = document.createElement('option')
    option.value = String(player.slot)
    option.textContent = player.name
    followSelect.append(option)
  }
  if (viewer.followSlot !== null) followSelect.value = String(viewer.followSlot)
}

// --- loading --------------------------------------------------------------

function showError(message: string): void {
  loading.hidden = true
  errorMessage.textContent = message
  errorPanel.hidden = false
}

function setProgress(fraction: number, stage: string, detail = ''): void {
  loading.hidden = false
  loadingBar.style.width = `${Math.round(fraction * 100)}%`
  loadingStage.textContent = stage
  loadingDetail.textContent = detail
}

async function loadDemo(bytes: ArrayBuffer, label: string): Promise<void> {
  dropHint.hidden = true
  errorPanel.hidden = true
  setProgress(0, 'Decoding demo', label)

  const worker = new Worker(new URL('./demo/worker.ts', import.meta.url), { type: 'module' })

  const parsed = await new Promise<Extract<WorkerResponse, { type: 'done' }>>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data
      if (message.type === 'progress') setProgress(message.fraction * 0.7, message.stage, label)
      else if (message.type === 'done') resolve(message)
      else reject(new Error(message.message))
    }
    worker.onerror = (event) => reject(new Error(event.message || 'Demo worker crashed'))
    worker.postMessage({ bytes }, [bytes])
  }).finally(() => worker.terminate())

  replay = {
    mapName: parsed.mapName,
    hostName: parsed.hostName,
    duration: parsed.duration,
    players: parsed.players.map((player) => ({
      ...player,
      isHltvProxy: false,
      track: deserializeTrack(player.track)
    })),
    models: new Map(parsed.models),
    kills: parsed.kills,
    chat: parsed.chat,
    rounds: parsed.rounds
  }

  setProgress(0.75, 'Loading map', replay.mapName)
  await viewer.loadMap(replay.mapName)

  setProgress(0.95, 'Preparing players')
  viewer.setReplay(replay)

  element('match-map').textContent = `${replay.mapName} · ${replay.players.length} players`
  element('match-server').textContent = replay.hostName
  durationLabel.textContent = formatTime(replay.duration)
  fillFollowSelect()
  renderRoster()

  loading.hidden = true
  sidebar.hidden = false
  controls.hidden = false
  hud.hidden = false
  help.hidden = false

  currentTime = 0
  lastTick = performance.now()
  setPlaying(true)
  viewer.setBrightness(Number(brightness.value))
  viewer.start(tick)
}

function readFile(file: File): void {
  const reader = new FileReader()
  reader.onload = () => {
    void loadDemo(reader.result as ArrayBuffer, file.name).catch((error) =>
      showError(error instanceof Error ? error.message : String(error))
    )
  }
  reader.onerror = () => showError(`Could not read ${file.name}`)
  reader.readAsArrayBuffer(file)
}

// --- input ----------------------------------------------------------------

element<HTMLInputElement>('file-input').addEventListener('change', (event) => {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (file) readFile(file)
})

element('error-dismiss').addEventListener('click', () => {
  errorPanel.hidden = true
  dropHint.hidden = false
})

document.addEventListener('dragover', (event) => event.preventDefault())
document.addEventListener('drop', (event) => {
  event.preventDefault()
  const file = event.dataTransfer?.files?.[0]
  if (file) readFile(file)
})

playButton.addEventListener('click', () => {
  lastTick = performance.now()
  setPlaying(!playing)
})

scrubber.addEventListener('input', () => {
  if (!replay) return
  seek((Number(scrubber.value) / 1000) * replay.duration)
})

speedSelect.addEventListener('change', () => {
  speed = Number(speedSelect.value)
})

modeSelect.addEventListener('change', () => {
  viewer.setMode(modeSelect.value as CameraMode)
})

followSelect.addEventListener('change', () => {
  viewer.followSlot = Number(followSelect.value)
  renderRoster()
})

brightness.addEventListener('input', () => {
  viewer.setBrightness(Number(brightness.value))
})

// Mouse look: orbit in third person, free look when detached.
let dragging = false
canvas.addEventListener('pointerdown', (event) => {
  dragging = true
  canvas.setPointerCapture(event.pointerId)
})
canvas.addEventListener('pointerup', (event) => {
  dragging = false
  canvas.releasePointerCapture(event.pointerId)
})
canvas.addEventListener('pointermove', (event) => {
  if (!dragging) return
  const yaw = event.movementX * 0.005
  const pitch = event.movementY * 0.005
  if (viewer.rig.mode === 'free') viewer.rig.lookFree(yaw, pitch)
  else viewer.rig.orbit(yaw, pitch)
})
canvas.addEventListener('wheel', (event) => {
  event.preventDefault()
  viewer.rig.zoom(event.deltaY * 0.0012)
}, { passive: false })

// Free-camera movement.
const held = new Set<string>()
window.addEventListener('keyup', (event) => held.delete(event.code))
window.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return
  held.add(event.code)

  switch (event.code) {
    case 'Space':
      event.preventDefault()
      lastTick = performance.now()
      setPlaying(!playing)
      return
    case 'ArrowLeft':
      seek(currentTime - 5)
      return
    case 'ArrowRight':
      seek(currentTime + 5)
      return
    case 'Comma':
      cyclePlayer(-1)
      return
    case 'Period':
      cyclePlayer(1)
      return
    case 'Digit1':
      modeSelect.value = 'third-person'
      viewer.setMode('third-person')
      return
    case 'Digit2':
      modeSelect.value = 'eye'
      viewer.setMode('eye')
      return
    case 'Digit3':
      modeSelect.value = 'free'
      viewer.setMode('free')
      return
    default:
  }
})

function cyclePlayer(direction: number): void {
  if (!replay || replay.players.length === 0) return
  const slots = replay.players.map((p) => p.slot)
  const at = slots.indexOf(viewer.followSlot ?? slots[0])
  const next = slots[(at + direction + slots.length) % slots.length]
  viewer.followSlot = next
  followSelect.value = String(next)
  renderRoster()
}

// The free camera needs to keep moving while keys are held, independent of
// whether playback is running.
let lastFreeTick = performance.now()
function freeCameraLoop(): void {
  const now = performance.now()
  const delta = Math.min((now - lastFreeTick) / 1000, 0.1)
  lastFreeTick = now

  if (viewer.rig.mode === 'free') {
    const forward = (held.has('KeyW') ? 1 : 0) - (held.has('KeyS') ? 1 : 0)
    const right = (held.has('KeyD') ? 1 : 0) - (held.has('KeyA') ? 1 : 0)
    const up = (held.has('KeyE') ? 1 : 0) - (held.has('KeyQ') ? 1 : 0)
    if (forward || right || up) {
      viewer.rig.moveFree(forward, right, up, delta, held.has('ShiftLeft') || held.has('ShiftRight'))
    }
  }
  requestAnimationFrame(freeCameraLoop)
}
requestAnimationFrame(freeCameraLoop)

window.addEventListener('resize', () => viewer.resize())

// Offer the bundled demo if one was placed in public/demos/.
void fetch(BUNDLED_DEMO, { method: 'HEAD' }).then((response) => {
  if (!response.ok) return
  const row = element('bundled-row')
  const button = element<HTMLButtonElement>('bundled-button')
  button.textContent = 'Play the bundled demo'
  button.addEventListener('click', () => {
    setProgress(0, 'Downloading demo')
    void fetch(BUNDLED_DEMO)
      .then((r) => r.arrayBuffer())
      .then((bytes) => loadDemo(bytes, 'bundled demo'))
      .catch((error) => showError(String(error)))
  })
  row.hidden = false
})
