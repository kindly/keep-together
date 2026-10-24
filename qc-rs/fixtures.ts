import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { test as base, expect } from '@playwright/test'
import type { BrowserContext, Page, Request } from '@playwright/test'
import { assertFlow, median, runDir, runFlow, runId } from './timing'
import type { FlowName } from './budgets'
import type { FlowRecord, FlowStep } from './timing'

// The QC fixtures on the Rust backend (rust spike step 3). The same
// interface as qc/fixtures.ts, so the Convex specs run unchanged where
// their features exist on Rust: a world seeded through
// `POST /api/dev/qc-seed`, one timed UI sign-in per admin (the dev
// sign-in: email, no password), and a fresh dev session per browser
// context (a cookie, so no token rotation to dodge).
//
// No WebSocket tap (the Rust SPA has none to tap): run with QC_LEGS=0 and
// QC_MODE=record, and read the samples, not a verdict.

/** The Rust API, reached directly (Node) or through `vite preview` (browser). */
export const API = process.env.KEEP_API ?? 'http://127.0.0.1:8787'
export const PREVIEW_PORT = Number(process.env.QC_RS_PORT ?? 4300)

/** Shaped like qc/fixtures.ts's, so the copied specs typecheck and run. */
export interface Instance {
  name: string
  deployment: string
  url: string
  envFile: string
  port: number
  outDir: string
}

export interface World {
  users: Array<{ email: string; role: 'admin' | 'staff' | 'viewer' }>
  /** tenantId is the slug: the Rust QC endpoints take slugs. */
  tenants: Array<{ slug: string; tenantId: string; contactIds: Array<string> }>
  /** Not on Rust (no identifiers): placeholders, never matched. */
  identifierType: string
  identifiers: { shared: string; bOnly: string; bReuse: string }
  field: { label: string; options: ReadonlyArray<string> }
}

export type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>

export interface QcUser {
  email: string
  password: string
  slug: string
  storageState: string
}

export function qcPassword(): string {
  return ''
}

async function api<T>(
  route: string,
  body: unknown,
  cookie?: string,
): Promise<{ data: T; res: Response }> {
  const res = await fetch(`${API}${route}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie && { cookie }),
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${route}: ${res.status} ${await res.text()}`)
  return { data: (await res.json()) as T, res }
}

/** A dev session for `email`: the `kt_session` cookie's value. */
export async function devLogin(email: string): Promise<string> {
  const { res } = await api('/api/dev/login', { email })
  const value = res.headers.get('set-cookie')?.match(/kt_session=([^;]+)/)?.[1]
  if (!value) throw new Error(`no session cookie for ${email}`)
  return value
}

export function sessionState(token: string): StorageState {
  return {
    cookies: [
      {
        name: 'kt_session',
        value: token,
        domain: 'localhost',
        path: '/',
        expires: -1,
        httpOnly: true,
        secure: false,
        sameSite: 'Lax',
      },
    ],
    origins: [],
  }
}

/**
 * The one Convex call the in-scope specs make (contacts.spec's Load more
 * crowd), mapped onto `POST /api/dev/qc-crowd`. Anything else is Convex-only.
 */
export async function convexOn(
  _inst: Instance,
  args: Array<string>,
): Promise<string> {
  if (args[0] === 'run' && args[1] === 'platform/qcSeed:crowd') {
    const { tenantId, lastName, count } = JSON.parse(args[2]) as {
      tenantId: string
      lastName: string
      count: number
    }
    const { data } = await api('/api/dev/qc-crowd', {
      slug: tenantId,
      lastName,
      count,
    })
    return JSON.stringify(data)
  }
  throw new Error(`convexOn ${args.join(' ')}: not on the Rust backend`)
}

/** Median HTTP round trip to the API (GET /api/me, connection reused). */
async function probeHttpRtt(samples = 10): Promise<number> {
  const times: Array<number> = []
  for (let i = 0; i <= samples; i++) {
    const t = performance.now()
    await (await fetch(`${API}/api/me`)).arrayBuffer()
    if (i > 0) times.push(performance.now() - t)
  }
  return Math.round(median(times) * 10) / 10
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
  flow: Flow
  session: (user?: QcUser) => Promise<StorageState>
}

interface RustWorld {
  users: Array<{ email: string; role: 'admin' | 'staff' | 'viewer' }>
  tenants: Array<{ slug: string; contactIds: Array<string> }>
  field: { label: string; options: Array<string> }
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  instance: [
    // eslint-disable-next-line no-empty-pattern -- Playwright needs the pattern
    async ({}, use) => {
      await use({
        name: 'rust',
        deployment: 'rust',
        url: API,
        envFile: '',
        port: PREVIEW_PORT,
        outDir: 'dist-qc-rs',
      })
    },
    { scope: 'worker' },
  ],

  rttMs: [
    // eslint-disable-next-line no-empty-pattern -- Playwright needs the pattern
    async ({}, use) => {
      await use(await probeHttpRtt())
    },
    { scope: 'worker' },
  ],

