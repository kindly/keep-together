/**
 * Splitting a statement line into gifts (bank transfers g1q6): the parts
 * and any remainder (not a donation, with a note) must add up to the line
 * exactly. Shown live as staff type, each problem beside its field; the
 * server's `422 invalid` on the same sum is the backstop. Money is
 * `bigint` pence (rule 7).
 */

/** What is left of the line once the parts are taken: under 0 is over. */
export function remainderOf(
  line: bigint,
  parts: ReadonlyArray<bigint | null>,
): bigint {
  return parts.reduce<bigint>((left, p) => left - (p ?? 0n), line)
}

/** A part's donor as the split sees it: none, found, or typed in new. */
export type SplitDonor =
  | null
  | { kind: 'existing' }
  | {
      kind: 'new'
      contactKind: 'individual' | 'organization'
      firstName: string
      lastName: string
      name: string
    }

/** Each problem beside its field: per part, the rest, the total. */
export type SplitIssues = {
  parts: Array<{ donor?: string; amount?: string }>
  /** The remainder's note. */
  rest?: string
  /** The parts against the line. */
  total?: string
}

export function splitIssues(
  line: bigint,
  parts: ReadonlyArray<{ amount: bigint | null; donor: SplitDonor }>,
  note: string,
): SplitIssues {
  const out: SplitIssues = {
    parts: parts.map((p) => {
      const issue: { donor?: string; amount?: string } = {}
      const d = p.donor
      if (d === null) issue.donor = 'Choose the donor'
      else if (d.kind === 'new' && d.contactKind === 'individual') {
        if (!d.firstName.trim() || !d.lastName.trim())
          issue.donor = 'A new person needs a first and a last name'
      } else if (d.kind === 'new' && !d.name.trim())
        issue.donor = 'A new organisation needs a name'
      if (p.amount === null || p.amount <= 0n)
        issue.amount = 'An amount over £0'
      return issue
    }),
  }
  if (parts.length === 0) out.total = 'Add at least one gift'
  const left = remainderOf(
    line,
    parts.map((p) => p.amount),
  )
  if (left < 0n) out.total = 'The gifts add up to more than the line'
  if (left > 0n && note.trim() === '')
    out.rest = 'Say what the rest of the line is (it isn’t a donation)'
  return out
}

/** Every issue, in words, in order: none means it can be saved. */
export function splitProblems(
  line: bigint,
  parts: ReadonlyArray<{ amount: bigint | null; donor: SplitDonor }>,
  note: string,
): Array<string> {
  const i = splitIssues(line, parts, note)
  const n = (k: number) => (parts.length > 1 ? ` ${k + 1}` : '')
  return [
    ...(i.total === 'Add at least one gift' ? [i.total] : []),
    ...i.parts.flatMap((p, k) => [
      ...(p.donor ? [`Gift${n(k)}: ${p.donor.toLowerCase()}`] : []),
      ...(p.amount ? [`Gift${n(k)}: ${p.amount.toLowerCase()}`] : []),
    ]),
    ...(i.total && i.total !== 'Add at least one gift' ? [i.total] : []),
    ...(i.rest ? [i.rest] : []),
  ]
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
