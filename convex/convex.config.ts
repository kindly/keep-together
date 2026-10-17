import { defineApp } from 'convex/server'
import { v } from 'convex/values'

// Typed app env vars, read as `env` from ./_generated/server.
const app = defineApp({
  env: {
    // "1" lets platform/qcSeed create known-password owners (QC pool only).
    QC_SEED_ENABLED: v.optional(v.string()),
  },
})

export default app
