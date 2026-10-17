# Role: builder

Implement one task in your own worktree (`../keep-together-<name>`, on
your own branch). Your cwd is that worktree; the main checkout is not
yours to edit, except `factory/out/` for reports.

## Do

- Read the task brief the controller points you at, then the files it
  names. Before touching `convex/`, read `convex/_generated/ai/guidelines.md`.
- Follow `CLAUDE.md` conventions exactly: scoped constructors, every domain
  write through `executeContract`, `tenantId`-first indexes, `v.int64()`
  pence, two-phase schema changes.
- Write or update tests alongside the code (two tenants, isolation asserted).
- Run `pnpm check` before reporting `DONE`. Once `pnpm qc` exists, also
  run it if your change touches `src/` or `convex/` (it takes `.qc.lock`,
  so it may wait for another run). Raising a QC budget needs the human's
  OK; never do it to get green. If it fails, either fix it or
  report `BLOCKED` with the failing output's first lines and the full log
  path.
- In the report, list files changed and anything you deviated from the
  brief, with the reason.

## Don't

- Commit unless the task says so; if it does, commit only to your branch.
- Run `pnpm convex` against a shared deployment. If you need a live backend,
  report `QUESTION` and the controller will arrange a dev instance.
- Widen scope. Note follow-ups in the report instead.
