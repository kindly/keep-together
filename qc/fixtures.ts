import { execFile } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { test as base, expect } from '@playwright/test'
import { ConvexHttpClient } from 'convex/browser'
import type { BrowserContext, Page } from '@playwright/test'
import { api } from '../convex/_generated/api'
import {
  assertFlow,
  probeRtt,
  runDir,
  runFlow,
  runId,
  startRttMonitor,
} from './timing'
import type { FlowName } from './budgets'
import type { FlowRecord, FlowStep } from './timing'

// QC fixtures (factory/plans/qc-suite.sv, step 4). Specs import `test` and
// `expect` from here, not from @playwright/test.
//
// Per worker: an instance from the pool, its RTT, a freshly seeded world
// (two tenants, `r<run>w<n>-a|b`; admins A and B, plus a staff and a
// viewer member of tenant A), and a storageState per admin from one UI
// sign-in each, which is also the timed `auth.signIn` flow. Staff and
// viewer reuse A's storageState as their template (the keys name the
// deployment, not the user). Tests start signed in as user A on the
// worker's own instance.
//
// That storageState is a template, never loaded as is: every test context
// gets its own Convex Auth session (`session`). Convex Auth rotates the
// refresh token on each refresh and treats a used token presented again
// more than 10 s later as replay, invalidating the whole session
// (node_modules/@convex-dev/auth/dist/server/implementation/mutations/
// refreshSession.js, REFRESH_TOKEN_REUSE_WINDOW_MS). The SPA refreshes on
// page load, so contexts sharing one token sign each other out at random.
//
// The world is shared by every test in a worker, and by the replacement
// worker Playwright starts after a failure (same parallelIndex, and the
// seed returns the existing tenants). So a spec never relies on the state
// another test leaves: it creates the entities it changes, or puts back
// what it changed.

export interface Instance {
  name: string
  deployment: string
  url: string
  envFile: string
  port: number
  outDir: string
}

export interface World {
  /** a, b, then tenant A's staff and viewer. */
  users: Array<{ email: string; role: 'admin' | 'staff' | 'viewer' }>
  tenants: Array<{ slug: string; tenantId: string; contactIds: Array<string> }>
  /** The type A's Ada holds `shared` under (archived in B). */
  identifierType: string
  /** Seeded values: A's and B's Ada `shared`; B only `bOnly`, `bReuse`. */
  identifiers: { shared: string; bOnly: string; bReuse: string }
}

export type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>

export interface QcUser {
  email: string
  password: string
  /** The user's tenant (A, staff, viewer: tenants[0]; B: tenants[1]). */
  slug: string
  /** A signed-in storageState: a template for `session`, never loaded. */
  storageState: string
}

export function readInstances(): Array<Instance> {
  return JSON.parse(readFileSync('qc/.instances.json', 'utf8'))
}

/** Every seeded user's password in this run. */
export function qcPassword(): string {
  return `qc-${runId()}-password`
}

function deployKey(envFile: string): string {
  const key = readFileSync(envFile, 'utf8').match(
    /^CONVEX_DEPLOY_KEY=(dev:.+)$/m,
  )?.[1]
  if (!key) throw new Error(`${envFile}: no dev CONVEX_DEPLOY_KEY`)
  return key
}

/** `npx convex …` against one pool instance, by its deploy key only. */
export async function convexOn(
  inst: Instance,
  args: Array<string>,
): Promise<string> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CONVEX_DEPLOY_KEY: deployKey(inst.envFile),
  }
  delete env.CONVEX_DEPLOYMENT
  const { stdout } = await promisify(execFile)('npx', ['convex', ...args], {
    env,
    maxBuffer: 16 * 1024 * 1024,
  })
  return stdout
}

type Flow = <TArg = undefined>(
  page: Page,
  name: FlowName,
  step: FlowStep<TArg>,
) => Promise<FlowRecord>

interface WorkerFixtures {
  instance: Instance
  rttMs: number
  /** Probes the RTT every 2 s for the life of the worker (context only). */
  rttMonitor: void
  world: World
  users: { a: QcUser; b: QcUser; staff: QcUser; viewer: QcUser }
}

