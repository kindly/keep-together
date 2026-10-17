import { defineApp } from 'convex/server'
import { v } from 'convex/values'
import migrations from '@convex-dev/migrations/convex.config.js'

// Typed app env vars, read as `env` from ./_generated/server.
const app = defineApp({
  env: {
    // "1" lets platform/qcSeed create known-password admins (QC pool only).
    QC_SEED_ENABLED: v.optional(v.string()),
    // "1" lets platform/testSeed create the manual-test instances' users
    // (dev/demo and dev/preview only; scripts/test-instances.mjs sets it).
    TEST_SEED_ENABLED: v.optional(v.string()),
    // "0" exempts staff password sign-ins from 2FA. Unread until 2FA exists
    // (auth-roles R4, Better Auth), which must honour it; set only on the
    // manual-test instances. Absent or anything else = 2FA required.
    AUTH_2FA_REQUIRED: v.optional(v.string()),
  },
})

// Batched, resumable data migrations (convex/lib/migrations.ts).
app.use(migrations)

export default app
