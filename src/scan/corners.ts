import { clampPoint } from './geometry'
import type { Quad } from './geometry'

/**
 * Draggable corners over the photo: the page's outline, the photo outside
 * it dimmed, and a handle per corner with a finger-sized target. Handles
 * are buttons, so arrow keys move them too.
 */

const SVG = 'http://www.w3.org/2000/svg'
const NAMES = ['Top left', 'Top right', 'Bottom right', 'Bottom left']
/** Arrow-key step, in photo pixels. */
const NUDGE = 8

export interface CornerEditor {
  quad: () => Quad
  destroy: () => void
}

export function cornerEditor(
  host: HTMLElement,
  photo: HTMLCanvasElement,
  start: Quad,
): CornerEditor {
  const quad = start.map((p) => ({ ...p })) as Quad
  const { width, height } = photo

  const frame = document.createElement('div')
  frame.className = 'crop-frame'
  photo.className = 'crop-photo'
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('class', 'crop-overlay')
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
  svg.setAttribute('preserveAspectRatio', 'none')
  const mask = document.createElementNS(SVG, 'path')
  mask.setAttribute('class', 'crop-mask')
  mask.setAttribute('fill-rule', 'evenodd')
  const outline = document.createElementNS(SVG, 'polygon')
  outline.setAttribute('class', 'crop-outline')
  outline.setAttribute('vector-effect', 'non-scaling-stroke')
  svg.append(mask, outline)
  frame.append(photo, svg)

  const handles = NAMES.map((name, i) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'crop-handle'
    b.setAttribute('aria-label', `${name} corner`)
    b.dataset.corner = String(i)
    frame.append(b)
    return b
  })
  host.append(frame)

  const draw = () => {
    const pts = quad.map((p) => `${p.x},${p.y}`).join(' ')
    outline.setAttribute('points', pts)
    mask.setAttribute(
      'd',
      `M0,0H${width}V${height}H0Z M${quad.map((p) => `${p.x},${p.y}`).join(' L')}Z`,
    )
    quad.forEach((p, i) => {
      handles[i].style.left = `${(p.x / width) * 100}%`
      handles[i].style.top = `${(p.y / height) * 100}%`
    })
  }

  /** Photo pixels per CSS pixel, as the photo is drawn now. */
  const scale = () => width / photo.getBoundingClientRect().width

  const off: Array<() => void> = []
  const on = <TType extends keyof HTMLElementEventMap>(
    el: HTMLElement,
    type: TType,
    fn: (e: HTMLElementEventMap[TType]) => void,
  ) => {
    el.addEventListener(type, fn)
    off.push(() => el.removeEventListener(type, fn))
  }

  handles.forEach((handle, i) => {
    let grab: { id: number; dx: number; dy: number } | null = null
    const at = (e: PointerEvent) => {
      const r = photo.getBoundingClientRect()
      const s = scale()
      return { x: (e.clientX - r.left) * s, y: (e.clientY - r.top) * s }
    }
    on(handle, 'pointerdown', (e) => {
      e.preventDefault()
      handle.setPointerCapture(e.pointerId)
      const p = at(e)
      // Keep the offset from the corner, so the handle doesn't jump.
      grab = { id: e.pointerId, dx: quad[i].x - p.x, dy: quad[i].y - p.y }
      handle.classList.add('dragging')
    })
    on(handle, 'pointermove', (e) => {
      if (grab?.id !== e.pointerId) return
      const p = at(e)
      quad[i] = clampPoint(
        { x: p.x + grab.dx, y: p.y + grab.dy },
        width,
        height,
      )
      draw()
    })
    const release = (e: PointerEvent) => {
      if (grab?.id !== e.pointerId) return
      grab = null
      handle.classList.remove('dragging')
    }
    on(handle, 'pointerup', release)
    on(handle, 'pointercancel', release)
    on(handle, 'keydown', (e) => {
      const step = NUDGE * (e.shiftKey ? 4 : 1)
      const move: Partial<Record<string, [number, number]>> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      }
      const d = move[e.key]
      if (!d) return
      e.preventDefault()
      quad[i] = clampPoint(
        { x: quad[i].x + d[0], y: quad[i].y + d[1] },
        width,
        height,
      )
      draw()
    })
  })

  draw()
  return {
    quad: () => quad.map((p) => ({ ...p })) as Quad,
    destroy: () => {
      off.forEach((f) => f())
      frame.remove()
    },
  }
}
