# keep-together — agent instructions

The project rules live in **`CLAUDE.md`** (domain invariants, the write
path, tenancy, validation tiers, commands): read it first. Before
touching `server/`, read `server/README.md` (crates, HTTP conventions,
the write path, migrations, jobs, `keep`).

In short: a Rust api (`server/`, axum + rusqlite) with one SQLite file
per organisation, every domain write through `contracts::transact` →
`execute`, money as `INTEGER` pence, and a React SPA (`src/`) over it.
`pnpm dev` runs both; `pnpm check` is what CI runs.
