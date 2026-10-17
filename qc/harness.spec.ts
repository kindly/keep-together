import { expect, test } from './fixtures'
import { OverBudgetError, RECORD, RTT_CEILING_MS, runId } from './timing'
import type { Page } from '@playwright/test'
import type { FlowStep } from './timing'

// The harness's self-test (factory/plans/qc-suite.sv): the same real flow
// under an impossible 1 ms budget must fail, and under a generous one must
// pass, so the timing path is live end to end (seed, UI sign-in, RTT,
// in-page measurement, the pass rule).

function openContacts(page: Page, slug: string): FlowStep<string> {
  return {
    before: async () => {
      await page.goto('/')
      await expect(page.locator(`a[href="/t/${slug}/contacts"]`)).toBeVisible()
    },
    action: () => page.locator(`a[href="/t/${slug}/contacts"]`).click(),
    until: (name) => document.body.innerText.includes(name),
    arg: `Alpha-${runId()}`,
  }
}

test.describe('harness', () => {
  test('an impossible budget fails', async ({ page, flow, users, rttMs }) => {
    test.skip(RECORD, 'record mode never asserts')
    test.skip(rttMs > RTT_CEILING_MS, 'RTT over the ceiling: not judged')
    await expect(
      flow(page, 'harness.impossible', openContacts(page, users.a.slug)),
    ).rejects.toThrow(OverBudgetError)
  })

  // Also runs in record mode and over the RTT ceiling: it measures there,
  // and must come back unjudged.
  test('a generous budget passes', async ({ page, flow, users, rttMs }) => {
    const record = await flow(
      page,
      'harness.generous',
      openContacts(page, users.a.slug),
    )
    const judged = !RECORD && rttMs <= RTT_CEILING_MS
    expect(record.pass).toBe(judged ? true : null)
    // Real samples: a client navigation plus a query takes milliseconds.
    expect(Math.min(...record.samplesMs)).toBeGreaterThan(1)
  })
})
