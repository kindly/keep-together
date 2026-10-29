import './scan.css'
import { openSitting, sendPage, newId, tokenFrom } from './api'
import type { Refusal } from './api'
import { cornerEditor } from './corners'
import type { CornerEditor } from './corners'
import { detectCorners } from './detect'
import { rotateQuad } from './geometry'
import type { Quad } from './geometry'
import { flatten, greyOf, loadPhoto, rotateCanvas } from './photo'
import { Outbox } from './queue'
import type { OutboxPage } from './queue'
import type { ScanSitting } from '#/lib/data/rust-types/ScanSitting'

/**
 * The phone's scanning page (`/scan.html#<token>`, plan declaration-scans
 * step 5): no React and none of the app's bundle. It opens the pairing,
 * takes a photo with the native camera, lets the corners be dragged onto
 * the page, flattens it to a greyscale A4 JPEG and sends it, page by page,
 * to the laptop's sitting. The token lives in the fragment and goes
 * nowhere but `/api/scan/{token}`.
 */

type Ended = 'gone' | 'forbidden' | 'no_token'

interface Scan {
  id: string
  pages: Array<OutboxPage>
  /** Object URLs of the flattened pages, for the thumbnails. */
  thumbs: Array<string>
}

const root = document.getElementById('scan')!
const camera = document.getElementById('camera') as HTMLInputElement

let token = ''
let sitting: ScanSitting | null = null
let current: Scan | null = null
/** Scans sent from this page, newest first. */
const done: Array<Scan> = []
let notice: string | null = null
let cropping = false
/** The link ended: the page shows only that from now on. */
let over = false

const outbox = new Outbox({
  send: (page) => sendPage(token, page),
  sleep: (ms, wake) =>
    Promise.race([new Promise<void>((r) => setTimeout(r, ms)), wake]),
  changed: () => {
    if (!cropping) home()
  },
  ended: (why) => ended(why),
})

// ---- a little DOM ----------------------------------------------------------

type Child = Node | string | null | false | undefined

function h<TTag extends keyof HTMLElementTagNameMap>(
  tag: TTag,
  props: Partial<Record<string, string | boolean | EventListener>> = {},
  ...children: Array<Child | Array<Child>>
): HTMLElementTagNameMap[TTag] {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === false) continue
    if (typeof v === 'function') el.addEventListener(k.slice(2), v)
    else if (v === true) el.setAttribute(k, '')
    else el.setAttribute(k, v)
  }
  for (const c of children.flat()) {
    if (c !== null && c !== false && c !== undefined) el.append(c)
  }
  return el
}

function show(...children: Array<Child>) {
  root.replaceChildren(...children.filter((c): c is Node | string => !!c))
}

/** A label that opens the camera: the most reliable trigger on iOS. */
function cameraButton(text: string, primary: boolean, disabled = false) {
  return h(
    'label',
    {
      for: disabled ? false : 'camera',
      class: `button${primary ? ' primary' : ''}`,
      'aria-disabled': disabled ? 'true' : false,
    },
    text,
  )
}

// ---- screens ---------------------------------------------------------------

const ENDED_TEXT: Record<Ended, [string, string]> = {
  gone: [
    'This link has ended',
    'A link lasts up to 2 hours, and ends after 15 minutes without a scan or when the laptop ends the sitting. To carry on, choose “Scan with phone” on the laptop and scan the new code.',
  ],
  forbidden: [
    'This link is open on another phone',
    'A link works on the first phone that opens it. To scan with this phone, choose “Scan with phone” on the laptop and scan the new code.',
  ],
  no_token: [
    'Open this page from the laptop',
    'Choose “Scan with phone” in keep-together on the laptop and scan the code it shows with this phone’s camera.',
  ],
}

function ended(why: Ended) {
  over = true
  cropping = false
  const [title, text] = ENDED_TEXT[why]
  const unsent = outbox.pages.filter((p) => p.state === 'waiting').length
  show(
    h(
      'section',
      { class: 'panel', 'data-screen': 'ended', 'data-why': why },
      h('h1', {}, title),
      h('p', {}, text),
      unsent > 0 &&
        h(
          'p',
          { class: 'warn' },
          unsent === 1
            ? '1 page didn’t reach the laptop. Photograph it again with the new link.'
            : `${unsent} pages didn’t reach the laptop. Photograph them again with the new link.`,
        ),
    ),
  )
}

function unreachable() {
  show(
    h(
      'section',
      { class: 'panel', 'data-screen': 'unreachable' },
      h('h1', {}, 'Can’t reach keep-together'),
      h('p', {}, 'Check this phone has a signal or Wi-Fi, then try again.'),
      h(
        'button',
        {
          class: 'button primary',
          type: 'button',
          onclick: () => void start(),
        },
        'Try again',
      ),
    ),
  )
}

