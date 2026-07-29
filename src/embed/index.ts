/**
 * Public entry point for embedding the viewer in another site.
 *
 *   import { createCsViewer } from 'cs-viewer'
 *
 *   const viewer = createCsViewer('#replay', {
 *     demo: '/demos/match.dem',
 *     assets: '/cs-assets'
 *   })
 */
import { CsViewer, type CsViewerOptions } from './widget.ts'

export { CsViewer }
export type {
  CsViewerOptions,
  CsViewerEvents,
  DemoSource,
  ReplaySummary,
  ViewerPlayer
} from './widget.ts'
export type { CameraMode } from '../render/cameraRig.ts'

/**
 * Mounts a viewer into `target`, which may be an element or a CSS selector.
 *
 * The element needs a height — the widget fills it. Loading starts
 * immediately when `options.demo` is given; listen for `ready` or await
 * `viewer.load(...)` to know when playback can begin.
 */
export function createCsViewer(
  target: string | HTMLElement,
  options: CsViewerOptions = {}
): CsViewer {
  const element = typeof target === 'string' ? document.querySelector<HTMLElement>(target) : target
  if (!element) {
    throw new Error(`createCsViewer: no element matches ${JSON.stringify(target)}`)
  }
  return new CsViewer(element, options)
}

/**
 * Mounts a viewer on every `[data-cs-viewer]` element in the document, reading
 * its configuration from data attributes. Lets a site embed a replay without
 * writing any JavaScript:
 *
 *   <div data-cs-viewer data-demo="/demos/match.dem" data-assets="/cs-assets"
 *        style="height: 540px"></div>
 */
export function autoMount(root: ParentNode = document): CsViewer[] {
  const mounted: CsViewer[] = []
  for (const element of root.querySelectorAll<HTMLElement>('[data-cs-viewer]')) {
    if (element.shadowRoot) continue // already mounted
    const data = element.dataset
    mounted.push(
      new CsViewer(element, {
        demo: data.demo,
        assets: data.assets,
        autoplay: data.autoplay !== 'false',
        mode: data.mode as CsViewerOptions['mode'],
        follow: data.follow ? Number(data.follow) : undefined,
        startTime: data.startTime ? Number(data.startTime) : undefined,
        speed: data.speed ? Number(data.speed) : undefined,
        brightness: data.brightness ? Number(data.brightness) : undefined,
        controls: data.controls !== 'false',
        roster: data.roster !== 'false',
        nameTags: data.nameTags !== 'false',
        keyboard: data.keyboard !== 'false'
      })
    )
  }
  return mounted
}