interface TestFixtures {
  /** Time a flow K times and fail the test if it's over budget. */
  flow: Flow
  /**
   * A new signed-in session for a user (default A), as a storageState for
   * one browser context. Never share one between contexts (see the top).
   */
  session: (user?: QcUser) => Promise<StorageState>
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
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
      await use(await probeRtt(instance.url))
    },
    { scope: 'worker' },
  ],

  // Written to the run directory as rtt-<pid>.jsonl, next to the flow
  // records, so a stall can be set against the link at that moment.
  // After rttMs (it depends on it), so its probes never overlap the
  // worker's RTT measurement, which decides whether flows are judged.
  rttMonitor: [
    async ({ instance, rttMs: _ }, use, workerInfo) => {
      const dir = runDir()
      mkdirSync(dir, { recursive: true })
      const file = path.join(dir, `rtt-${process.pid}.jsonl`)
      const stop = startRttMonitor(instance.url, 2_000, (at, ms, lagMs) =>
        appendFileSync(
          file,
          JSON.stringify({
            at,
            ms,
            lagMs,
            worker: workerInfo.parallelIndex,
            instance: instance.name,
          }) + '\n',
        ),
      )
      await use()
      await stop()
    },
    { scope: 'worker', auto: true },
  ],

  world: [
    async ({ instance }, use, workerInfo) => {
      const out = await convexOn(instance, [
        'run',
        'platform/qcSeed:fixture',
        JSON.stringify({
          runId: runId(),
          worker: workerInfo.parallelIndex,
          password: qcPassword(),
        }),
      ])
      await use(JSON.parse(out) as World)
    },
    { scope: 'worker' },
  ],

  users: [
    async ({ browser, instance, rttMs, world }, use, workerInfo) => {
      const dir = path.join('test-results', '.auth', runId())
      mkdirSync(dir, { recursive: true })
      const password = qcPassword()
      const signIn = async (i: 0 | 1): Promise<QcUser> => {
        const { email } = world.users[i]
        const { slug } = world.tenants[i]
        const context = await browser.newContext({
          baseURL: `http://localhost:${instance.port}`,
          viewport: { width: 1280, height: 800 },
        })
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
          },
          'auth.signIn',
          {
            before: async () => {
              await page.goto('/')
              // A re-measure starts signed in: drop the session (the saved
              // storageState is the one taken after the last sign-in).
              if (
                await page.evaluate(() =>
                  Object.keys(localStorage).some((k) =>
                    k.startsWith('__convexAuth'),
                  ),
                )
              ) {
                await page.evaluate(() => localStorage.clear())
                await page.goto('/')
              }
              await page.getByPlaceholder('Email').fill(email)
              await page.getByPlaceholder('Password').fill(password)
            },
            action: () => page.getByRole('button', { name: 'Sign in' }).click(),
            until: (s) => document.body.innerText.includes(s),
            arg: slug,
          },
        )
        const storageState = path.join(
          dir,
          `w${workerInfo.parallelIndex}-${'ab'[i]}.json`,
        )
        await context.storageState({ path: storageState })
        await context.close()
        return { email, password, slug, storageState }
      }
      const a = await signIn(0)
      const member = (role: 'staff' | 'viewer'): QcUser => {
        const { email } = world.users.find((u) => u.role === role)!
        return { ...a, email }
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
    await use(`http://localhost:${instance.port}`)
  },

  session: async ({ instance, users }, use) => {
    const client = new ConvexHttpClient(instance.url)
    await use(async (user = users.a) => {
      const template = JSON.parse(
        readFileSync(user.storageState, 'utf8'),
      ) as StorageState
      const { tokens } = await client.action(api.auth.signIn, {
        provider: 'password',
        params: { email: user.email, password: user.password, flow: 'signIn' },
      })
      if (!tokens) throw new Error(`no session for ${user.email}`)
      const value = (name: string, old: string) =>
        name.startsWith('__convexAuthJWT_')
          ? tokens.token
          : name.startsWith('__convexAuthRefreshToken_')
            ? tokens.refreshToken
            : old
      const keys = template.origins.flatMap((o) =>
        o.localStorage.map((e) => e.name),
      )
      if (!keys.some((k) => k.startsWith('__convexAuthRefreshToken_')))
        throw new Error(`${user.storageState}: no Convex Auth tokens`)
      return {
        ...template,
        origins: template.origins.map((o) => ({
          ...o,
          localStorage: o.localStorage.map((e) => ({
            ...e,
            value: value(e.name, e.value),
          })),
        })),
      }
    })
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
        },
        name,
        step,
      )
      await testInfo.attach(`flow ${name}`, {
        body: JSON.stringify(record, null, 2),
        contentType: 'application/json',
      })
      assertFlow(record)
      return record
    })
  },
})

export { expect }
