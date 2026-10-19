import { readInstances } from './fixtures'
import type { Instance } from './fixtures'
import { linkHook } from './link.setup'
import { serverTimingsHook } from './server-timings.setup'

// Runs once per `playwright test`, after scripts/qc-instances.mjs has
// pushed and built the pool and Playwright's webServer has started one
// `vite preview` per instance (playwright.config.ts).
//
// Hook point: each hook gets the pool and may return its teardown. Hooks
// run in order; teardowns run after the last test, in reverse order, and
// before the reporter's onEnd, so a hook can leave results under
// runDir() for qc/reporter.ts. Any teardown failure fails the run.
//
// No global warm-up. Hitting every function over HTTP right after the push
// warms little: the useful calls need a signed-in user and real ids, which
// only exist per worker, and calls with made-up args are rejected before
// the function runs. Instead each flow's first iteration per worker is
// untimed (qc/timing.ts), with real auth and data on the real socket, so
// exactly the functions that flow uses are warm before it is timed.

export interface QcHook {
  name: string
  setup: (pool: Array<Instance>) => Promise<(() => Promise<void>) | void>
}

// A warm-up hook, if one returns, goes before serverTimingsHook so its
// calls aren't timed.
const hooks: Array<QcHook> = [linkHook, serverTimingsHook]

export default async function globalSetup() {
  const pool = readInstances()
  const teardowns: Array<{ name: string; fn: () => Promise<void> }> = []
  for (const hook of hooks) {
    const fn = await hook.setup(pool)
    if (fn) teardowns.push({ name: hook.name, fn })
  }
  // Every teardown runs; any failure then fails the run.
  return async () => {
    const failed: Array<unknown> = []
    for (const { name, fn } of teardowns.reverse()) {
      try {
        await fn()
      } catch (err) {
        console.error(`qc teardown ${name} failed:`, err)
        failed.push(err)
      }
    }
    if (failed.length) throw new AggregateError(failed, 'qc teardown failed')
  }
}
