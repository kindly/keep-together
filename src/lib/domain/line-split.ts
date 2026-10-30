/**
 * Splitting a statement line into gifts (bank transfers g1q6): the parts
 * and any remainder (not a donation, with a note) must add up to the line
 * exactly. Shown live as staff type; the server's `422 invalid` on the
 * same sum is the backstop. Money is `bigint` pence (rule 7).
 */

/** What is left of the line once the parts are taken: under 0 is over. */
export function remainderOf(
  line: bigint,
  parts: ReadonlyArray<bigint | null>,
): bigint {
  return parts.reduce<bigint>((left, p) => left - (p ?? 0n), line)
}

/**
 * What keeps a split from saving, in words: a part with no donor or no
 * amount (or £0), parts over the line, a remainder with no note.
 */
export function splitProblems(
  line: bigint,
  parts: ReadonlyArray<{ amount: bigint | null; donor: boolean }>,
  note: string,
): Array<string> {
  const out: Array<string> = []
  if (parts.length === 0) out.push('Add at least one gift')
  parts.forEach((p, i) => {
    const n = parts.length > 1 ? ` ${i + 1}` : ''
    if (!p.donor) out.push(`Gift${n}: choose the donor`)
    if (p.amount === null || p.amount <= 0n)
      out.push(`Gift${n}: an amount over £0`)
  })
  const left = remainderOf(
    line,
    parts.map((p) => p.amount),
  )
  if (left < 0n) out.push('The gifts add up to more than the line')
  if (left > 0n && note.trim() === '')
    out.push('Say what the rest of the line is (it isn’t a donation)')
  return out
}

/**
 * A bank's payer name ("J BLOGGS", "SMITH P & R") as a new person's
 * first and last name to start from: the last word is the surname, the
 * rest the first name, each word capitalised. Staff correct it.
 */
export function payerAsPerson(payer: string): {
  firstName: string
  lastName: string
} {
  const words = payer
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (/^[A-Z]{2,}$/.test(w) ? w[0] + w.slice(1).toLowerCase() : w))
  if (words.length <= 1) return { firstName: '', lastName: words[0] ?? '' }
  return {
    firstName: words.slice(0, -1).join(' '),
    lastName: words[words.length - 1],
  }
}
