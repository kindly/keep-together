import { existsSync, readFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'

// QC suite (ADR 0018, factory/plans/qc-suite.sv): the production build,
// served by `vite preview`, driven by headless Chromium against a live
// Convex dev deployment. Runs outside the Claude sandbox (WebSockets don't
// pass its proxy) and is never part of `pnpm check`.
//
// The pool comes from qc/.instances.json, which scripts/qc-instances.mjs
// writes after pushing and building (`pnpm qc` runs it first, under the
// QC lock). Each instance gets its own preview server; mapping workers to
// instances is qc/fixtures.ts's job, which also points each test's
// baseURL at its own instance.

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
  deployment: string
  url: string
  envFile: string
  port: number
  outDir: string
}

const instancesFile = fileURLToPath(
  new URL('qc/.instances.json', import.meta.url),
)
if (!existsSync(instancesFile)) {
  throw new Error(
    `qc/.instances.json is missing: run \`pnpm qc\`, which prepares the pool, or \`pnpm qc:instances\` first`,
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
    baseURL: `http://localhost:${instances[0].port}`,
    headless: true,
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
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
  webServer: instances.map((inst) => ({
    command: `vite preview --outDir ${inst.outDir} --port ${inst.port} --strictPort`,
    url: `http://localhost:${inst.port}`,
    reuseExistingServer: false,
    timeout: 30_000,
  })),
})
