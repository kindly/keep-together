import { Password } from '@convex-dev/auth/providers/Password'
import { convexAuth } from '@convex-dev/auth/server'

// Email + password to start (ADR 0017). Swap/add providers here only.
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [Password],
})
