/**
 * Staff auth on the Rust API (`/api/auth/*`, the members routes): the
 * sign-in steps, links from emails, the account, the members page. A
 * sign-in is two requests (password, then a code); between them the
 * browser holds a partial session that reaches nothing but these routes,
 * so `/api/me` answers 401 and the app treats it as signed out.
 *
 * Too many wrong codes end a partial sign-in (`sign_in_again`) or lock the
 * second step for an hour (`locked`): the state is refetched (signed out)
 * and the reason kept for the password form to show ([`useSignInNotice`]).
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { AccountInfo } from '../rust-types/AccountInfo'
import type { AuthState } from '../rust-types/AuthState'
import type { Enrolled } from '../rust-types/Enrolled'
import type { InviteInfo } from '../rust-types/InviteInfo'
import type { InviteInfoRow } from '../rust-types/InviteInfoRow'
import type { MembersPage } from '../rust-types/MembersPage'
import type { Method } from '../rust-types/Method'
import type { RecoveryCodes } from '../rust-types/RecoveryCodes'
import type { Role } from '../rust-types/Role'
import type { SessionInfo } from '../rust-types/SessionInfo'
import type { TotpEnrolment } from '../rust-types/TotpEnrolment'
import { authErrorMessage } from '../../auth-errors'
import { RustApiError, get, post, tenantPath } from './client'
import { keys } from './keys'

export type {
  AccountInfo,
  AuthState,
  InviteInfo,
  MembersPage,
  Method,
  Role,
  SessionInfo,
}

const authKey = ['auth'] as const
const accountKey = ['auth', 'account'] as const
const sessionsKey = ['auth', 'account', 'sessions'] as const
const noticeKey = ['auth', 'notice'] as const

/** Why the last partial sign-in ended, if it did (shown once). */
export function useSignInNotice(): string | null {
  return (
    useQuery({
      queryKey: noticeKey,
      queryFn: () => null as string | null,
      initialData: null,
      staleTime: Infinity,
    }).data ?? null
  )
}

/** Whether `err` ended the partial sign-in (the password is next). */
const endedSignIn = (err: unknown) =>
  err instanceof RustApiError &&
  err.error.kind === 'rejected' &&
  (err.error.reason === 'sign_in_again' || err.error.reason === 'locked')
const membersKey = (slug: string) => ['t', slug, 'members'] as const

/** Where this browser's sign-in stands; undefined while loading. */
export function useAuthState(): AuthState | undefined {
  return useQuery({
    queryKey: authKey,
    queryFn: () => get<AuthState>('auth/state'),
  }).data
}

/**
 * After a step that changed the session (a new cookie, or none): the new
 * state goes into the cache, and everything read as the last session is
 * dropped and refetched as shown.
 */
function useSessionChanged() {
  const qc = useQueryClient()
  return async (state: AuthState) => {
    qc.setQueryData(authKey, state)
    // Everything but the state just set (the account included).
    await qc.resetQueries({
      predicate: (q) => !(q.queryKey.length === 1 && q.queryKey[0] === 'auth'),
    })
  }
}

