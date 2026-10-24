import type { Page } from '@playwright/test'
import type { Instance } from './fixtures'

// The Convex harness's helpers that specs of unported modules still call
// (qc/pending.ts skips those tests, so none of these runs). They keep
// those specs compiling until their wave step re-points them at the Rust
// API; B3 deletes this file with the last of them.

const gone = (what: string) =>
  new Error(`${what} is Convex-only: this spec is pendingPort (qc/pending.ts)`)

/** Was: `npx convex …` against a pool instance. */
export function convexOn(
  _inst: Instance,
  _args: Array<string>,
): Promise<string> {
  return Promise.reject(gone('convexOn'))
}

/** Was: hold the instance quiet for a bulk write (qc/quiet.ts). */
export function holdQuiet<T>(
  _instance: string,
  _who: string,
  _fn: () => Promise<T>,
): Promise<T> {
  return Promise.reject(gone('holdQuiet'))
}

/** Was: wait until the page no longer subscribes to Convex queries. */
export function released(_page: Page, _fns: Array<string>): Promise<void> {
  return Promise.reject(gone('released'))
}
