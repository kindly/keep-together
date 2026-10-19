# Data migrations: order for a deployment that is behind

Schema changes are two-phase (CLAUDE.md): loosen → deploy → backfill →
tighten. Every factory dev deployment (dev/qc-*, dev/demo, dev/preview,
the human's dev) has had all of these run. A deployment that is **behind**
must be brought forward in this order; each tighten refuses to deploy
until its backfill has run, so a skipped step fails loudly, not silently.

| # | Deploy this commit | Then run | Then |
|---|---|---|---|
| 1 | `e27367a` (S2a) | `npx convex run contacts/migrations:run '{"fn":"contacts/migrations:backfillAddressNormalized"}'` | wait for `npx convex run --component migrations lib:getStatus` → isDone |
| 2 | `a19344b` (R1a) | `npx convex run platform/migrations:run '{"fn":"platform/migrations:ownerToAdmin"}'` | isDone |
| 3 | `3034c32` (S4a) | `npx convex run contacts/migrations:run '{"fn":"contacts/migrations:backfillTagsVersion"}'` | isDone |
| 4 | `c94194c` (X2) | `npx convex run contacts/migrations:run '{"fn":"contacts/migrations:backfillExternalIdentifiers"}'` | isDone, and `npx convex run platform/migrations:legacyLeftoverTotal` → total 0 (resolve any leftover first) |
| 5 | `1d81139` (settings per category a, loosen) | `npx convex run platform/migrations:run '{"fn":"platform/migrations:splitStaffCanManageLists"}'` | isDone |
| 6 | `e0fc0a1` (settings per category b, tighten) | — | deploy only where row 5 is isDone |
| 7 | `368fa56` (E2a-1, `onHold` loosen, `emailSuppressions`) | `npx convex run contacts/migrations:run '{"fn":"contacts/migrations:backfillEmailHolds"}'` (moves each stored hold to a suppression, unsets `onHold`) | isDone |
| 8 | `882ad65` (E2a-2, `onHold` removed) | — | deploy only where row 7 is isDone |
| 9 | `c07a706` (source codes 1, loosen) | `npx convex run contacts/migrations:run '{"fn":"contacts/migrations:backfillAcquisitionVersion"}'`, then `npx convex run contacts/migrations:run '{"fn":"contacts/migrations:backfillContactSearch"}'` (fills `contactSearch.sortName`), then `npx convex run platform/migrations:run '{"fn":"platform/migrations:backfillSourceCodesPreference"}'` | isDone for all three. The first and third were deleted in `f4b1571`: run them from this commit (they exist up to `7379b19`) |
| 10 | `a4eba31` (source codes 2 + review fixes, `sources` module) | `npx convex run sources/migrations:run '{"fn":"sources/migrations:seedCategories"}'` (the seven starter categories for existing tenants) | isDone. This push drops `sourceCodes.codeNormalized` and `by_tenant_code`, which is safe only because nothing writes `sourceCodes` before it |
| 11 | `f4b1571` (source codes 6, tighten) | — | refuses to deploy unless row 9's `backfillAcquisitionVersion` and `backfillSourceCodesPreference` are isDone (ADR 0022) |
| 12 | `main` | (perf step 1's revision `groupName` backfill, once merged: optional, history falls back without it) | — |

Rehearse the sequence on a rehearsal slot first (README "Rehearsal
slots"): `pnpm rehearsal:claim`, then `pnpm rehearsal:run <n> --cwd
<worktree> -- deploy -y` / `-- run …` per row, never a new deployment.

Do it from a temporary worktree (`git worktree add --detach <dir> <commit>`)
with the deployment's `.env.local` / deploy key, so the main checkout is
untouched.

**Release note:** SPA tabs opened before X3 send a removed details field and
get a validator error on save; reload them.
