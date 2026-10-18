import { configDefaults, defineConfig } from 'vitest/config'

// convex-test runs functions in an edge-like runtime; see
// https://docs.convex.dev/testing/convex-test
export default defineConfig({
  test: {
    environment: 'edge-runtime',
    server: { deps: { inline: ['convex-test'] } },
    // qc/*.test.ts are unit tests of the QC harness's pure parts;
    // scripts/*.test.mjs test the instance scripts' lock files.
    include: [
      'convex/**/*.test.ts',
      'src/**/*.test.{ts,tsx}',
      'qc/**/*.test.ts',
      'scripts/**/*.test.mjs',
    ],
    // qc/*.spec.ts is the Playwright suite (`pnpm qc`), never part of
    // `pnpm check`.
    exclude: [...configDefaults.exclude, 'qc/**/*.spec.ts'],
  },
})
