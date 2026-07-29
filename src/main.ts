/**
 * The standalone demo page.
 *
 * It is a thin shell around the embeddable widget: a start screen with a file
 * picker and drag-and-drop, and then `createCsViewer` doing all the work. Any
 * site can do the same — see `examples/embed.html`.
 */
import { createCsViewer, type CsViewer, type DemoSource } from './embed/index.ts'

const ASSET_BASE = '/assets'
/** Dropped into `public/demos/` so the page can offer it with one click. */
const BUNDLED_DEMO = '/demos/demo.dem'

const element = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id)
  if (!found) throw new Error(`Missing element #${id}`)
  return found as T
}

const stage = element('stage')
const startScreen = element('start')
const startError = element('start-error')

let viewer: CsViewer | null = null

async function open(source: DemoSource, label: string): Promise<void> {
  startError.hidden = true
  startScreen.hidden = true
  stage.hidden = false

  if (!viewer) {
    viewer = createCsViewer(stage, { assets: ASSET_BASE })
    viewer.on('error', (error) => {
      // Send the user back to the start screen with the reason, rather than
      // leaving them on a widget that will never play anything.
      startError.textContent = error.message
      startError.hidden = false
      startScreen.hidden = false
      stage.hidden = true
    })
  }

  document.title = `${label} — CS Viewer`
  await viewer.load(source)
}

element<HTMLInputElement>('file-input').addEventListener('change', (event) => {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (file) void open(file, file.name).catch(() => {})
})

document.addEventListener('dragover', (event) => event.preventDefault())
document.addEventListener('drop', (event) => {
  event.preventDefault()
  const file = event.dataTransfer?.files?.[0]
  if (file) void open(file, file.name).catch(() => {})
})

// Offer the bundled demo if one was placed in public/demos/.
void fetch(BUNDLED_DEMO, { method: 'HEAD' })
  .then((response) => {
    if (!response.ok) return
    const row = element('bundled-row')
    const button = element<HTMLButtonElement>('bundled-button')
    button.addEventListener('click', () => void open(BUNDLED_DEMO, 'Sample match').catch(() => {}))
    row.hidden = false
  })
  .catch(() => {
    /* no bundled demo; the file picker still works */
  })
