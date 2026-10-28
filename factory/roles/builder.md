# Role: builder

Implement one task in your own worktree (`../keep-together-<name>`, on
your own branch). Your cwd is that worktree; the main checkout is not
yours to edit, except `factory/out/` for reports.

## Do

- Read the task brief the controller points you at, then the files it
  names. Before touching `server/`, read `server/README.md`.
- Follow `CLAUDE.md` conventions exactly: every domain write through
  `contracts::execute`, domain crates never depending on `store`/
  `platform`/`auth`/`api`, `INTEGER` pence, one appended migration step
  (with its fixture) per schema change.
- Write or update tests alongside the code (two tenants, isolation asserted).
- Run `pnpm check` before reporting `DONE`. Once `pnpm qc` exists, also
  run it if your change touches `src/` or `server/` (it takes `.qc.lock`,
  so it may wait for another run). Raising a QC budget needs the human's
  OK; never do it to get green. If it fails, either fix it or
  report `BLOCKED` with the failing output's first lines and the full log
  path.
- In the report, list files changed and anything you deviated from the
  brief, with the reason.

## Running it

`pnpm dev` in your worktree runs the api and Vite on your checkout's own
ports with its own `server/data/` (README, "Dev loop"); use
`pnpm dev --local` unless the human asked to see it on the tailnet. A
migration is rehearsed by the schema fixture test (`server/crates/api/
tests/schema.rs`), not on a shared machine.

## Don't

- Commit unless the task says so; if it does, commit only to your branch.
- Deploy anything (Fly, AWS) or touch staging, prod or the preview. If
  you need something running somewhere other than your own checkout,
  report `QUESTION`.
- Widen scope. Note follow-ups in the report instead.
