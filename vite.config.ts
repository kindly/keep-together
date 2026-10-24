import { defineConfig, loadEnv } from 'vite'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackRouter } from '@tanstack/router-plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const config = defineConfig(({ mode }) => {
  // `.env.local` included, as the SPA sees it.
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env }
  // The Rust API (rs/): same origin, so its session cookie needs no CORS.
  // Each worktree runs its api on its own KEEP_PORT; KEEP_API overrides
  // the whole target. Dev and preview only: a build has no proxy.
  const api = env.KEEP_API ?? `http://127.0.0.1:${env.KEEP_PORT ?? '8787'}`
  const proxy = { '/api': api }
  return {
    // GitHub Pages serves the SPA under /<repo>/; the workflow sets BASE_PATH.
    // Locally and on any root-hosted static host this stays '/'.
    base: env.BASE_PATH ?? '/',
    server: {
      // `tailscale serve` fronts the dev server with HTTPS on the tailnet name.
      allowedHosts: ['.ts.net'],
      proxy,
    },
    // `vite preview` serves a build the same way (QC on the Rust backend).
    preview: { proxy },
    resolve: { tsconfigPaths: true },
    plugins: [
      devtools(),
      tailwindcss(),
      tanstackRouter({ target: 'react', autoCodeSplitting: true }),
      viteReact(),
    ],
  }
})

export default config
