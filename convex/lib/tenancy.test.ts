import { describe, expect, test } from 'vitest'
import { api } from '../_generated/api'
import { setup } from '../../test/fixture'
import { scopeReader } from './tenancy'

const contact = (lastName: string) => ({
  kind: 'individual' as const,
  title: '',
  firstName: '',
  lastName,
  nickname: '',
  name: '',
  isDeceased: false,
  externalIdentifier: '',
})

describe('scoped db queries', () => {
  test('take(n ≤ 0) returns nothing; other reads are unchanged', async () => {
    const { t, a, b } = await setup()
    for (const name of ['Ames', 'Byrne', 'Cole']) {
      await a.as.mutation(api.contacts.mutations.create, {
        tenantId: a.tenantId,
        ...contact(name),
      })
    }
    await b.as.mutation(api.contacts.mutations.create, {
      tenantId: b.tenantId,
      ...contact('Other'),
    })
    const got = await t.run(async (ctx) => {
      const db = scopeReader(ctx, a.tenantId)
      const sorted = () => db.query('contacts').withIndex('by_tenant_sort')
      const iterated: Array<string> = []
      for await (const c of sorted().order('desc')) iterated.push(c.lastName)
      return {
        zero: await sorted().take(0),
        negative: await sorted().take(-1),
        orderedZero: await sorted().order('desc').take(0),
        two: (await sorted().take(2)).map((c) => c.lastName),
        orderedTwo: (await sorted().order('desc').take(2)).map(
          (c) => c.lastName,
        ),
        first: (await sorted().first())?.lastName,
        all: (await sorted().collect()).map((c) => c.lastName),
        iterated,
      }
    })
    expect(got).toEqual({
      zero: [],
      negative: [],
      orderedZero: [],
      two: ['Ames', 'Byrne'],
      orderedTwo: ['Cole', 'Byrne'],
      first: 'Ames',
      all: ['Ames', 'Byrne', 'Cole'],
      iterated: ['Cole', 'Byrne', 'Ames'],
    })
  })
})