const REFUSED: Record<Refusal, string> = {
  page_limit: 'A scan holds at most 6 pages. Send this one and start another.',
  upload_limit:
    'This link has taken all the pages it can. Start a new one on the laptop.',
  files_full: 'There’s no room for more scans. Contact us.',
  storage_full: 'There’s no room for more scans just now. Contact us.',
  invalid: 'The server couldn’t read this page. Photograph it again.',
  other: 'The server refused this page. Photograph it again.',
}

function pageStatus(p: OutboxPage): string {
  switch (p.state) {
    case 'sent':
      return 'Sent'
    case 'sending':
      return 'Sending…'
    case 'waiting':
      return 'Waiting'
    case 'failed':
      return 'Not sent'
  }
}

function scanStatus(scan: Scan): { text: string; state: string } {
  const states = scan.pages.map((p) => p.state)
  if (states.every((s) => s === 'sent'))
    return { text: 'On the laptop', state: 'sent' }
  if (states.some((s) => s === 'failed')) {
    return { text: 'Some pages weren’t sent', state: 'failed' }
  }
  return { text: 'Sending…', state: 'sending' }
}

/** Why no more photos can be taken, if so. */
function blocked(): string | null {
  const stop = outbox.pages.find(
    (p) =>
      p.state === 'failed' &&
      (p.problem === 'upload_limit' ||
        p.problem === 'files_full' ||
        p.problem === 'storage_full'),
  )
  if (stop?.problem) return REFUSED[stop.problem]
  if (outbox.uploadsLeft === 0) return REFUSED.upload_limit
  return null
}

function home() {
  if (!sitting || over) return
  if (current) current.id = outbox.current(current.id)
  const stop = blocked()
  const retrying = outbox.retrying
  const maxPages = sitting.maxPages

  const banner =
    retrying &&
    h(
      'div',
      { class: 'banner', role: 'status', 'data-retrying': retrying.why },
      h(
        'span',
        {},
        retrying.why === 'offline'
          ? 'No connection. Your pages are kept and will send when it’s back.'
          : 'The server is busy. Trying again shortly.',
      ),
      h(
        'button',
        { type: 'button', class: 'link', onclick: () => outbox.wake() },
        'Try now',
      ),
    )

  // A page of this scan the server refused, and why (a stop for every
  // page is `stop`'s to say).
  const refused = current?.pages.filter((p) => p.problem).at(-1)?.problem
  const problem = refused ? REFUSED[refused] : null
  // Refused pages aren't on the server, so they don't count to the cap.
  const held = current?.pages.filter((p) => p.state !== 'failed').length ?? 0

  const thisScan =
    current &&
    h(
      'section',
      { class: 'panel', 'data-screen': 'scan' },
      h(
        'h2',
        {},
        current.pages.length === 1
          ? 'This scan: 1 page'
          : `This scan: ${current.pages.length} pages`,
      ),
      h(
        'ol',
        { class: 'pages' },
        current.pages.map((p, i) =>
          h(
            'li',
            { 'data-state': p.state },
            h('img', { src: current!.thumbs[i], alt: `Page ${i + 1}` }),
            h('span', {}, pageStatus(p)),
          ),
        ),
      ),
      h(
        'div',
        { class: 'actions' },
        cameraButton(
          held >= maxPages ? `${maxPages} pages is the most` : 'Add page',
          false,
          !!stop || held >= maxPages,
        ),
        h(
          'button',
          { type: 'button', class: 'button primary', onclick: finish },
          'Send',
        ),
      ),
    )

  show(
    h(
      'header',
      { class: 'top' },
      h('p', { class: 'org' }, sitting.orgName),
      h('h1', {}, 'Scan Gift Aid declarations'),
    ),
    banner,
    notice && h('p', { class: 'notice', role: 'alert' }, notice),
    stop
      ? h('p', { class: 'warn', role: 'alert' }, stop)
      : problem && h('p', { class: 'warn', role: 'alert' }, problem),
    thisScan ||
      h(
        'section',
        { class: 'panel', 'data-screen': 'home' },
        h(
          'p',
          {},
          'Lay the declaration on a dark, flat surface and photograph the whole page. Each scan goes to the laptop as you send it.',
        ),
        h(
          'div',
          { class: 'actions' },
          cameraButton('Photograph a declaration', true, !!stop),
        ),
      ),
    done.length > 0 &&
      h(
        'section',
        { class: 'panel' },
        h('h2', {}, 'Sent from this phone'),
        h(
          'ul',
          { class: 'done' },
          done.map((scan) => {
            const s = scanStatus(scan)
            return h(
              'li',
              { 'data-state': s.state },
              h(
                'span',
                {},
                scan.pages.length === 1
                  ? '1 page'
                  : `${scan.pages.length} pages`,
              ),
              h('span', {}, s.text),
            )
          }),
        ),
      ),
  )
}

