/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The Rust API's origin when it isn't the SPA's own (`src/lib/data`). */
  readonly VITE_API_BASE?: string
}
