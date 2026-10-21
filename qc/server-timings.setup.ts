import { mkdirSync } from 'node:fs'
import path from 'node:path'
import {
  LIVE_CALLS_FILE,
  checkBudgets,
  formatTable,
  startServerTimings,
  writeResults,
} from './server-timings'
import { RECORD, runDir } from './timing'
import type { QcHook } from './global-setup'

// The server-time collector as a qc/global-setup.ts hook (step 5). Setup
// starts one log stream per pool instance and fails if one doesn't come
// live. The teardown stops them, writes server-timings.{json,txt} under
// runDir() (the reporter folds the JSON into history.jsonl), prints the
// table and fails the run when a stream went deaf or a call broke the
// budget. In QC_MODE=record a budget miss only warns; a lost stream still
// fails, since its numbers are incomplete.
export const serverTimingsHook: QcHook = {
  name: 'server timings',
  async setup(pool) {
    mkdirSync(runDir(), { recursive: true })
    const collector = await startServerTimings(
      pool,
      path.join(runDir(), LIVE_CALLS_FILE),
    )
    return async () => {
      const timings = await collector.stop()
      writeResults(timings, runDir())
      console.log(`\n${formatTable(timings)}\n`)
      let misses = checkBudgets(timings)
      if (misses.length && RECORD) {
        console.warn(
          `qc (record mode, not failing): server timings:\n  ${misses.join('\n  ')}`,
        )
        misses = []
      }
      const problems = [...timings.errors, ...misses]
      if (problems.length) {
        throw new Error(`server timings:\n  ${problems.join('\n  ')}`)
      }
    }
  },
}