  world: [
    // eslint-disable-next-line no-empty-pattern -- Playwright needs the pattern
    async ({}, use, workerInfo) => {
      const { data } = await api<RustWorld>('/api/dev/qc-seed', {
        runId: runId(),
        worker: workerInfo.parallelIndex,
      })
      await use({
        users: data.users,
        tenants: data.tenants.map((t) => ({ ...t, tenantId: t.slug })),
        identifierType: '(none on rust)',
        identifiers: { shared: '-', bOnly: '-', bReuse: '-' },
        field: data.field,
      })
    },
    { scope: 'worker' },
  ],

  users: [
    async ({ browser, rttMs, world }, use, workerInfo) => {
      const dir = path.join('test-results', '.auth-rs', runId())
      mkdirSync(dir, { recursive: true })
      const signIn = async (i: 0 | 1): Promise<QcUser> => {
        const { email } = world.users[i]
        const { slug } = world.tenants[i]
        const context = await browser.newContext({
          baseURL: `http://localhost:${PREVIEW_PORT}`,
          viewport: { width: 1280, height: 800 },
        })
        const page = await context.newPage()
        await runFlow(
          {
            page,
            rttMs,
            worker: workerInfo.parallelIndex,
            where: 'worker setup',
            repeats: 1,
            warmUp: false,
          },
          'auth.signIn',
          {
            before: async () => {
              await context.clearCookies()
              await page.goto('/')
              await page.getByPlaceholder('Email').fill(email)
            },
            action: () => page.getByRole('button', { name: 'Sign in' }).click(),
            until: (s) =>
              location.pathname === `/t/${s}` &&
              document.querySelector('nav[aria-label="Main"]') !== null,
            arg: slug,
          },
        )
        const storageState = path.join(
          dir,
          `w${workerInfo.parallelIndex}-${'ab'[i]}.json`,
        )
        await context.storageState({ path: storageState })
        await context.close()
        return { email, password: '', slug, storageState }
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

  // eslint-disable-next-line no-empty-pattern -- Playwright needs the pattern
  baseURL: async ({}, use) => {
    await use(`http://localhost:${PREVIEW_PORT}`)
  },

  session: async ({ users }, use) => {
    await use(async (user = users.a) =>
      sessionState(await devLogin(user.email)),
    )
  },

  storageState: async ({ session }, use) => {
    await use(await session())
  },

  flow: async ({ rttMs }, use, testInfo) => {
    await use(async (page, name, step) => {
      // Every /api request the watched page makes, with its wall-clock
      // start and end, so each sample can be given its round trips.
      const calls: Array<{ url: string; start: number; end: number }> = []
      const onDone = (r: Request) => {
        if (!r.url().includes('/api/')) return
        const t = r.timing()
        calls.push({
          url: `${r.method()} ${new URL(r.url()).pathname}${new URL(r.url()).search}`,
          start: t.startTime,
          end: t.startTime + t.responseEnd,
        })
      }
      page.on('requestfinished', onDone)
      const cold = process.env.QC_RS_WARM !== '1'
      const record = await runFlow(
        {
          page,
          rttMs,
          worker: testInfo.parallelIndex,
          instance: 'rust',
          where: testInfo.titlePath.join(' › '),
        },
        name,
        {
          ...step,
          before: async () => {
            await step.before?.()
            // As Convex drops a query nobody subscribes to, so a sample
            // asks the server rather than drawing TanStack's cache.
            if (cold) await page.evaluate(dropInactiveQueries)
          },
        },
      )
      page.off('requestfinished', onDone)
      const perSample = record.detail.map((d, i) => {
        const t0 = d.at
        const t1 = t0 + record.samplesMs[i]
        return calls
          .filter((c) => c.start >= t0 - 5 && c.start <= t1)
          .map((c) => ({
            url: c.url,
            startMs: Math.round(c.start - t0),
            endMs: Math.round(c.end - t0),
          }))
      })
      mkdirSync(runDir(), { recursive: true })
      appendFileSync(
        path.join(runDir(), 'rust-calls.jsonl'),
        JSON.stringify({
          flow: name,
          cold,
          samplesMs: record.samplesMs,
          calls: perSample,
        }) + '\n',
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

/**
 * In the page: remove every cached query no component observes, from the
 * app's TanStack QueryClient, found through React's fiber tree (the app
 * doesn't expose it, and QC mustn't need it to). Serialised: no closures.
 */
function dropInactiveQueries() {
  interface Client {
    removeQueries: (f: {
      predicate: (q: { getObserversCount: () => number }) => boolean
    }) => void
    getQueryCache: () => unknown
  }
  interface Fiber {
    memoizedProps?: { client?: Client } | null
    child: Fiber | null
    sibling: Fiber | null
  }
  const root = document.getElementById('app')
  const key =
    root && Object.keys(root).find((k) => k.startsWith('__reactContainer$'))
  // No app on the page (a cold load's about:blank): nothing cached.
  if (!root || !key) return
  const stack: Array<Fiber> = [(root as unknown as Record<string, Fiber>)[key]]
  while (stack.length) {
    const f = stack.pop()!
    const client = f.memoizedProps?.client
    if (client && typeof client.getQueryCache === 'function') {
      client.removeQueries({ predicate: (q) => q.getObserversCount() === 0 })
      return
    }
    if (f.child) stack.push(f.child)
    if (f.sibling) stack.push(f.sibling)
  }
  throw new Error('dropInactiveQueries: no QueryClientProvider')
}

export { expect }