/** The sign-in steps, each answering the new state. */
export function useSignInSteps() {
  const changed = useSessionChanged()
  const qc = useQueryClient()
  /** `f`; if it ended the sign-in, back to the password, saying why. */
  const ending = async <T,>(f: () => Promise<T>) => {
    try {
      return await f()
    } catch (err) {
      if (endedSignIn(err)) {
        qc.setQueryData(noticeKey, authErrorMessage(err))
        await qc.invalidateQueries({ queryKey: authKey, exact: true })
      }
      throw err
    }
  }
  const step = async (path: string, body: unknown = {}) => {
    const state = await post<AuthState>(path, body)
    await changed(state)
    return state
  }
  return {
    /**
     * `check_email` (too many sign-ins for the address lately): no session
     * yet; send the password again with the emailed code.
     */
    signIn: async (email: string, password: string, emailCode?: string) => {
      qc.setQueryData(noticeKey, null)
      const state = await post<AuthState>('auth/sign-in', {
        email,
        password,
        emailCode,
      })
      if (state.stage !== 'check_email') await changed(state)
      return state
    },
    secondFactor: (code: string) =>
      ending(() => step('auth/second-factor', { code })),
    /** A new emailed code (method email). */
    sendCode: () => post<{ ok: boolean }>('auth/send-code'),
    enrolTotp: () => post<TotpEnrolment>('auth/enrol/totp'),
    enrolEmail: () => post<{ ok: boolean }>('auth/enrol/email'),
    /**
     * The codes, and `done` to move the page on (signed in) once they've
     * been shown: the session already changed on the server.
     */
    /**
     * `extra`: after a 2FA reset, the emailed code (`emailCode`); changing
     * method while signed in, the password and a code from the current
     * factor (`password`, `currentCode`).
     */
    confirmEnrolment: async (
      method: Method,
      code: string,
      extra: {
        emailCode?: string
        password?: string
        currentCode?: string
      } = {},
    ) => {
      const out = await ending(() =>
        post<Enrolled>('auth/enrol/confirm', { method, code, ...extra }),
      )
      return {
        recoveryCodes: out.recoveryCodes,
        done: () => changed(out.state),
      }
    },
    /** Same user, new token: nothing read needs dropping. */
    stepUp: async (password: string, code: string) => {
      const state = await post<AuthState>('auth/step-up', { password, code })
      qc.setQueryData(authKey, state)
      await qc.invalidateQueries({ queryKey: accountKey })
      return state
    },
    acceptInvite: (token: string, password: string) =>
      step('auth/invite/accept', { token, password }),
  }
}

export function useSignOut() {
  const changed = useSessionChanged()
  return async () => {
    await changed(await post<AuthState>('auth/sign-out'))
  }
}

export const resetRequest = (email: string) =>
  post<{ ok: boolean }>('auth/reset/request', { email })
export const resetCheck = (token: string) =>
  post<{ valid: boolean }>('auth/reset/check', { token })
export const resetComplete = (token: string, password: string) =>
  post<{ ok: boolean }>('auth/reset/complete', { token, password })
export const inviteCheck = (token: string) =>
  post<InviteInfo>('auth/invite/check', { token })

// ── the account ────────────────────────────────────────────────────────────

export function useAccount(): AccountInfo | undefined {
  return useQuery({
    queryKey: accountKey,
    queryFn: () => get<AccountInfo>('auth/account'),
  }).data
}

export function useAccountActions() {
  const qc = useQueryClient()
  const refresh = () => qc.invalidateQueries({ queryKey: accountKey })
  return {
    changePassword: async (current: string, next: string) => {
      await post('auth/account/password', { current, new: next })
      await refresh()
    },
    newRecoveryCodes: async () => {
      const out = await post<RecoveryCodes>('auth/account/recovery-codes')
      await refresh()
      return out.recoveryCodes
    },
    /** Every session of yours but this one ends. */
    signOutOthers: async () => {
      await post('auth/account/sessions/sign-out-others')
      await qc.invalidateQueries({ queryKey: sessionsKey })
    },
  }
}

/** Your signed-in sessions, most recently used first. */
export function useSessions(): Array<SessionInfo> | undefined {
  return useQuery({
    queryKey: sessionsKey,
    queryFn: () => get<Array<SessionInfo>>('auth/account/sessions'),
  }).data
}

// ── members ────────────────────────────────────────────────────────────────

export function useMembersPage(slug: string): MembersPage | undefined {
  return useQuery({
    queryKey: membersKey(slug),
    queryFn: () => get<MembersPage>(tenantPath(slug, 'members')),
  }).data
}

export function useMemberActions(slug: string) {
  const qc = useQueryClient()
  const refresh = () => qc.invalidateQueries({ queryKey: membersKey(slug) })
  const act = async <T = void,>(parts: Array<string>, body: unknown = {}) => {
    try {
      return await post<T>(tenantPath(slug, 'members', ...parts), body)
    } finally {
      await refresh()
    }
  }
  return {
    invite: (email: string, role: Role) =>
      act<InviteInfoRow>(['invite'], { email, role }),
    revokeInvite: (id: string) => act(['invites', id, 'revoke']),
    setRole: async (userId: number, role: Role, you: boolean) => {
      await act([String(userId), 'role'], { role })
      // Your own role: the session rotated and the role is new.
      if (you) await qc.invalidateQueries({ queryKey: keys.me })
    },
    remove: (userId: number) => act([String(userId), 'remove']),
    reset2fa: (userId: number) => act([String(userId), 'reset-2fa']),
  }
}
