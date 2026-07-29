import DemoWorker from '../demo/worker.ts?worker&inline'
import { deserializeTrack } from '../demo/track.ts'
import { TEAM_CT, TEAM_T, type Replay } from '../demo/replay.ts'
import type { WorkerResponse } from '../demo/worker.ts'
import { Viewer } from '../render/viewer.ts'
import { TEAM_COLORS } from '../render/players.ts'
import type { CameraMode } from '../render/cameraRig.ts'
import { WIDGET_CSS } from './styles.ts'

export type DemoSource = string | ArrayBuffer | Uint8Array | Blob

export interface CsViewerOptions {
  /** Demo to load immediately: a URL, a `File`/`Blob`, or raw bytes. */
  demo?: DemoSource
  /** Base URL that serves `maps/` and `models/`. Default `/assets`. */
  assets?: string
  /** Start playing as soon as the demo is ready. Default `true`. */
  autoplay?: boolean
  /** Initial camera. Default `'third-person'`. */
  mode?: CameraMode
  /** Player slot to follow. Defaults to the first player in the recording. */
  follow?: number
  /** Seconds into the recording to start at. Default `0`. */
  startTime?: number
  /** Playback rate. Default `1`. */
  speed?: number
  /** Map lighting multiplier. Default `1.1`. */
  brightness?: number
  /** Show the transport bar. Default `true`. */
  controls?: boolean
  /** Show the team roster and kill feed. Default `true`. */
  roster?: boolean
  /** Draw floating name tags above players. Default `true`. */
  nameTags?: boolean
  /** Handle keyboard shortcuts. Default `true` — turn off if the host page needs the keys. */
  keyboard?: boolean
}

export interface ViewerPlayer {
  slot: number
  name: string
  team: number
}

export interface ReplaySummary {
  mapName: string
  hostName: string
  duration: number
  players: ViewerPlayer[]
  kills: number
  rounds: number
}

export interface CsViewerEvents {
  ready: ReplaySummary
  progress: { fraction: number; stage: string }
  error: Error
  timeupdate: number
  play: void
  pause: void
  followchange: number
}

type Handler<K extends keyof CsViewerEvents> = (payload: CsViewerEvents[K]) => void

const DEFAULTS = {
  assets: '/assets',
  autoplay: true,
  mode: 'third-person' as CameraMode,
  startTime: 0,
  speed: 1,
  brightness: 1.1,
  controls: true,
  roster: true,
  nameTags: true,
  keyboard: true
}

/**
 * The embeddable viewer.
 *
 * Everything it renders lives inside a shadow root attached to the host
 * element, so it can be dropped into any page without colliding with that
 * page's styles, ids or class names.
 */
export class CsViewer {
  readonly element: HTMLElement
  private readonly shadow: ShadowRoot
  private readonly options: Required<Omit<CsViewerOptions, 'demo' | 'follow'>> & CsViewerOptions
  private readonly viewer: Viewer
  private readonly listeners = new Map<string, Set<(payload: never) => void>>()

  private readonly ui: {
    canvas: HTMLCanvasElement
    loading: HTMLElement
    loadingBar: HTMLElement
    loadingStage: HTMLElement
    error: HTMLElement
    errorText: HTMLElement
    sidebar: HTMLElement
    matchMap: HTMLElement
    matchServer: HTMLElement
    roster: HTMLElement
    feedTitle: HTMLElement
    feed: HTMLElement
    banner: HTMLElement
    controls: HTMLElement
    play: HTMLButtonElement
    time: HTMLElement
    duration: HTMLElement
    scrubber: HTMLInputElement
    speed: HTMLSelectElement
    mode: HTMLSelectElement
    follow: HTMLSelectElement
  }

  private replay: Replay | null = null
  private playing = false
  private time = 0
  private rate = 1
  private lastTick = performance.now()
  private lastSidebarSync = -1
  private destroyed = false
  private readonly held = new Set<string>()
  private lastFreeTick = performance.now()
  private resizeObserver: ResizeObserver | null = null

