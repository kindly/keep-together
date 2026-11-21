// Which upcoming payment a QC flow starts a regular gift's change on, so
// the change stays `scheduled` for the flow to edit, code or withdraw.
//
// The api sends a change to GoCardless a fortnight before it takes
// effect, and straight after it is saved if it is already that close
// (ADR 0026 decision 5; `giving::terms::SEND_AHEAD_DAYS`). From then it
// is history: no "Withdraw change", and the next change must start after
// it. A payment is `changeable` from eight days off, so on some days of
// the month the first changeable payment is one whose change is sent at
// once: for a gift on the 1st, from the 17th to the 23rd of the month
// before (2026-11-19 broke regular-terms.spec.ts this way).

/** `giving::terms::SEND_AHEAD_DAYS`: keep in step with it. */
export const SEND_AHEAD_DAYS = 14

/** `YYYY-MM-DD` plus `n` days. */
function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/**
 * The first changeable payment a change is held for, not sent at once:
 * more than [`SEND_AHEAD_DAYS`] and a day after `today` (`YYYY-MM-DD`;
 * the day more covers a run over midnight and the api's UTC date).
 */
export function heldPayment(
  upcoming: ReadonlyArray<{ chargeDate: string; changeable: boolean }>,
  today: string,
): string {
  const horizon = addDays(today, SEND_AHEAD_DAYS + 1)
  const held = upcoming.find((u) => u.changeable && u.chargeDate > horizon)
  if (!held)
    throw new Error(
      `no changeable payment after ${horizon} in ${upcoming.map((u) => u.chargeDate).join(', ')}`,
    )
  return held.chargeDate
}

/** Today in UTC, as the api dates a change. */
export function utcToday(): string {
  return new Date().toISOString().slice(0, 10)
}
