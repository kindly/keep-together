/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Which backend the contacts pages run on (`src/lib/data`); default convex. */
  readonly VITE_BACKEND?: 'convex' | 'rust'
  readonly VITE_CONVEX_URL?: string
}