/** "Send": this scan is complete; its pages are already on their way. */
function finish() {
  if (!current) return
  current.thumbs.forEach((url) => URL.revokeObjectURL(url))
  done.unshift(current)
  current = null
  notice = null
  home()
}

let editor: CornerEditor | null = null

async function crop(file: File) {
  cropping = true
  notice = null
  show(
    h(
      'section',
      { class: 'panel', 'data-screen': 'working' },
      h('p', {}, 'Finding the page…'),
    ),
  )
  let photo: HTMLCanvasElement
  try {
    photo = await loadPhoto(file)
  } catch {
    cropping = false
    notice = 'That photo couldn’t be opened. Take it again.'
    home()
    return
  }
  const detected = await detectCorners(photo)
  cropAt(photo, detected.quad, detected.found)
}

function cropAt(photo: HTMLCanvasElement, quad: Quad, found: boolean) {
  if (over) return
  editor?.destroy()
  const host = h('div', { class: 'crop-host' })
  const rotate = () => {
    const q = editor!.quad()
    const turned = rotateCanvas(photo)
    const h0 = photo.height
    photo.width = photo.height = 0
    cropAt(turned, rotateQuad(q, h0), found)
  }
  const use = () => void usePage(photo, editor!.quad())
  show(
    h(
      'section',
      { class: 'crop', 'data-screen': 'crop', 'data-found': String(found) },
      h(
        'p',
        { class: 'hint' },
        found
          ? 'Check the corners sit on the page’s corners.'
          : 'Drag each corner to a corner of the page.',
      ),
      host,
      h(
        'div',
        { class: 'actions' },
        cameraButton('Retake', false),
        h(
          'button',
          { type: 'button', class: 'button', onclick: rotate },
          'Rotate',
        ),
        h(
          'button',
          { type: 'button', class: 'button primary', onclick: use },
          'Use page',
        ),
      ),
    ),
  )
  editor = cornerEditor(host, photo, quad)
}

async function usePage(photo: HTMLCanvasElement, quad: Quad) {
  if (!sitting || over) return
  editor?.destroy()
  editor = null
  show(
    h(
      'section',
      { class: 'panel', 'data-screen': 'working' },
      h('p', {}, 'Preparing the page…'),
    ),
  )
  // Let the message paint before the warp holds the main thread.
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))
  const fitted = await flatten(greyOf(photo), quad, sitting.maxPageBytes).catch(
    () => null,
  )
  photo.width = photo.height = 0
  cropping = false
  if (!fitted) {
    notice =
      'That page couldn’t be made small enough to send. Take it again from a little closer.'
    home()
    return
  }
  current ??= { id: newId(), pages: [], thumbs: [] }
  current.id = outbox.current(current.id)
  current.thumbs.push(URL.createObjectURL(fitted.blob))
  current.pages.push(outbox.add(current.id, fitted.blob))
  home()
}

// ---- start -----------------------------------------------------------------

camera.addEventListener('change', () => {
  const file = camera.files?.[0]
  // Cleared, so the same photo can be chosen again.
  camera.value = ''
  if (file) void crop(file)
})

async function start() {
  const t = tokenFrom(location.hash)
  if (!t) return ended('no_token')
  token = t
  show(
    h(
      'section',
      { class: 'panel', 'data-screen': 'loading' },
      h('p', {}, 'Opening the link…'),
    ),
  )
  const out = await openSitting(token)
  switch (out.kind) {
    case 'ok':
      sitting = out.value
      outbox.uploadsLeft = sitting.uploadsLeft
      home()
      // Fetch the corner finder while the first photo is being taken.
      void import('scanic').catch(() => {})
      return
    case 'gone':
    case 'forbidden':
      return ended(out.kind)
    case 'retry':
      return unreachable()
    default:
      return ended('gone')
  }
}

addEventListener('online', () => outbox.wake())
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') outbox.wake()
})
// Pages still on the phone are lost with the page: say so before leaving.
addEventListener('beforeunload', (e) => {
  if (!outbox.idle) e.preventDefault()
})
// A new code scanned into the same tab changes only the fragment.
addEventListener('hashchange', () => location.reload())

void start()
