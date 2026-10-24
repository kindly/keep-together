/**
 * Browser error reporting (plan migration-rust.sv, F2): Sentry's CDN
 * bundle, loaded only when the build sets `VITE_SENTRY_DSN`, pinned to one
 * version with subresource integrity, so no npm dependency and nothing at
 * all in dev or tests. index.html loads this module beside the app, so it
 * starts before the app does.
 *
 * Nothing personal leaves the browser: no user, cookies, headers, request
 * bodies or query strings, URLs without their query, email-shaped words
 * redacted, and breadcrumbs keep only their category and path.
 */

const BUNDLE = 'https://browser.sentry-cdn.com/11.5.0/bundle.min.js'
const INTEGRITY =
  'sha384-hz6acjqDJyH+W4e5eBe7yycs+gVPltrjQnZ05EYDSYGV2fVFkqg3bR2tFiOq8DjQ'

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

interface SentryGlobal {
  init: (options: Record<string, unknown>) => void
}

const EMAIL = /[^\s"'<>,()@]+@[^\s"'<>,()@]+/g

export function redactEmails(text: string): string {
  return text.replace(EMAIL, '[email]')
}

function withoutQuery(url: string): string {
  const cut = url.search(/[?#]/)
  return cut === -1 ? url : url.slice(0, cut)
}

export function scrubEvent(event: SentryEvent): SentryEvent {
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
  return event
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

function start(dsn: string) {
  const script = document.createElement('script')
  script.src = BUNDLE
  script.integrity = INTEGRITY
  script.crossOrigin = 'anonymous'
  script.onload = () => {
    const sentry = (window as unknown as { Sentry?: SentryGlobal }).Sentry
    sentry?.init({
      dsn,
      environment: environment(window.location.hostname),
      release: (import.meta.env.VITE_RELEASE as string | undefined) || undefined,
      sendDefaultPii: false,
      beforeSend: scrubEvent,
      beforeBreadcrumb: (crumb: SentryBreadcrumb) =>
        crumb.category === 'console' ? null : scrubBreadcrumb(crumb),
    })
  }
  document.head.appendChild(script)
}

const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined
if (dsn && typeof document !== 'undefined') start(dsn)
