// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { NewVersionBanner } from '../components/new-version-banner'
import {
  RELOAD_KEY,
  RELOAD_WINDOW_MS,
  claimReload,
  installStaleBuildRecovery,
  resetNewVersion,
} from './stale-build'
import {
  UnsavedWorkProvider,
  anyUnsavedWork,
  useReportUnsaved,
  useUnsavedWork,
} from './unsaved'
import type { Unsaved } from './unsaved'

// A tab open across a deploy asks for chunks that are gone: Vite fires
// `vite:preloadError`, and the tab reloads once, never in a loop, never
// over unsaved work.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const chunkFails = () =>
  window.dispatchEvent(new Event('vite:preloadError', { cancelable: true }))

class MemoryStorage {
  data = new Map<string, string>()
  getItem(k: string) {
    return this.data.get(k) ?? null
  }
  setItem(k: string, v: string) {
    this.data.set(k, v)
  }
}

const throwing = {
  getItem(): string | null {
    throw new DOMException('denied', 'SecurityError')
  },
  setItem() {
    throw new DOMException('denied', 'SecurityError')
  },
}

let uninstall: (() => void) | undefined
let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  resetNewVersion()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  uninstall?.()
  uninstall = undefined
  act(() => root.unmount())
  container.remove()
})

function install(opts: {
  navigating?: boolean
  storage?: () => Pick<Storage, 'getItem' | 'setItem'> | null
  now?: () => number
}) {
  const reload = vi.fn()
  const storage = new MemoryStorage()
  uninstall = installStaleBuildRecovery({
    navigating: () => opts.navigating ?? true,
    unsaved: anyUnsavedWork,
    reload,
    now: opts.now ?? (() => 1_000_000),
    storage: opts.storage ?? (() => storage),
  })
  return { reload, storage }
}

function Editor({ state }: { state: Unsaved }) {
  useReportUnsaved(state)
  return null
}

function Page({ state }: { state: Unsaved }) {
  const work = useUnsavedWork()
  return (
    <UnsavedWorkProvider work={work}>
      <NewVersionBanner />
      <Editor state={state} />
    </UnsavedWorkProvider>
  )
}

const banner = () => container.querySelector('[role="alert"]')

describe('claimReload', () => {
  test('one reload per window, then another once the window has passed', () => {
    const s = new MemoryStorage()
    expect(claimReload(() => s, 1_000)).toBe('ok')
    expect(s.getItem(RELOAD_KEY)).toBe('1000')
    expect(claimReload(() => s, 1_000 + RELOAD_WINDOW_MS - 1)).toBe('recent')
    expect(claimReload(() => s, 1_000 + RELOAD_WINDOW_MS)).toBe('ok')
  })

  test('storage that throws, is missing or drops writes cannot guard', () => {
    expect(claimReload(() => throwing, 1_000)).toBe('unavailable')
    expect(
      claimReload(() => {
        throw new DOMException('denied', 'SecurityError')
      }, 1_000),
    ).toBe('unavailable')
    expect(claimReload(() => null, 1_000)).toBe('unavailable')
    const dropping = { getItem: () => null, setItem: () => {} }
    expect(claimReload(() => dropping, 1_000)).toBe('unavailable')
  })

  test('a garbled stored value does not block the reload', () => {
    const s = new MemoryStorage()
    s.setItem(RELOAD_KEY, 'nonsense')
    expect(claimReload(() => s, 1_000)).toBe('ok')
  })
})

describe('a missing chunk on the way to a page', () => {
  test('reloads once', () => {
    act(() => root.render(<Page state="clean" />))
    const { reload } = install({})
    chunkFails()
    expect(reload).toHaveBeenCalledTimes(1)
    expect(banner()).toBeNull()
  })

  test('does not loop: a second failure in the window is left to the error UI', () => {
    act(() => root.render(<Page state="clean" />))
    let now = 1_000_000
    const { reload, storage } = install({ now: () => now })
    chunkFails()
    // The reloaded page fails again (a fresh listener, the same session).
    uninstall?.()
    uninstall = installStaleBuildRecovery({
      navigating: () => true,
      unsaved: anyUnsavedWork,
      reload,
      now: () => now,
      storage: () => storage,
    })
    now += 5_000
    chunkFails()
    expect(reload).toHaveBeenCalledTimes(1)
    expect(banner()).toBeNull()
  })

  test('over unsaved work, asks with the banner instead of reloading', () => {
    act(() => root.render(<Page state="unsaved" />))
    const { reload, storage } = install({})
    act(() => chunkFails())
    expect(reload).not.toHaveBeenCalled()
    expect(banner()?.textContent).toContain('A new version is available.')
    expect(banner()?.querySelector('button')?.textContent).toBe('Reload')
    // Asking spends no automatic reload.
    expect(storage.getItem(RELOAD_KEY)).toBeNull()
  })

  test('a save in flight counts as unsaved', () => {
    act(() => root.render(<Page state="busy" />))
    const { reload } = install({})
    act(() => chunkFails())
    expect(reload).not.toHaveBeenCalled()
    expect(banner()).not.toBeNull()
  })

  test('once the page unmounts, its work no longer holds the reload', () => {
    act(() => root.render(<Page state="unsaved" />))
    expect(anyUnsavedWork()).toBe(true)
    act(() => root.render(<NewVersionBanner />))
    expect(anyUnsavedWork()).toBe(false)
  })

  test('with storage that throws, asks rather than risk a loop', () => {
    act(() => root.render(<Page state="clean" />))
    const { reload } = install({ storage: () => throwing })
    act(() => chunkFails())
    expect(reload).not.toHaveBeenCalled()
    expect(banner()).not.toBeNull()
  })
})

test('a failed background preload (a hovered link) does nothing', () => {
  act(() => root.render(<Page state="clean" />))
  const { reload, storage } = install({ navigating: false })
  act(() => chunkFails())
  expect(reload).not.toHaveBeenCalled()
  expect(banner()).toBeNull()
  expect(storage.getItem(RELOAD_KEY)).toBeNull()
})
