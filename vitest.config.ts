import { configDefaults, defineConfig } from 'vitest/config'

// convex-test runs functions in an edge-like runtime; see
// https://docs.convex.dev/testing/convex-test
export default defineConfig({
  test: {
    environment: 'edge-runtime',
    server: { deps: { inline: ['convex-test'] } },
    include: ['convex/**/*.test.ts', 'src/**/*.test.{ts,tsx}'],
    // qc/ is the Playwright suite (`pnpm qc`), never part of `pnpm check`.
    exclude: [...configDefaults.exclude, 'qc/**'],
  },
})
