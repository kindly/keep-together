import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  // As vite.config.ts: shadcn components import `@/…`.
  resolve: { tsconfigPaths: true },
  test: {
    // *.dom.test.tsx opt into happy-dom per file.
    environment: 'node',
    // qc/*.test.ts are unit tests of the QC harness's pure parts;
    // scripts/*.test.mjs test the instance scripts' lock files.
    include: [
      'src/**/*.test.{ts,tsx}',
      'qc/**/*.test.ts',
      'scripts/**/*.test.mjs',
    ],
    // qc/*.spec.ts is the Playwright suite (`pnpm qc`), never part of
    // `pnpm check`.
    exclude: [...configDefaults.exclude, 'qc/**/*.spec.ts'],
  },
})
