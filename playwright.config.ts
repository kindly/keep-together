import { existsSync } from 'node:fs'
import { defineConfig, devices } from '@playwright/test'

// QC suite (ADR 0018, factory/plans/qc-suite.sv): the production build,
// served by `vite preview`, driven by headless Chromium against a live
// Convex dev deployment. Runs outside the Claude sandbox (WebSockets don't
// pass its proxy) and is never part of `pnpm check`.
//
// Step 1 skeleton: one build against dev/qc-1. The instance pool (step 2)
// replaces the single webServer with one build and port per instance.

// Playwright's browser download is blocked here, so use the system
// Chromium. QC_CHROMIUM overrides it; with neither (CI) Playwright falls
// back to its own browser.
const chromium =
  process.env.QC_CHROMIUM ??
  (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined)

const convexUrl =
  process.env.QC_CONVEX_URL ??
  'https://expert-oriole-119.eu-west-1.convex.cloud'
const port = 4101
const outDir = 'dist-qc/qc-1'

export default defineConfig({
  testDir: 'qc',
  testMatch: '**/*.spec.ts',
  // A flaky test is a failure to investigate, not to retry.
  retries: 0,
  forbidOnly: true,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'qc-report/playwright', open: 'never' }],
    ['./qc/reporter.ts'],
  ],
  outputDir: 'test-results',
  use: {
    baseURL: `http://localhost:${port}`,
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
  webServer: {
    command: `vite build --outDir ${outDir} --emptyOutDir && vite preview --outDir ${outDir} --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    env: { VITE_CONVEX_URL: convexUrl },
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
