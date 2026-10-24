import { devLogin, expect, test } from '../fixtures'
import type { Instance } from '../fixtures'

// Tenancy against id and slug manipulation (rust spike step 3, folded in
// from qc-rs/): signed in as A, B's ids under A's slug, B's slug under
// A's session, and slugs and paths built to climb out of A's org file.
// Every route answers 403 or 404 with the same body, and nothing of B's
// shows or changes. qc/flows/isolation.spec.ts covers what the pages
// show; this covers what the API answers to whatever it is sent.

function route(...ids: Array<string>) {
  test
    .info()
    .annotations.push(
      ...ids.map((description) => ({ type: 'route', description })),
    )
}

/** A request to `inst`'s api with a session cookie, any answer. */
function api(inst: Instance) {
  return async (
    token: string,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: any }> => {
    const res = await fetch(`${inst.api}${path}`, {
      method,
      headers: {
        cookie: `kt_session=${token}`,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    })
    const text = await res.text()
    let json: any = null
    try {
      json = JSON.parse(text)
    } catch {
      json = text
    }
    return { status: res.status, json }
  }
}

test.describe('tenancy against id and slug manipulation', () => {
  test('the UI: B ids in A slug, B slug as A', async ({
    page,
    users,
    world,
  }) => {
    route('/t/$slug/contacts/', '/t/$slug/contacts/$contactId')
    const [a, b] = world.tenants
    await page.goto(`/t/${b.slug}/contacts`)
    await expect(page.locator('main')).not.toContainText(/Bravo|Ada B/)
    await expect(page.locator(`a[href*="${b.contactIds[0]}"]`)).toHaveCount(0)
    for (const id of b.contactIds) {
      await page.goto(`/t/${users.a.slug}/contacts/${id}`)
      await expect(page.getByText('No such contact.')).toBeVisible()
      await page.goto(`/t/${b.slug}/contacts/${id}`)
      await expect(page.getByRole('heading', { name: 'Details' })).toHaveCount(
        0,
      )
    }
    await page.goto(`/t/${a.slug}/contacts/${a.contactIds[0]}`)
    await expect(page.getByRole('heading', { name: 'Details' })).toBeVisible()
  })

  test('the API: every route, with ids, slugs and paths tampered', async ({
    instance,
    users,
    world,
  }) => {
    const [a, b] = world.tenants
    const tokA = await devLogin(instance, users.a.email)
    const tokB = await devLogin(instance, users.b.email)
    const apiAs = api(instance)
    const bId = b.contactIds[0]
    const aId = a.contactIds[0]
    const viewB = await apiAs(tokB, 'GET', `/api/t/${b.slug}/contacts/${bId}`)
    expect(viewB.status).toBe(200)
    const histB = await apiAs(
      tokB,
      'GET',
      `/api/t/${b.slug}/contacts/${bId}/history`,
    )
    const bRevision = histB.json.revisions[0].id as number
    const viewA = await apiAs(tokA, 'GET', `/api/t/${a.slug}/contacts/${aId}`)
    const fieldsA = await apiAs(tokA, 'GET', `/api/t/${a.slug}/fields`)
    const field = fieldsA.json[0] ?? fieldsA.json.fields?.[0]

    // A's own data is fine.
    expect(viewA.status).toBe(200)

    // A's cookie on B's slug: every route, 403, the same body.
    const onB: Array<['GET' | 'POST', string, unknown?]> = [
      ['GET', ''],
      ['GET', '/boot'],
      // Refused before any stream starts: a 403 with the usual body.
      ['GET', '/events'],
      ['GET', '/events?after=0'],
      ['GET', '/contacts'],
      ['GET', '/contacts/search?q=ada'],
      ['GET', `/contacts/${bId}`],
      ['GET', `/contacts/${bId}/history`],
      ['POST', '/contacts', { kind: 'individual', lastName: 'x' }],
      ['POST', `/contacts/${bId}/save`, { details: viewB.json.details }],
      ['POST', `/contacts/${bId}/archive`, { expected: 0, archived: true }],
      ['POST', `/contacts/${bId}/restore`, { revisionId: bRevision }],
      ['GET', '/fields'],
      ['POST', '/fields', { label: 'x' }],
      ['POST', '/fields/options', { label: 'x' }],
    ]
    for (const [m, r, body] of onB) {
      const res = await apiAs(tokA, m, `/api/t/${b.slug}${r}`, body)
      expect([m, r, res.status, res.json]).toEqual([
        m,
        r,
        403,
        { kind: 'forbidden' },
      ])
    }

    // B's contact id under A's own slug: not found, nothing written.
    // History of an id A's file doesn't hold: 404 since F1 (L4); an empty
    // page (200) before it, which still shows nothing of B's.
    const hist = await apiAs(
      tokA,
      'GET',
      `/api/t/${a.slug}/contacts/${bId}/history`,
    )
    expect([404, 200]).toContain(hist.status)
    if (hist.status === 200) expect(hist.json.revisions).toEqual([])
    for (const [m, r, body] of [
      ['GET', `/contacts/${bId}`],
      [
        'POST',
        `/contacts/${bId}/save`,
        { details: { ...viewB.json.details, expected: 1, nickname: 'pwned' } },
      ],
      ['POST', `/contacts/${bId}/archive`, { expected: 1, archived: true }],
      ['POST', `/contacts/${bId}/restore`, { revisionId: bRevision }],
    ] as Array<['GET' | 'POST', string, unknown?]>) {
      const res = await apiAs(tokA, m, `/api/t/${a.slug}${r}`, body)
      expect([m, r, res.status]).toEqual([m, r, 404])
    }
    const stillB = await apiAs(tokB, 'GET', `/api/t/${b.slug}/contacts/${bId}`)
    expect(stillB.json.details).toEqual(viewB.json.details)
    expect(stillB.json.archived).toBe(viewB.json.archived)

    // A revision id from another of A's contacts can't restore onto this one.
    const histA2 = await apiAs(
      tokA,
      'GET',
      `/api/t/${a.slug}/contacts/${a.contactIds[1]}/history`,
    )
    const other = await apiAs(
      tokA,
      'POST',
      `/api/t/${a.slug}/contacts/${aId}/restore`,
      { revisionId: histA2.json.revisions[0].id },
    )
    expect(other.status).toBe(404)

    // B's field and option ids in A's list filter: refused or empty, never B's rows.
    if (field) {
      const res = await apiAs(
        tokA,
        'GET',
        `/api/t/${a.slug}/contacts?fields=${encodeURIComponent(`${field.id}:none`)}`,
      )
      expect(res.status).toBe(200)
      expect(
        res.json.rows.some((r: { id: string }) => b.contactIds.includes(r.id)),
      ).toBe(false)
    }

    // Slug tampering: case, encoding, traversal, B's file name. Never 2xx,
    // never B's data.
    const tenantFiles = ['..', '../orgs', '%2e%2e', 'orgs', 'platform']
    const slugs = [
      b.slug.toUpperCase(),
      `${b.slug}%00`,
      `${b.slug}%2F..%2F${b.slug}`,
      `${a.slug}%2F..%2F${b.slug}`,
      `${a.slug}/../${b.slug}`,
      encodeURIComponent(`../${b.slug}`),
      ...tenantFiles,
      ' ' + b.slug,
    ]
    for (const s of slugs) {
      const res = await apiAs(tokA, 'GET', `/api/t/${s}/contacts`)
      const body = JSON.stringify(res.json)
      expect([s, res.status < 300]).toEqual([s, false])
      expect(body).not.toContain(bId)
    }
    // A's slug with a path that climbs out of it, to B's id.
    for (const r of [
      `/api/t/${a.slug}/contacts/..%2F..%2F${b.slug}%2Fcontacts%2F${bId}`,
      `/api/t/${a.slug}/contacts/${bId}%00`,
      `/api/t/${a.slug}/contacts/${bId.toUpperCase()}`,
    ]) {
      const res = await apiAs(tokA, 'GET', r)
      expect([r, res.status < 300]).toEqual([r, false])
    }

    // No cookie, a forged cookie, B's cookie on A's slug.
    expect(
      (await apiAs('nope', 'GET', `/api/t/${a.slug}/contacts`)).status,
    ).toBe(401)
    expect(
      (await apiAs(tokB, 'GET', `/api/t/${a.slug}/contacts/${aId}`)).status,
    ).toBe(403)

    // Search can't cross: B's own Ada name, searched from A.
    const bName = viewB.json.details.lastName as string
    const s = await apiAs(
      tokA,
      'GET',
      `/api/t/${a.slug}/contacts/search?q=${encodeURIComponent(bName)}`,
    )
    expect(
      s.json.rows.some((r: { id: string }) => b.contactIds.includes(r.id)),
    ).toBe(false)
  })
})
