/**
 * Browser error reporting (plan migration-rust.sv, F2): `@sentry/browser`,
 * imported only when the build sets `VITE_SENTRY_DSN`, so it's a separate
 * chunk that dev, tests and DSN-less builds never load, and nothing talks
 * to Sentry until there's an error to send (to the EU ingest the DSN
 * names). index.html loads this module beside the app, so it starts
 * before the app does.
 *
 * Nothing personal leaves the browser: no user, cookies, headers, request
 * bodies or query strings, URLs without their query, email-shaped words
 * redacted, and breadcrumbs keep only their category and path.
 */

/** The parts of a Sentry event this file touches. */
export interface SentryEvent {
  user?: unknown
  message?: string
  request?: {
    url?: string
    cookies?: unknown
    headers?: unknown
    data?: unknown
    query_string?: unknown
  }
  exception?: { values?: Array<{ value?: string }> }
  breadcrumbs?: Array<SentryBreadcrumb>
  extra?: unknown
}

export interface SentryBreadcrumb {
  category?: string
  message?: string
  data?: Record<string, unknown>
}

const EMAIL = /[^\s"'<>,()@]+@[^\s"'<>,()@]+/g

export function redactEmails(text: string): string {
  return text.replace(EMAIL, '[email]')
}

function withoutQuery(url: string): string {
  const cut = url.search(/[?#]/)
  return cut === -1 ? url : url.slice(0, cut)
}

/** Scrubs `event` in place and returns it, typed as it came in. */
export function scrubEvent<TEvent extends SentryEvent>(input: TEvent): TEvent {
  const event: SentryEvent = input
  delete event.user
  delete event.extra
  if (event.request) {
    const url = event.request.url
    event.request = url ? { url: withoutQuery(url) } : {}
  }
  if (event.message) event.message = redactEmails(event.message)
  for (const ex of event.exception?.values ?? []) {
    if (ex.value) ex.value = redactEmails(ex.value)
  }
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map((b) => scrubBreadcrumb(b))
  }
  return input
}

/** Category plus the request path (fetch, navigation), nothing else. */
export function scrubBreadcrumb(crumb: SentryBreadcrumb): SentryBreadcrumb {
  const out: SentryBreadcrumb = {}
  if (crumb.category) out.category = crumb.category
  const url = crumb.data?.url ?? crumb.data?.to
  if (typeof url === 'string') out.data = { url: withoutQuery(url) }
  return out
}

/** `staging` on staging.*, `prod` on app.*, else the host name. */
export function environment(hostname: string): string {
  if (hostname.startsWith('staging.')) return 'staging'
  if (hostname.startsWith('app.')) return 'prod'
  return hostname
}

async function start(dsn: string) {
  const Sentry = await import('@sentry/browser')
  Sentry.init({
    dsn,
    environment: environment(window.location.hostname),
    release: (import.meta.env.VITE_RELEASE as string | undefined) || undefined,
    // v11's defaults collect user info, cookies, headers, bodies and
    // query strings: all off. beforeSend scrubs what's left.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
    },
    beforeSend: (event) => scrubEvent(event),
    beforeBreadcrumb: (crumb) =>
      crumb.category === 'console' ? null : scrubBreadcrumb(crumb),
  })
}

const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined
if (dsn && typeof document !== 'undefined') {
  start(dsn).catch((err: unknown) => console.error('sentry failed to start', err))
}
