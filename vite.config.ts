import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackRouter } from '@tanstack/router-plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const config = defineConfig({
  // GitHub Pages serves the SPA under /<repo>/; the workflow sets BASE_PATH.
  // Locally and on any root-hosted static host this stays '/'.
  base: process.env.BASE_PATH ?? '/',
  server: {
    // `tailscale serve` fronts the dev server with HTTPS on the tailnet name.
    allowedHosts: ['.ts.net'],
    // The Rust API (rs/, VITE_BACKEND=rust): same origin, so its session
    // cookie needs no CORS. `KEEP_API` points it at another port.
    proxy: { '/api': process.env.KEEP_API ?? 'http://127.0.0.1:8787' },
  },
  // `vite preview` serves a build the same way (QC on the Rust backend).
  preview: {
    proxy: { '/api': process.env.KEEP_API ?? 'http://127.0.0.1:8787' },
  },
  resolve: { tsconfigPaths: true },
  plugins: [
    devtools(),
    tailwindcss(),
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    viteReact(),
  ],
})

export default config
