import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'

// The QC flows on the Rust backend (rust spike step 3, qc-rs/README.md).
//
//   QC_LEGS=0 QC_MODE=record npx playwright test -c qc-rs/playwright.config.ts
//
// Needs the Rust API on :8787 (KEEP_DEV_AUTH=1 KEEP_QC_SEED=1) and a
// `VITE_BACKEND=rust` build in dist-qc-rs/. The in-scope Convex specs are
// copied verbatim into qc-rs/.flows/ (gitignored) so their `../fixtures`
// import resolves to qc-rs/fixtures.ts; qc-rs/rust/ holds the flows that
// only make sense without live queries.

const root = fileURLToPath(new URL('..', import.meta.url))
const here = fileURLToPath(new URL('.', import.meta.url))

if (process.env.QC_RUN_PID !== String(process.ppid)) {
  process.env.QC_RUN_ID =
    'rs' +
    Math.floor(Date.now() / 1000).toString(36) +
    Math.floor(Math.random() * 36 ** 2)
      .toString(36)
      .padStart(2, '0')
  process.env.QC_RUN_PID = String(process.pid)
  const flows = `${here}.flows/`
  rmSync(flows, { recursive: true, force: true })
  mkdirSync(flows)
  for (const f of [
    'contact.helpers.ts',
    'gift.helpers.ts',
    'contact.spec.ts',
    'contacts.spec.ts',
    'search.spec.ts',
    'fields.spec.ts',
    'isolation.spec.ts',
  ])
    copyFileSync(`${root}qc/flows/${f}`, `${flows}${f}`)
}

const chromium =
  process.env.QC_CHROMIUM ??
  (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined)
const port = Number(process.env.QC_RS_PORT ?? 4300)

export default defineConfig({
  testDir: here,
  testMatch: ['.flows/*.spec.ts', 'rust/*.spec.ts'],
  retries: 0,
  workers: Number(process.env.QC_RS_WORKERS ?? 2),
  reporter: [['list']],
  outputDir: `${root}test-results/qc-rs`,
  use: {
    baseURL: `http://localhost:${port}`,
    headless: true,
    viewport: { width: 1280, height: 800 },
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
  webServer: {
    command: `node qc-rs/serve.mjs --port ${port}`,
    cwd: root,
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
})
