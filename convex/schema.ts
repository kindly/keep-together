import { authTables } from '@convex-dev/auth/server'
import { defineSchema } from 'convex/server'
import { appTables } from './lib/appSchema'

// Every table: the app's (`convex/lib/appSchema.ts`, where the tenancy
// rules for them are documented) and the auth library's.
export default defineSchema({
  ...authTables,
  ...appTables,
})
