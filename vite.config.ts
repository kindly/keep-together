import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import type { Connect, Plugin } from 'vite'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackRouter } from '@tanstack/router-plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * `/give/<group>` (and `/give/<group>/thanks`) is the donor's page,
 * `give.html`: in dev and preview as the api serves it from `dist/`
 * (`api::static_files`). Without this Vite would answer with the app.
 */
function givePage(): Plugin {
  const rewrite: Connect.NextHandleFunction = (req, _res, next) => {
    const path = (req.url ?? '').split('?')[0]
    if (path === '/give' || path.startsWith('/give/')) req.url = '/give.html'
    next()
  }
  return {
    name: 'keep-give-page',
    configureServer: (server) => void server.middlewares.use(rewrite),
    configurePreviewServer: (server) => void server.middlewares.use(rewrite),
  }
}

const config = defineConfig(({ mode }) => {
  // `.env.local` included, as the SPA sees it.
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env }
  // The Rust API (server/): same origin, so its session cookie needs no CORS.
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
    build: {
      // Three pages: the app, the phone's scanning page (src/scan/) and
      // the donor's page (src/give/). The last two share no code with the
      // app and so never load its bundle.
      rolldownOptions: {
        input: {
          main: fileURLToPath(new URL('index.html', import.meta.url)),
          scan: fileURLToPath(new URL('scan.html', import.meta.url)),
          give: fileURLToPath(new URL('give.html', import.meta.url)),
        },
      },
    },
    plugins: [
      givePage(),
      devtools(),
      tailwindcss(),
      tanstackRouter({ target: 'react', autoCodeSplitting: true }),
      viteReact(),
    ],
  }
})

export default config
