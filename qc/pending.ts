// What the Rust backend doesn't serve yet (migration-rust.sv, F3 step 6
// "coverage gate"): specs and tests of modules a wave step still has to
// port. Each one is skipped with a `pendingPort` annotation naming the
// step (qc/fixtures.ts), and listed in the run's banner with the flows
// that are `pendingPort` in qc/budgets.ts, so the run doesn't fail for
// them and nobody forgets them. The step that ports a module deletes its
// lines here, re-points the specs, and drops the flows' marks. B3 clears
// what is left.
//
// Their routes are exempt from the coverage gate while
// `src/lib/data/ported.ts` doesn't list them.

export interface Pending {
  /** The plan's step that ports it (A1, A2, A3, A4, B1, B2). */
  step: string
  /** A spec file under qc/flows/, whole. */
  file?: string
  /** Else: tests whose title path matches, in any spec. */
  title?: RegExp
}

export const PENDING: ReadonlyArray<Pending> = [
  // A2: source codes and acquisition.
  { step: 'A2', file: 'contact-acquisition.spec.ts' },
  { step: 'A2', file: 'sources.spec.ts' },
  { step: 'A2', title: /source codes show none of B's/ },
  // A3: settings, groups, Switch group.
  { step: 'A3', file: 'settings.spec.ts' },
  { step: 'A3', title: /Switch group/ },
  { step: 'A3', title: /B's settings are not A's/ },
  // A4: real auth (sign-up, passwords, sign-out flows).
  { step: 'A4', file: 'auth.spec.ts' },
  // B1: the Fields tab, bulk set, history with moments.
  { step: 'B1', title: /fields tab/ },
  { step: 'B1', title: /B's fields are not A's/ },
  { step: 'B1', title: /filter the list by a field$/ },
  { step: 'B1', title: /set and clear a field in bulk/ },
  { step: 'B1', title: /history and Restore to here/ },
  { step: 'B1', title: /history pages/ },
  { step: 'B1', title: /Restore to here on a moment/ },
  { step: 'B1', title: /history re-anchors/ },
  // B2: gifts and Gift Aid.
  { step: 'B2', file: 'gift-record.spec.ts' },
  { step: 'B2', file: 'gifts.spec.ts' },
  { step: 'B2', title: /B's gift is not A's to open/ },
  { step: 'B2', title: /A's record-gift search finds none of B's/ },
  { step: 'B2', title: /the Donations menu offers Record a gift/ },
]

/** The step a test waits for, or null when it runs now. */
export function pendingStep(
  file: string,
  titlePath: ReadonlyArray<string>,
): string | null {
  const base = file.split(/[\\/]/).at(-1) ?? file
  const title = titlePath.join(' › ')
  const hit = PENDING.find((p) =>
    p.file ? p.file === base : p.title!.test(title),
  )
  return hit?.step ?? null
}
