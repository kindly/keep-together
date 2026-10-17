import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackRouter } from '@tanstack/router-plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const config = defineConfig({
  // GitHub Pages serves the SPA under /<repo>/; the workflow sets BASE_PATH.
  // Locally and on any root-hosted static host this stays '/'.
  base: process.env.BASE_PATH ?? '/',
  // `tailscale serve` fronts the dev server with HTTPS on the tailnet name.
  server: { allowedHosts: ['.ts.net'] },
  resolve: { tsconfigPaths: true },
  plugins: [
    devtools(),
    tailwindcss(),
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    viteReact(),
  ],
})

export default config
