import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { expect, test } from './fixtures'
import {
  HeldResultError,
  LEGS,
  OverBudgetError,
  RECORD,
  REPEATS,
  RTT_CEILING_MS,
  assertFlow,
  runDir,
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
// passing ones prove nothing else is. The held-result guard is proved
// both ways: the generous flow, a real round trip, passes it, and a
// sample the page answers alone fails it.

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
    server: true,
  }
}

interface Clicked {
  __qcClicked?: boolean
}

/** A click the page answers by itself: no request, nothing from the server. */
function localClick(page: Page): FlowStep {
  return {
    before: async () => {
      await page.evaluate(() => {
        const w = window as unknown as Clicked
        w.__qcClicked = false
        document.addEventListener(
          'mousedown',
          () => {
            w.__qcClicked = true
          },
          { once: true },
        )
      })
    },
    action: () => page.mouse.click(5, 5),
    until: () => (window as unknown as Clicked).__qcClicked === true,
    server: true,
  }
}

/** This worker's written records for `flow`. */
function written(flow: string) {
  return readdirSync(runDir())
    .filter((f) => f.startsWith('pid-'))
    .flatMap((f) =>
      readFileSync(path.join(runDir(), f), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { flow: string; where: string }),
    )
    .filter(
      (r) => r.flow === flow && r.where === test.info().titlePath.join(' › '),
    )
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
    // Every sample got its answer from the server (the guard passed).
    if (LEGS) expect(record.detail.every((d) => d.answered)).toBe(true)
    // Real samples: a client navigation plus a query takes milliseconds.
    expect(Math.min(...record.samplesMs)).toBeGreaterThan(1)
  })

  test('a held result fails the guard', async ({ page, users }) => {
    test.skip(!LEGS, 'no WebSocket tap: the guard is off')
    await page.goto(`/t/${users.a.slug}`)
    await expect(
      runFlow(
        {
          page,
          rttMs: 0,
          worker: test.info().parallelIndex,
          where: test.info().titlePath.join(' › '),
          warmUp: false,
        },
        'harness.generous',
        localClick(page),
      ),
    ).rejects.toThrow(HeldResultError)
  })

  test("a hold's wait is outside the timed window", async ({ page, users }) => {
    // A hold on an instance no other worker uses, by a live process that
    // isn't this one (the runner). It's taken at the end of `before`, so
    // the sample meets it, and released HOLD_MS later.
    const HOLD_MS = 1000
    const instance = `harness-w${test.info().parallelIndex}`
    const dir = path.join(runDir(), 'quiet')
    mkdirSync(dir, { recursive: true })
    const hold = path.join(dir, `hold-${instance}.json`)
    const step = openContacts(page, users.a.slug)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const record = await runFlow(
        {
          page,
          rttMs: 0,
          worker: test.info().parallelIndex,
          instance,
          where: test.info().titlePath.join(' › '),
          repeats: 1,
          warmUp: false,
        },
        'harness.generous',
        {
          ...step,
          before: async () => {
            await step.before!()
            writeFileSync(
              hold,
              JSON.stringify({
                pid: process.ppid,
                who: 'harness',
                at: Date.now(),
              }),
            )
            timer = setTimeout(() => rmSync(hold, { force: true }), HOLD_MS)
          },
        },
      )
      const [d] = record.detail
      // Most of the hold is waited out (the settle after `before` takes
      // a few frames of it)...
      expect(d.quietWaitMs).toBeGreaterThanOrEqual(HOLD_MS / 2)
      // ...and none of it is in the sample: the click to the list.
      expect(record.samplesMs[0]).toBeLessThan(HOLD_MS / 2)
      expect(d.endMs).toBe(record.samplesMs[0])
    } finally {
      clearTimeout(timer)
      rmSync(hold, { force: true })
    }
  })

  test('a failing traced sample keeps the verdict', async ({
    page,
    users,
    rttMs,
  }) => {
    test.skip(RECORD, 'record mode never asserts')
    test.skip(rttMs > RTT_CEILING_MS, 'RTT over the ceiling: not judged')
    // The extra traced sample is call 2K + 1 (no warm-up, and every
    // sample fails 1 ms, so the set is re-measured): its action throws.
    const base = openContacts(page, users.a.slug)
    let call = 0
    const record = await runFlow(
      {
        page,
        rttMs,
        worker: test.info().parallelIndex,
        where: test.info().titlePath.join(' › '),
        warmUp: false,
        tracePath: test.info().outputPath('trace-throws.zip'),
      },
      'harness.impossible',
      {
        ...base,
        action: async () => {
          if (++call > 2 * REPEATS) throw new Error('traced sample broke')
          await base.action()
        },
      },
    )
    expect(call).toBe(2 * REPEATS + 1)
    expect(record.pass).toBe(false)
    expect(record.traceError).toMatch(/traced sample broke/)
    expect(statSync(record.trace!).size).toBeGreaterThan(0)
    expect(() => assertFlow(record)).toThrow(OverBudgetError)
    // Written once, with its verdict, before the trace was taken.
    const [w, ...more] = written('harness.impossible')
    expect(more).toHaveLength(0)
    expect(w).toMatchObject({ pass: false, samplesMs: record.samplesMs })
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
