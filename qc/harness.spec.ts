import { statSync } from 'node:fs'
import { expect, test } from './fixtures'
import {
  OverBudgetError,
  RECORD,
  REPEATS,
  RTT_CEILING_MS,
  assertFlow,
  runFlow,
  runId,
} from './timing'
import type { Page } from '@playwright/test'
import type { FlowStep } from './timing'

// The harness's self-test (factory/plans/qc-suite.sv): the same real flow
// under an impossible 1 ms budget must fail, and under a generous one must
// pass, so the timing path is live end to end (seed, UI sign-in, RTT,
// in-page measurement, the pass rule). Two more prove the spike rule: a
// sample forced over budget in the first set is re-measured and passes,
// and one forced into both sets fails. The impossible budget also proves
// a failed flow is traced (one extra sample, outside the judged set); the
// passing ones prove nothing else is.

function openContacts(page: Page, slug: string): FlowStep<string> {
  // The header's link: the group home also has a "Find a contact" card.
  const link = page
    .getByRole('navigation', { name: 'Main' })
    .locator(`a[href="/t/${slug}/contacts"]`)
  return {
    before: async () => {
      await page.goto('/')
      await expect(link).toBeVisible()
    },
    action: () => link.click(),
    until: (name) => document.body.innerText.includes(name),
    arg: `Alpha-${runId()}`,
  }
}

interface Held {
  __qcHoldUntil?: number
}

/**
 * openContacts, with the timed calls numbered in `forced` held to at least
 * 1.5 s: `until` waits for a deadline set just before the click. The
 * `before` reloads the page, which clears it for the next call.
 */
function spiked(
  page: Page,
  slug: string,
  forced: Array<number>,
): FlowStep<string> {
  const base = openContacts(page, slug)
  let call = 0
  return {
    ...base,
    action: async () => {
      if (forced.includes(++call)) {
        await page.evaluate(() => {
          ;(window as unknown as Held).__qcHoldUntil = performance.now() + 1500
        })
      }
      await base.action()
    },
    until: (name) =>
      document.body.innerText.includes(name) &&
      performance.now() >= ((window as unknown as Held).__qcHoldUntil ?? 0),
  }
}

test.describe('harness', () => {
  test('an impossible budget fails', async ({ page, flow, users, rttMs }) => {
    test.skip(RECORD, 'record mode never asserts')
    test.skip(rttMs > RTT_CEILING_MS, 'RTT over the ceiling: not judged')
    await expect(
      flow(page, 'harness.impossible', openContacts(page, users.a.slug)),
    ).rejects.toThrow(OverBudgetError)
    // A failing flow leaves the trace of one extra, unjudged sample.
    const attached = test.info().attachments.find((a) => a.name === 'trace')
    expect(attached?.path).toBeDefined()
    expect(statSync(attached!.path!).size).toBeGreaterThan(0)
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
    expect(record.trace).toBeUndefined()
    // Real samples: a client navigation plus a query takes milliseconds.
    expect(Math.min(...record.samplesMs)).toBeGreaterThan(1)
  })

  test.describe('spikes', () => {
    test.beforeEach(({ rttMs }) => {
      test.skip(RECORD, 'record mode never re-measures')
      test.skip(rttMs > RTT_CEILING_MS, 'RTT over the ceiling: not judged')
    })

    // runFlow directly, without a warm-up, so the timed calls are numbered
    // from 1: the first set is 1..K, the re-measure K+1..2K.
    const ctx = (page: Page, rttMs: number) => ({
      page,
      rttMs,
      worker: test.info().parallelIndex,
      where: test.info().titlePath.join(' › '),
      warmUp: false,
    })

    test('one over in the first set: re-measured, passes', async ({
      page,
      users,
      rttMs,
    }) => {
      const record = await runFlow(
        ctx(page, rttMs),
        'harness.spike',
        spiked(page, users.a.slug, [1]),
      )
      expect(record.firstSamplesMs?.[0]).toBeGreaterThanOrEqual(1000)
      expect(record.samplesMs).toHaveLength(REPEATS)
      expect(Math.max(...record.samplesMs)).toBeLessThan(1000)
      expect(record.pass).toBe(true)
      expect(record.trace).toBeUndefined()
      expect(() => assertFlow(record)).not.toThrow()
    })

    test('over in both sets: fails', async ({ page, users, rttMs }) => {
      const record = await runFlow(
        ctx(page, rttMs),
        'harness.spike',
        spiked(page, users.a.slug, [1, REPEATS + 1]),
      )
      expect(record.firstSamplesMs?.[0]).toBeGreaterThanOrEqual(1000)
      expect(record.samplesMs[0]).toBeGreaterThanOrEqual(1000)
      expect(record.pass).toBe(false)
      expect(() => assertFlow(record)).toThrow(OverBudgetError)
    })
  })
})