  constructor(element: HTMLElement, options: CsViewerOptions = {}) {
    this.element = element
    this.options = { ...DEFAULTS, ...options }
    this.rate = this.options.speed

    this.shadow = element.shadowRoot ?? element.attachShadow({ mode: 'open' })
    this.shadow.replaceChildren()

    const style = document.createElement('style')
    style.textContent = WIDGET_CSS
    this.shadow.append(style)

    this.ui = this.buildDom()
    this.viewer = new Viewer({ canvas: this.ui.canvas, assetBaseUrl: this.options.assets })
    this.viewer.showNameTags = this.options.nameTags
    this.viewer.setMode(this.options.mode)

    this.bindInput()
    this.observeSize()

    if (options.demo !== undefined) {
      void this.load(options.demo).catch(() => {
        /* surfaced through the error overlay and the 'error' event */
      })
    }
  }

  // --- public API ---------------------------------------------------------

  /** Loads a demo, replacing whatever is playing. Resolves once it is ready. */
  async load(source: DemoSource): Promise<ReplaySummary> {
    const bytes = await this.fetchDemo(source)
    this.showError(null)
    this.setProgress(0, 'Decoding demo')

    const parsed = await this.decode(bytes)
    this.replay = {
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

    this.setProgress(0.75, `Loading ${this.replay.mapName}`)
    await this.viewer.loadMap(this.replay.mapName)

    this.setProgress(0.95, 'Preparing players')
    if (this.options.follow !== undefined) this.viewer.followSlot = this.options.follow
    this.viewer.setReplay(this.replay)
    this.viewer.setBrightness(this.options.brightness)

    this.ui.matchMap.textContent = `${this.replay.mapName} · ${this.replay.players.length} players`
    this.ui.matchServer.textContent = this.replay.hostName
    this.ui.duration.textContent = formatTime(this.replay.duration)
    this.fillFollowSelect()

    this.ui.loading.hidden = true
    this.ui.sidebar.hidden = !this.options.roster
    this.ui.controls.hidden = !this.options.controls

    this.time = Math.min(Math.max(this.options.startTime, 0), this.replay.duration)
    this.lastTick = performance.now()
    this.syncTransport(true)
    this.viewer.start(() => this.tick())

    if (this.options.autoplay) this.play()
    else this.pause()

    const summary = this.summary()
    this.emit('ready', summary)
    return summary
  }

  play(): void {
    if (!this.replay || this.playing) return
    this.playing = true
    this.lastTick = performance.now()
    this.ui.play.textContent = '❚❚'
    this.emit('play', undefined as never)
  }

  pause(): void {
    if (!this.playing) return
    this.playing = false
    this.ui.play.textContent = '▶'
    this.emit('pause', undefined as never)
  }

  toggle(): void {
    this.playing ? this.pause() : this.play()
  }

  seek(seconds: number): void {
    if (!this.replay) return
    this.time = Math.min(Math.max(seconds, 0), this.replay.duration)
    this.syncTransport(true)
  }

  setSpeed(rate: number): void {
    this.rate = rate
    this.ui.speed.value = String(rate)
  }

  setMode(mode: CameraMode): void {
    this.viewer.setMode(mode)
    this.ui.mode.value = mode
  }

  setBrightness(value: number): void {
    this.viewer.setBrightness(value)
  }

  follow(slot: number): void {
    this.viewer.followSlot = slot
    this.ui.follow.value = String(slot)
    this.renderRoster()
    this.emit('followchange', slot)
  }

  players(): ViewerPlayer[] {
    return this.summary().players
  }

  get currentTime(): number {
    return this.time
  }

  get duration(): number {
    return this.replay?.duration ?? 0
  }

  get isPlaying(): boolean {
    return this.playing
  }

  on<K extends keyof CsViewerEvents>(event: K, handler: Handler<K>): () => void {
    let set = this.listeners.get(event)
    if (!set) this.listeners.set(event, (set = new Set()))
    set.add(handler as (payload: never) => void)
    return () => set!.delete(handler as (payload: never) => void)
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.pause()
    this.viewer.dispose()
    this.resizeObserver?.disconnect()
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    this.listeners.clear()
    this.shadow.replaceChildren()
  }

  // --- internals ----------------------------------------------------------

  private summary(): ReplaySummary {
    const replay = this.replay
    if (!replay) {
      return { mapName: '', hostName: '', duration: 0, players: [], kills: 0, rounds: 0 }
    }
    return {
      mapName: replay.mapName,
      hostName: replay.hostName,
      duration: replay.duration,
      players: replay.players.map((p) => ({ slot: p.slot, name: p.name, team: p.team })),
      kills: replay.kills.length,
      rounds: replay.rounds.length
    }
  }

  private async fetchDemo(source: DemoSource): Promise<ArrayBuffer> {
    if (typeof source === 'string') {
      this.setProgress(0, 'Downloading demo')
      const response = await fetch(source)
      if (!response.ok) {
        const error = new Error(`Could not download ${source} (HTTP ${response.status})`)
        this.showError(error.message)
        this.emit('error', error)
        throw error
      }
      return response.arrayBuffer()
    }
    if (source instanceof Blob) return source.arrayBuffer()
    if (source instanceof Uint8Array) {
      return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer
    }
    return source
  }

  private decode(bytes: ArrayBuffer): Promise<Extract<WorkerResponse, { type: 'done' }>> {
    const worker = new DemoWorker()
    return new Promise<Extract<WorkerResponse, { type: 'done' }>>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const message = event.data
        if (message.type === 'progress') {
          this.setProgress(message.fraction * 0.7, message.stage)
          this.emit('progress', { fraction: message.fraction * 0.7, stage: message.stage })
        } else if (message.type === 'done') {
          resolve(message)
        } else {
          reject(new Error(message.message))
        }
      }
      worker.onerror = (event) => reject(new Error(event.message || 'Demo worker failed'))
      worker.postMessage({ bytes }, [bytes])
    })
      .catch((error: Error) => {
        this.showError(error.message)
        this.emit('error', error)
        throw error
      })
      .finally(() => worker.terminate())
  }

  private tick(): number {
    const now = performance.now()
    const delta = (now - this.lastTick) / 1000
    this.lastTick = now

    if (this.playing && this.replay) {
      this.time += delta * this.rate
      if (this.time >= this.replay.duration) {
        this.time = this.replay.duration
        this.pause()
      }
      this.syncTransport(false)
    }

    this.stepFreeCamera(now)
    return this.time
  }

  private stepFreeCamera(now: number): void {
    const delta = Math.min((now - this.lastFreeTick) / 1000, 0.1)
    this.lastFreeTick = now
    if (this.viewer.rig.mode !== 'free') return

    const forward = (this.held.has('KeyW') ? 1 : 0) - (this.held.has('KeyS') ? 1 : 0)
    const right = (this.held.has('KeyD') ? 1 : 0) - (this.held.has('KeyA') ? 1 : 0)
    const up = (this.held.has('KeyE') ? 1 : 0) - (this.held.has('KeyQ') ? 1 : 0)
    if (forward || right || up) {
      this.viewer.rig.moveFree(forward, right, up, delta, this.held.has('ShiftLeft') || this.held.has('ShiftRight'))
    }
  }

  private syncTransport(force: boolean): void {
    if (!this.replay) return
    this.ui.time.textContent = formatTime(this.time)
    this.ui.scrubber.value = String(Math.round((this.time / this.replay.duration) * 1000))
    this.emit('timeupdate', this.time)

    // The roster and kill feed change slowly; rebuilding that DOM every frame
    // would cost more than the render does.
    if (force || Math.abs(this.time - this.lastSidebarSync) > 0.4) {
      this.lastSidebarSync = this.time
      this.renderRoster()
      this.renderFeed()
      this.renderBanner()
    }
  }

  private renderRoster(): void {
    if (!this.replay || !this.options.roster) return
    const present = this.viewer.presentPlayers(this.time)
    const groups = new Map<number, typeof present>([
      [TEAM_T, []],
      [TEAM_CT, []],
      [0, []]
    ])
    for (const entry of present) (groups.get(entry.team) ?? groups.get(0)!).push(entry)

    this.ui.roster.replaceChildren()
    for (const [team, label, className] of [
      [TEAM_T, 'Terrorists', 't'],
      [TEAM_CT, 'Counter-Terrorists', 'ct'],
      [0, 'Unassigned', '']
    ] as const) {
      const members = groups.get(team)
      if (!members?.length) continue

      const group = el('div', 'team-group')
      const heading = el('div', `team-label ${className}`)
      heading.textContent = `${label} (${members.length})`
      group.append(heading)

      for (const { player } of members) {
        const row = el('button', 'roster-row' + (player.slot === this.viewer.followSlot ? ' active' : ''))
        ;(row as HTMLButtonElement).type = 'button'
        const dot = el('span', 'dot')
        dot.style.background = `#${(TEAM_COLORS[team] ?? TEAM_COLORS[0]).toString(16).padStart(6, '0')}`
        const name = el('span', 'name')
        name.textContent = player.name
        row.append(dot, name)
        row.addEventListener('click', () => this.follow(player.slot))
        group.append(row)
      }
      this.ui.roster.append(group)
    }
  }

  private renderFeed(): void {
    if (!this.replay || !this.options.roster) return
    const recent = this.replay.kills.filter((k) => k.time <= this.time && k.time > this.time - 12).slice(-6)
    this.ui.feedTitle.hidden = recent.length === 0
    this.ui.feed.replaceChildren()
    for (const kill of recent) {
      const row = el('div', 'kill-row')
      const attacker = el('span', 'who')
      attacker.textContent = kill.attacker
      const victim = el('span', 'who')
      victim.textContent = kill.victim
      row.append(attacker, ` ${kill.weapon} → `, victim)
      if (kill.headshot) {
        const hs = el('span', 'hs')
        hs.textContent = ' HS'
        row.append(hs)
      }
      this.ui.feed.append(row)
    }
  }

  private renderBanner(): void {
    if (!this.replay) return
    const marker = [...this.replay.rounds]
      .reverse()
      .find((r) => r.time <= this.time && r.time > this.time - 6)
    this.ui.banner.textContent = marker?.label ?? ''
    this.ui.banner.classList.toggle('show', Boolean(marker))
  }

  private fillFollowSelect(): void {
    if (!this.replay) return
    this.ui.follow.replaceChildren()
    for (const player of this.replay.players) {
      const option = document.createElement('option')
      option.value = String(player.slot)
      option.textContent = player.name
      this.ui.follow.append(option)
    }
    if (this.viewer.followSlot !== null) this.ui.follow.value = String(this.viewer.followSlot)
  }

  private setProgress(fraction: number, stage: string): void {
    this.ui.loading.hidden = false
    this.ui.loadingBar.style.width = `${Math.round(fraction * 100)}%`
    this.ui.loadingStage.textContent = stage
  }

  private showError(message: string | null): void {
    if (message === null) {
      this.ui.error.hidden = true
      return
    }
    this.ui.loading.hidden = true
    this.ui.errorText.textContent = message
    this.ui.error.hidden = false
  }

  private emit<K extends keyof CsViewerEvents>(event: K, payload: CsViewerEvents[K]): void {
    for (const handler of this.listeners.get(event) ?? []) (handler as Handler<K>)(payload)
  }

  private observeSize(): void {
    this.resizeObserver = new ResizeObserver(() => this.viewer.resize())
    this.resizeObserver.observe(this.element)
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    if (!this.options.keyboard || !this.replay) return
    // Only steal keys while the pointer is over the widget, so a page with
    // several viewers (or a form) keeps behaving sanely.
    if (!this.element.matches(':hover')) return

    this.held.add(event.code)
    switch (event.code) {
      case 'Space': event.preventDefault(); this.toggle(); break
      case 'ArrowLeft': this.seek(this.time - 5); break
      case 'ArrowRight': this.seek(this.time + 5); break
      case 'Comma': this.cyclePlayer(-1); break
      case 'Period': this.cyclePlayer(1); break
      case 'Digit1': this.setMode('third-person'); break
      case 'Digit2': this.setMode('eye'); break
      case 'Digit3': this.setMode('free'); break
      default:
    }
  }

  private onKeyUp = (event: KeyboardEvent): void => {
    this.held.delete(event.code)
  }

  private cyclePlayer(direction: number): void {
    if (!this.replay?.players.length) return
    const slots = this.replay.players.map((p) => p.slot)
    const at = slots.indexOf(this.viewer.followSlot ?? slots[0])
    this.follow(slots[(at + direction + slots.length) % slots.length])
  }

  private bindInput(): void {
    const canvas = this.ui.canvas
    let dragging = false

    canvas.addEventListener('pointerdown', (event) => {
      dragging = true
      canvas.setPointerCapture(event.pointerId)
    })
    const stop = (event: PointerEvent) => {
      dragging = false
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
    }
    canvas.addEventListener('pointerup', stop)
    canvas.addEventListener('pointercancel', stop)
    canvas.addEventListener('pointermove', (event) => {
      if (!dragging) return
      const yaw = event.movementX * 0.005
      const pitch = event.movementY * 0.005
      if (this.viewer.rig.mode === 'free') this.viewer.rig.lookFree(yaw, pitch)
      else this.viewer.rig.orbit(yaw, pitch)
    })
    canvas.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault()
        this.viewer.rig.zoom(event.deltaY * 0.0012)
      },
      { passive: false }
    )

    this.ui.play.addEventListener('click', () => this.toggle())
    this.ui.scrubber.addEventListener('input', () => {
      if (!this.replay) return
      this.seek((Number(this.ui.scrubber.value) / 1000) * this.replay.duration)
    })
    this.ui.speed.addEventListener('change', () => this.setSpeed(Number(this.ui.speed.value)))
    this.ui.mode.addEventListener('change', () => this.setMode(this.ui.mode.value as CameraMode))
    this.ui.follow.addEventListener('change', () => this.follow(Number(this.ui.follow.value)))

    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
  }

  private buildDom(): CsViewer['ui'] {
    const canvas = document.createElement('canvas')

    const loadingBar = el('div')
    const progress = el('div', 'progress')
    progress.append(loadingBar)
    const loadingStage = el('h2')
    loadingStage.textContent = 'Loading'
    const loadingPanel = el('div', 'panel')
    loadingPanel.append(loadingStage, progress)
    const loading = el('div', 'overlay')
    loading.hidden = true
    loading.append(loadingPanel)

    const errorText = el('p', 'error-text')
    const errorTitle = el('h2')
    errorTitle.textContent = 'Could not play this demo'
    const errorPanel = el('div', 'panel')
    errorPanel.append(errorTitle, errorText)
    const error = el('div', 'overlay')
    error.hidden = true
    error.append(errorPanel)

    const matchMap = el('div', 'match-map')
    matchMap.textContent = '—'
    const matchServer = el('div', 'match-server')
    const roster = el('div')
    const feedTitle = el('div', 'section-title')
    feedTitle.textContent = 'Recent kills'
    feedTitle.hidden = true
    const feed = el('div')
    const sidebar = el('aside', 'sidebar')
    sidebar.hidden = true
    sidebar.append(matchMap, matchServer, roster, feedTitle, feed)

    const banner = el('div', 'banner')
    const hud = el('div', 'hud')
    hud.append(banner)

    const play = el('button', 'icon-button') as HTMLButtonElement
    play.type = 'button'
    play.textContent = '▶'
    play.title = 'Play / pause'
    const time = el('span', 'time')
    time.textContent = '0:00'
    const duration = el('span', 'time')
    duration.textContent = '0:00'
    const scrubber = el('input', 'scrubber') as HTMLInputElement
    scrubber.type = 'range'
    scrubber.min = '0'
    scrubber.max = '1000'
    scrubber.value = '0'

    const speed = select(['0.25', '0.5', '1', '2', '4', '8'], String(this.options.speed), (v) => `${v}×`)
    const mode = select(['third-person', 'eye', 'free'], this.options.mode, (v) =>
      v === 'third-person' ? 'Third person' : v === 'eye' ? 'Player eyes' : 'Free camera'
    )
    const follow = document.createElement('select')

    const controls = el('footer', 'controls')
    controls.hidden = true
    controls.append(
      play,
      time,
      scrubber,
      duration,
      labelled('Speed', speed, true),
      labelled('View', mode, false),
      labelled('Follow', follow, true)
    )

    this.shadow.append(canvas, sidebar, hud, controls, loading, error)

    return {
      canvas, loading, loadingBar, loadingStage, error, errorText,
      sidebar, matchMap, matchServer, roster, feedTitle, feed, banner,
      controls, play, time, duration, scrubber, speed, mode, follow
    }
  }
}

// --- small DOM helpers ----------------------------------------------------

function el(tag: string, className = ''): HTMLElement {
  const node = document.createElement(tag)
  if (className) node.className = className
  return node
}

function select(values: string[], selected: string, label: (value: string) => string): HTMLSelectElement {
  const node = document.createElement('select')
  for (const value of values) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = label(value)
    if (value === selected) option.selected = true
    node.append(option)
  }
  return node
}

function labelled(text: string, control: HTMLElement, optional: boolean): HTMLElement {
  const label = el('label', 'control' + (optional ? ' optional' : ''))
  label.append(text, control)
  return label
}

function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}
