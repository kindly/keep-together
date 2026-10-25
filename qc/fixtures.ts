import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test as base, expect } from '@playwright/test'
import type { BrowserContext, Page } from '@playwright/test'
import { assertFlow, probeRtt, runFlow, runId, tapContext } from './timing'
import type { FlowName } from './budgets'
import type { FlowRecord, FlowStep } from './timing'
import { pendingStep } from './pending'
import { recordRetry } from './retries'
import { nextTotp } from './totp'
import type { QcWorld } from '../src/lib/data/rust-types/QcWorld'

// QC fixtures (factory/plans/qc-suite.sv step 4; migration-rust F3). Specs
// import `test` and `expect` from here, not from @playwright/test.
//
// Per worker: an instance from the pool (a local release api with its own
// data dir, or staging; qc/.instances.json, written by scripts/qc.mjs),
// its RTT, a freshly seeded world (`POST /api/dev/qc-seed`, or on staging
// the token surface `/api/qc/seed`: two tenants, `qc-r<run>w<n>-a|b`;
// admins A and B, plus a staff and a viewer member of tenant A), and one timed UI sign-in per admin (`auth.signIn`: password,
// then a TOTP code from the seeded secret). Tests start signed in as user A
// on the worker's own instance, each browser context with a session of
// its own (`session`).
//
// The world is shared by every test in a worker, and by the replacement
// worker Playwright starts after a failure (same parallelIndex, and the
// seed returns the existing tenants). So a spec never relies on the state
// another test leaves: it creates the entities it changes, or puts back
// what it changed.
//
// A test of a module not ported yet (qc/pending.ts) is skipped with a
// `pendingPort` annotation before any fixture runs.

export interface Instance {
  /** qc-1 …, or staging. */
  name: string
  /**
   * How set-up reaches the api: `dev` (a local pool api with dev auth and
   * KEEP_QC_SEED: `/api/dev/*`), or `qc` (staging: `/api/qc/*` with
   * KEEP_QC_TOKEN from the env, never written to a file).
   */
  surface?: 'dev' | 'qc'
  /** The api's origin, for Node (seed, sign-in, RTT). */
  api: string
  /** The SPA's origin, for the browser (it proxies /api to the api). */
  baseURL: string
}

export type World = Omit<QcWorld, 'tenants'> & {
  /** tenantId is the slug: the Rust API is addressed by slug. */
  tenants: Array<QcWorld['tenants'][number] & { tenantId: string }>
}

export type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>

export interface QcUser {
  email: string
  password: string
  /** The seeded TOTP secret (base32): codes from `nextTotp`. */
  totpSecret: string
  /** The user's tenant (A, staff, viewer: tenants[0]; B: tenants[1]). */
  slug: string
}

export function readInstances(): Array<Instance> {
  return JSON.parse(readFileSync('qc/.instances.json', 'utf8'))
}

/** The set-up route on `inst`'s surface: `/api/dev/<dev>` or `/api/qc/<qc>`. */
function setupRoute(inst: Instance, dev: string, qc: string): string {
  return inst.surface === 'qc' ? `/api/qc/${qc}` : `/api/dev/${dev}`
}

/** The token header for the `qc` surface (KEEP_QC_TOKEN). */
function setupHeaders(inst: Instance): Record<string, string> {
  if (inst.surface !== 'qc') return {}
  const token = process.env.KEEP_QC_TOKEN
  if (!token)
    throw new Error('KEEP_QC_TOKEN is unset: the staging run needs it')
  return { 'x-keep-qc-token': token }
}

/**
 * How long a set-up call may take, its body included. They answer in
 * milliseconds; one that hangs (once on staging, 2026-10-25: a session
 * call never answered and the test timed out at 30 s "setting up
 * storageState") fails or retries with its route named, well inside the
 * test's timeout.
 */
const SETUP_TIMEOUT_MS = 10_000

/** The test a set-up call is for, or `worker setup` outside one. */
function setupWhere(): string {
  try {
    return base.info().titlePath.join(' › ')
  } catch {
    return 'worker setup'
  }
}

