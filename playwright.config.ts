import { existsSync, readFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'

// QC suite (ADR 0018, factory/plans/qc-suite.sv; migration-rust F3): the
// production build, served by qc/serve.mjs, driven by headless Chromium
// against local release builds of the Rust api (or staging). Runs outside
// the Claude sandbox (it binds ports) and is never part of `pnpm check`.
//
// The pool comes from qc/.instances.json, which scripts/qc.mjs writes
// after building and starting the apis (`pnpm qc` runs it first, under
// the QC lock). Each local instance gets its own serve.mjs, proxying /api
// to its api; mapping workers to instances is qc/fixtures.ts's job, which
// also points each test's baseURL at its own instance.

// One id per run, shared by the runner, the reporter and every worker. It
// names the run's tenants (`r<run>w<n>-a|b`) and its records in
// qc-results/runs/. Workers are children of the runner, inherit its env
// and re-read this file, so they keep its id; the runner always makes a
// fresh one, so an id left exported in the shell can't merge two runs.
if (process.env.QC_RUN_PID !== String(process.ppid)) {
  process.env.QC_RUN_ID =
    Math.floor(Date.now() / 1000).toString(36) +
    Math.floor(Math.random() * 36 ** 2)
      .toString(36)
      .padStart(2, '0')
  process.env.QC_RUN_PID = String(process.pid)
}

// `--reporter` on the command line replaces the reporters below, and with
// them qc/reporter.ts, which carries the run's gates (coverage, untimed
// flows, worker-setup budgets). Refuse it rather than pass silently.
if (
  process.argv.some((a) => a === '--reporter' || a.startsWith('--reporter='))
) {
  throw new Error(
    'pnpm qc takes no --reporter: it would drop qc/reporter.ts and the gates it runs (qc/README.md)',
  )
}

// Playwright's browser download is blocked here, so use the system
// Chromium. QC_CHROMIUM overrides it; with neither (CI) Playwright falls
// back to its own browser.
const chromium =
  process.env.QC_CHROMIUM ??
  (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined)

interface Instance {
  name: string
  api: string
  baseURL: string
  /** Local instances only: serve.mjs's port and the build it serves. */
  servePort?: number
  serveDir?: string
}

const instancesFile = fileURLToPath(
  new URL('qc/.instances.json', import.meta.url),
)
if (!existsSync(instancesFile)) {
  throw new Error(
    `qc/.instances.json is missing: run \`pnpm qc\`, which prepares the pool, or \`pnpm qc:pool\` first`,
  )
}
const instances: Array<Instance> = JSON.parse(
  readFileSync(instancesFile, 'utf8'),
)

// About two workers per instance, but no more than half the cores, so
// browser CPU contention doesn't inflate render times.
const workers = Math.max(
  1,
  Math.min(2 * instances.length, Math.floor(availableParallelism() / 2)),
)

export default defineConfig({
  testDir: 'qc',
  testMatch: '**/*.spec.ts',
  // A flaky test is a failure to investigate, not to retry.
  retries: 0,
  forbidOnly: true,
  workers,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'qc-report/playwright', open: 'never' }],
    ['./qc/reporter.ts'],
  ],
  outputDir: 'test-results',
  globalSetup: './qc/global-setup.ts',
  use: {
    baseURL: instances[0].baseURL,
    headless: true,
    viewport: { width: 1280, height: 800 },
    // Off: tracing snapshots the DOM around every action, timed ones too,
    // and inflated big pages' times (~230 ms on one Load more). A flow
    // over budget traces one extra, unjudged sample instead (qc/timing.ts).
    // Functional failures keep a screenshot.
    trace: 'off',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
        launchOptions: chromium ? { executablePath: chromium } : {},
      },
    },
  ],
  webServer: instances.flatMap((inst) =>
    inst.servePort
      ? [
          {
            command: `node qc/serve.mjs --dir ${inst.serveDir} --port ${inst.servePort} --api ${inst.api}`,
            url: inst.baseURL,
            reuseExistingServer: false,
            timeout: 30_000,
          },
        ]
      : [],
  ),
})
