/**
 * Which backend this build talks to (rust spike, step 2b): `convex` (the
 * default, and everything `main` ships) or `rust` (the `rs/` API, contacts
 * only). Fixed at build time by `VITE_BACKEND`, so every hook choice in
 * `src/lib/data` is made once, at module load, never per render.
 */
export type Backend = 'convex' | 'rust'

export const BACKEND: Backend =
  import.meta.env.VITE_BACKEND === 'rust' ? 'rust' : 'convex'

/**
 * What the Rust backend doesn't have yet (out of the spike's scope): the
 * pages leave these out on `rust` rather than calling Convex.
 */
export const FEATURES = {
  sourceCodes: BACKEND === 'convex',
  identifiers: BACKEND === 'convex',
  notes: BACKEND === 'convex',
  gifts: BACKEND === 'convex',
  emailHolds: BACKEND === 'convex',
  bulkSetField: BACKEND === 'convex',
  settings: BACKEND === 'convex',
} as const