async function post<T>(
  inst: Instance,
  route: string,
  body: unknown,
  /**
   * Safe to send twice, and nothing a late first try could undo: one
   * retry after no answer, recorded (qc/retries.ts). A session is (each
   * call makes its own); the seed isn't (each sets new credentials, and
   * an abandoned first try still running on the server could overwrite
   * the retry's), so it never retries.
   */
  retry = false,
): Promise<{ data: T; res: Response }> {
  let res: Response
  let text: string
  try {
    res = await fetch(`${inst.api}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...setupHeaders(inst) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SETUP_TIMEOUT_MS),
    })
    text = await res.text()
  } catch (err) {
    // No answer, or no whole body: a timeout or a network error. Never an
    // HTTP status.
    const why = err instanceof Error ? err.name : String(err)
    if (!retry)
      throw new Error(`${route}: no answer (${why}) from ${inst.name}`)
    console.warn(`qc set-up ${route}: no answer (${why}), retrying once`)
    recordRetry({
      route,
      instance: inst.name,
      where: setupWhere(),
      why,
      at: Date.now(),
    })
    return post<T>(inst, route, body, false)
  }
  // The body, never the request: it can't hold the token.
  if (!res.ok) throw new Error(`${route}: ${res.status} ${text}`)
  return { data: JSON.parse(text) as T, res }
}

/**
 * The session cookie's name for `url`'s host, as the api reads it:
 * `kt_session` on a loopback host (local http), else `__Host-kt_session`
 * (Secure, host-only; `api::auth::COOKIE_NAME`).
 */
export function cookieName(url: string): string {
  const host = new URL(url).hostname
  return ['127.0.0.1', 'localhost', '[::1]'].includes(host)
    ? 'kt_session'
    : '__Host-kt_session'
}

/** A `Cookie` header carrying `token` to `inst`'s api. */
export function sessionCookie(inst: Instance, token: string): string {
  return `${cookieName(inst.api)}=${token}`
}

/**
 * A session for `email` on `inst`, without a sign-in (a TOTP code is good
 * once per 30 s step, and each test wants its own session): the dev login
 * locally, `/api/qc/session` (QC users only) on staging. The session
 * cookie's value.
 */
export async function sessionToken(
  inst: Instance,
  email: string,
): Promise<string> {
  const { res } = await post(
    inst,
    setupRoute(inst, 'login', 'session'),
    { email },
    true,
  )
  const value = res.headers
    .get('set-cookie')
    ?.match(/(?:^|[ ,;])(?:__Host-)?kt_session=([^;]+)/)?.[1]
  if (!value) throw new Error(`no session cookie for ${email}`)
  return value
}

/** A browser storageState carrying one session, for `inst`'s SPA origin. */
export function sessionState(inst: Instance, token: string): StorageState {
  const url = new URL(inst.baseURL)
  const secure = url.protocol === 'https:'
  return {
    cookies: [
      {
        name: cookieName(inst.baseURL),
        value: token,
        domain: url.hostname,
        path: '/',
        expires: -1,
        httpOnly: true,
        secure,
        sameSite: 'Lax',
      },
    ],
    origins: [],
  }
}

/**
 * `GET` an api path as `user` (a fresh session), for what the pages
 * don't show: the JSON body, or throws on a refusal.
 */
export async function apiGet<T>(
  inst: Instance,
  user: QcUser,
  route: string,
): Promise<T> {
  const token = await sessionToken(inst, user.email)
  const res = await fetch(`${inst.api}${route}`, {
    headers: { cookie: sessionCookie(inst, token) },
  })
  if (!res.ok) throw new Error(`${route}: ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}

/**
 * `POST` an api path as `user` (a fresh session), for setup a spec
 * doesn't time through a page: the JSON body, or throws on a refusal.
 */
export async function apiPost<T>(
  inst: Instance,
  user: QcUser,
  route: string,
  body: unknown,
): Promise<T> {
  const token = await sessionToken(inst, user.email)
  const res = await fetch(`${inst.api}${route}`, {
    method: 'POST',
    headers: {
      cookie: sessionCookie(inst, token),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${route}: ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}

/**
 * Hold `address` in `slug`, as a hard bounce does (`qc-hold`). An
 * admin's release lifts it again.
 */
export async function qcHold(
  inst: Instance,
  args: { slug: string; address: string },
): Promise<unknown> {
  return (await post(inst, setupRoute(inst, 'qc-hold', 'hold'), args)).data
}

/**
 * `count` individuals with one last name in `slug`, written in bulk by the
 * api (`qc-crowd`): the paged list's crowd. Each tenant is its own file,
 * so the write holds up no other worker's samples.
 */
export async function qcCrowd(
  inst: Instance,
  args: { slug: string; lastName: string; count: number },
): Promise<unknown> {
  return (await post(inst, setupRoute(inst, 'qc-crowd', 'crowd'), args)).data
}

/** The refusal a form shows for what needs email when mail is off. */
export const MAIL_OFF_MESSAGE = "Email isn't set up here"

/**
 * Whether `world`'s api has mail off for QC's users (`KEEP_MAIL=off`, or
 * staging's `KEEP_MAIL_ONLY_TO` not listing them), as the seed reports it. If so, the test is annotated
 * `mailOff`, which the run's MAIL OFF banner and history list, and it
 * checks the `mail_off` refusal instead of the path that sends email.
 */
export function mailOff(world: World): boolean {
  if (world.mailOff)
    base.info().annotations.push({
      type: 'mailOff',
      description: 'checked the mail_off refusal; the email path did not run',
    })
  return world.mailOff
}

type Flow = <TArg = undefined>(
  page: Page,
  name: FlowName,
  step: FlowStep<TArg>,
) => Promise<FlowRecord>

interface WorkerFixtures {
  instance: Instance
  rttMs: number
  world: World
  users: { a: QcUser; b: QcUser; staff: QcUser; viewer: QcUser }
}

interface TestFixtures {
  /** Skips a test whose module isn't ported yet (qc/pending.ts). */
  pendingPort: void
  /** Time a flow K times and fail the test if it's over budget. */
  flow: Flow
  /**
   * A new signed-in session for a user (default A), as a storageState for
   * one browser context.
   */
  session: (user?: QcUser) => Promise<StorageState>
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  // First, and needing no worker fixture: a pending test never seeds.
  pendingPort: [
    // eslint-disable-next-line no-empty-pattern -- Playwright needs the pattern
    async ({}, use, testInfo) => {
      const step = pendingStep(testInfo.file, testInfo.titlePath.slice(1))
      if (step) {
        testInfo.annotations.push({ type: 'pendingPort', description: step })
        testInfo.skip(true, `pendingPort ${step}: not on the Rust backend yet`)
      }
      await use()
    },
    { auto: true },
  ],

  // parallelIndex, not workerIndex: it stays in 0..workers-1 when a worker
  // restarts after a failure, so the pool stays evenly loaded.
  instance: [
    // eslint-disable-next-line no-empty-pattern -- Playwright needs the pattern
    async ({}, use, workerInfo) => {
      const pool = readInstances()
      await use(pool[workerInfo.parallelIndex % pool.length])
    },
    { scope: 'worker' },
  ],

  rttMs: [
    async ({ instance }, use) => {
      await use(await probeRtt(instance.api))
    },
    { scope: 'worker' },
  ],

  world: [
    async ({ instance }, use, workerInfo) => {
      const route = setupRoute(instance, 'qc-seed', 'seed')
      const { data } = await post<QcWorld>(instance, route, {
        runId: runId(),
        worker: workerInfo.parallelIndex,
      })
      await use({
        ...data,
        tenants: data.tenants.map((t) => ({ ...t, tenantId: t.slug })),
      })
    },
    { scope: 'worker' },
  ],

  users: [
    async ({ browser, instance, rttMs, world }, use, workerInfo) => {
      const signIn = async (i: 0 | 1): Promise<QcUser> => {
        const { email, password, totpSecret } = world.users[i]
        const { slug } = world.tenants[i]
        const context = await browser.newContext({
          baseURL: instance.baseURL,
          viewport: { width: 1280, height: 800 },
        })
        await tapContext(context)
        const page = await context.newPage()
        // One sign-in per user and worker, no warm-up: each is its own
        // one-sample record, judged by the same rule (every sample under
        // budget, one re-measure after a spike). The reporter judges them,
        // so a slow sign-in fails the run without failing every test in
        // this worker.
        await runFlow(
          {
            page,
            rttMs,
            worker: workerInfo.parallelIndex,
            instance: instance.name,
            where: 'worker setup',
            repeats: 1,
            warmUp: false,
            tracePath: path.join(
              'test-results',
              '.traces',
              runId(),
              `w${workerInfo.parallelIndex}-${'ab'[i]}-auth.signIn.zip`,
            ),
          },
          'auth.signIn',
          {
            // The password step is set-up; the timed gesture is the
            // code's Verify, the one that lands in the group.
            before: async () => {
              // A re-measure starts signed in: drop the session.
              await context.clearCookies()
              await page.goto('/')
              await page.getByPlaceholder('Email').fill(email)
              await page.getByPlaceholder('Password').fill(password)
              await page.getByRole('button', { name: 'Sign in' }).click()
              await page.getByPlaceholder('Code').waitFor()
            },
            action: async () => {
              await page
                .getByPlaceholder('Code')
                .fill(await nextTotp(totpSecret))
              await page.getByRole('button', { name: 'Verify' }).click()
            },
            // Signing in lands on the group's home: its header drawn.
            until: (s) =>
              location.pathname === `/t/${s}` &&
              document.querySelector('nav[aria-label="Main"]') !== null,
            arg: slug,
          },
        )
        await context.close()
        return { email, password, totpSecret, slug }
      }
      const a = await signIn(0)
      const member = (role: 'staff' | 'viewer'): QcUser => {
        const { email, password, totpSecret } = world.users.find(
          (u) => u.role === role,
        )!
        return { ...a, email, password, totpSecret }
      }
      await use({
        a,
        b: await signIn(1),
        staff: member('staff'),
        viewer: member('viewer'),
      })
    },
    { scope: 'worker' },
  ],

  baseURL: async ({ instance }, use) => {
    await use(instance.baseURL)
  },

  session: async ({ instance, users }, use) => {
    await use(async (user = users.a) =>
      sessionState(instance, await sessionToken(instance, user.email)),
    )
  },

  // The default page's context: the fetch tap from its first script. Its
  // console and uncaught page errors are kept and attached to a test that
  // fails: with tracing off (playwright.config.ts) a flaky failure
  // otherwise leaves only a screenshot and the call log.
  context: async ({ context }, use, testInfo) => {
    await tapContext(context)
    const log: Array<string> = []
    const at = () => new Date().toISOString().slice(11, 23)
    context.on('console', (m) => {
      const where = m.location()
      log.push(
        `${at()} console.${m.type()} ${m.text()}` +
          (where.url ? ` (${where.url}:${where.lineNumber})` : ''),
      )
    })
    context.on('weberror', (e) =>
      log.push(`${at()} pageerror ${e.error().stack ?? String(e.error())}`),
    )
    await use(context)
    if (testInfo.status !== testInfo.expectedStatus && log.length) {
      await testInfo.attach('console', {
        body: log.join('\n'),
        contentType: 'text/plain',
      })
    }
  },

  storageState: async ({ session }, use) => {
    await use(await session())
  },

  flow: async ({ instance, rttMs }, use, testInfo) => {
    await use(async (page, name, step) => {
      const record = await runFlow(
        {
          page,
          rttMs,
          worker: testInfo.parallelIndex,
          instance: instance.name,
          where: testInfo.titlePath.join(' › '),
          tracePath: testInfo.outputPath(`trace-${name}.zip`),
        },
        name,
        step,
      )
      await testInfo.attach(`flow ${name}`, {
        body: JSON.stringify(record, null, 2),
        contentType: 'application/json',
      })
      // Named `trace`, the HTML report opens it in the trace viewer.
      if (record.trace)
        await testInfo.attach('trace', {
          path: record.trace,
          contentType: 'application/zip',
        })
      assertFlow(record)
      return record
    })
  },
})

export { expect }
