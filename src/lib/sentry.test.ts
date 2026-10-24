import { describe, expect, it } from 'vitest'
import { environment, redactEmails, scrubBreadcrumb, scrubEvent } from './sentry'

describe('sentry scrubbing', () => {
  it('redacts email-shaped words', () => {
    expect(redactEmails('no user "ada@example.com" (b@x.org), @handle')).toBe(
      'no user "[email]" ([email]), @handle',
    )
  })

  it('drops users, bodies, cookies, headers and query strings', () => {
    const out = scrubEvent({
      user: { email: 'ada@example.com' },
      extra: { form: { email: 'ada@example.com' } },
      request: {
        url: 'https://staging.keep-together.org.uk/t/a/contacts?q=ada',
        cookies: 'kt_session=secret',
        headers: { cookie: 'kt_session=secret' },
        data: '{"email":"ada@example.com"}',
        query_string: 'q=ada',
      },
      message: 'save failed for ada@example.com',
      exception: { values: [{ value: 'duplicate b@example.org' }] },
      breadcrumbs: [
        {
          category: 'fetch',
          message: 'GET /api/t/a/contacts/search?q=ada@example.com',
          data: { url: '/api/t/a/contacts/search?q=ada', method: 'GET' },
        },
      ],
    })
    expect(out).toEqual({
      request: { url: 'https://staging.keep-together.org.uk/t/a/contacts' },
      message: 'save failed for [email]',
      exception: { values: [{ value: 'duplicate [email]' }] },
      breadcrumbs: [{ category: 'fetch', data: { url: '/api/t/a/contacts/search' } }],
    })
  })

  it('keeps only the path of a navigation breadcrumb', () => {
    expect(
      scrubBreadcrumb({ category: 'navigation', data: { from: '/', to: '/t/a?x=1#y' } }),
    ).toEqual({ category: 'navigation', data: { url: '/t/a' } })
  })

  it('names the environment from the host', () => {
    expect(environment('staging.keep-together.org.uk')).toBe('staging')
    expect(environment('app.keep-together.org.uk')).toBe('prod')
    expect(environment('localhost')).toBe('localhost')
  })
})
