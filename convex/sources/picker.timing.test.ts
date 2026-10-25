import { expect, test } from 'vitest'
import { api } from '../_generated/api'
import type { Id } from '../_generated/dataModel'
import { setup } from '../../test/fixture'
import { resolveParts } from './code'
import { PICKER_LIMIT, pickerResult } from './queries'
import { SOURCE_CODE_LIMIT } from './rules'

// Reviewer L2 (source codes step 2): the picker reads every part and joins
// them in one pass, so time it with a tenant at SOURCE_CODE_LIMIT.
//
// What is timed is the handler's own work over rows already read
// (`resolveParts` + `pickerResult`: the join, the visibility walk, the
// filter and the sort). convex-test's in-memory reads of 2000 rows take
// 30–90 ms here and say nothing about a deployment's, so they are left
// out; the query runs end to end once, for its answer only. Measured alone
// this pass takes ~5 ms; the budget leaves room for `pnpm check` running
// every test file at once, and still breaks on a quadratic slip. The best
// of 5 is judged, not the worst: a quadratic slip makes every sample slow,
// while a busy CI runner stalls only some (the worst hit 52 and 68 ms on
// GitHub's runners, 2026-10-24, blocking deploys).
const BUDGET_MS = 50

const TODAY = '2026-10-19'

test(`the picker at ${SOURCE_CODE_LIMIT} parts: its own work stays under ${BUDGET_MS} ms`, async () => {
  const f = await setup()
  const tenantId = f.a.tenantId
  // Rows inserted directly: through the contract, each insert re-counts
  // the tenant's parts, which is quadratic at this size. Dates and archived
  // parts so every branch of the order and the visibility walk runs.
  const rows = await f.t.run(async (ctx) => {
    let total = (
      await ctx.db
        .query('sourceCodes')
        .withIndex('by_tenant_parent', (q) => q.eq('tenantId', tenantId))
        .collect()
    ).length
    const part = (
      level: 'category' | 'detail' | 'version',
      name: string,
      parentId: Id<'sourceCodes'> | undefined,
      extra: { isActive?: boolean; startDate?: string; endDate?: string } = {},
    ) => {
      total++
      return ctx.db.insert('sourceCodes', {
        tenantId,
        level,
        parentId,
        name,
        nameNormalized: name.toLowerCase(),
        isActive: extra.isActive ?? true,
        startDate: extra.startDate,
        endDate: extra.endDate,
        used: false,
        saveVersion: 0,
      })
    }
    for (let c = 0; total < SOURCE_CODE_LIMIT; c++) {
      const category = await part('category', `Cat${c}`, undefined, {
        isActive: c % 7 !== 6,
      })
      for (let d = 0; d < 8 && total < SOURCE_CODE_LIMIT; d++) {
        const detail = await part('detail', `Appeal${c}x${d}`, category, {
          isActive: d !== 7,
          endDate: d % 3 === 0 ? '2020-12-31' : undefined,
        })
        for (let v = 1; v <= 12 && total < SOURCE_CODE_LIMIT; v++) {
          await part('version', String(v).padStart(3, '0'), detail, {
            startDate: v % 4 === 0 ? '2099-01-01' : undefined,
          })
        }
      }
    }
    return ctx.db
      .query('sourceCodes')
      .withIndex('by_tenant_parent', (q) => q.eq('tenantId', tenantId))
      .collect()
  })
  expect(rows).toHaveLength(SOURCE_CODE_LIMIT)

  const timed = (search: string) => {
    const run = () => pickerResult(resolveParts(rows), TODAY, search)
    const result = run() // warm-up
    const samples = []
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now()
      run()
      samples.push(performance.now() - t0)
    }
    return { best: Math.min(...samples), result }
  }

  const all = timed('')
  expect(all.result.codes).toHaveLength(PICKER_LIMIT)
  expect(all.result.truncated).toBe(true)
  expect(all.result.codes[0].status).toBe('current')
  // The query answers the same as the pass it wraps.
  expect(
    await f.a.as.query(api.sources.queries.picker, { tenantId, today: TODAY }),
  ).toEqual(all.result)

  const narrow = timed('appeal3x1-0')
  expect(narrow.result.codes.map((c) => c.code)).toEqual(
    expect.arrayContaining(['Cat3-Appeal3x1-001', 'Cat3-Appeal3x1-009']),
  )
  const none = timed('no such code')
  expect(none.result.codes).toEqual([])

  console.info(
    `picker pass at ${SOURCE_CODE_LIMIT} parts, best of 5: all ${all.best.toFixed(1)} ms, narrow ${narrow.best.toFixed(1)} ms, none ${none.best.toFixed(1)} ms`,
  )
  for (const run of [all, narrow, none]) {
    expect(run.best).toBeLessThan(BUDGET_MS)
  }
})
