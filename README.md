# keep-together

Open-source (AGPL-3.0) fundraising CRM for small UK community groups and
charities: donor records, Direct Debit, painless HMRC Gift Aid. Rebuild of
[ngo-go](../ngo-go): a Rust api (axum + rusqlite, **one SQLite file per
organisation**) serving a React SPA, on one Fly machine with Litestream
and hourly snapshots to S3. Why: `docs/decisions/0024-*.md` (and 0017,
the founding decision it amends).

## Dev loop

```sh
pnpm install
pnpm dev               # the api and Vite, shared on the tailnet; prints the URL first
pnpm dev --local       # the same on this machine only
pnpm dev:reset         # wipe server/data/ and reseed riverside, then as pnpm dev
pnpm dev:share --off   # remove this checkout's tailnet entry (pnpm dev removes it on exit)
pnpm check             # clippy + cargo test, then typecheck + lint + vitest (what CI runs)
pnpm qc                # the Playwright QC suite (qc/README.md)
```

`pnpm dev` runs from any checkout (the main one or a worktree):

- **The api** (`server/`) is rebuilt and restarted on every save under
  `server/crates` (a debug build: a couple of seconds). A failed build
  keeps the last good api running.
- **Vite** serves the SPA with HMR and proxies `/api` (the SSE stream
  included) to it.
- **Ports** come from the checkout's slot n (main = 0, each worktree its
  own, kept in the main checkout's `.git/keep-dev-slots.json`): api
  8787 + n, Vite 3000 + n, tailnet https 9100 + n. Several branches run
  side by side; each URL line names its branch. `KEEP_PORT`,
  `KEEP_VITE_PORT` and `KEEP_HTTPS_PORT` override them.
- **The tailnet**: `tailscale serve --bg --https=<9100+n>` in front of
  Vite (never funnel). The serve config is the machine's, shared with
  other projects: `pnpm dev` refuses a port that serves something else and
  only ever removes its own entry. If tailscale asks for rights, run once
  `sudo tailscale set --operator=$USER`.
- **Data** is `server/data/` (gitignored), seeded with the riverside
  group on the first boot and kept across restarts. Sign in as
  `admin@keep-together.example` (or `staff@…`, `viewer@…`), password
  `riverside`: the api runs `KEEP_AUTH_POLICY=relaxed` (a password alone),
  `KEEP_MAIL=log` (codes and links in the terminal) and
  `KEEP_ADDRESS_LOOKUP=fake`. Set any of them in the environment to
  change it. Dev auth (`KEEP_DEV_AUTH`) is never on here.

Rust alone: `cargo test`, `cargo clippy --all-targets -- -D warnings` and
`cargo run -p cli --bin keep -- …` from `server/` (`server/README.md`).

## Create a group

Groups can't sign up in the app; the operator creates each one with
`keep`, against the data directory (locally `server/data`, on Fly
`/data` in `fly ssh console`):

```sh
keep tenant create --slug anytown-hall --name "Anytown Village Hall" --admin-email jo@example.org
keep auth invite anytown-hall sam@example.org --role staff
keep sql anytown-hall "SELECT count(*) FROM contacts"     # read-only by construction
```

## Environments

| | where | data |
|---|---|---|
| dev | `pnpm dev`, per checkout | riverside seed, kept |
| preview | `https://<this machine>.ts.net` (tailnet), main rebuilt every 5 min (`scripts/preview/`) | riverside seed |
| staging | `staging.keep-together.org.uk` (`keep-staging`, Fly lhr), every push to main | reset to riverside on each deploy |
| prod | `app.keep-together.org.uk` (`keep-prod`), by hand only | real |

`docs/ops.md` has the operations: settings, first-time setup
(`scripts/fly/{staging,prod}.sh`, `scripts/aws/*`), backups, restore and
the drill, monitoring, the nightly QC.

## Where things are

- `server/` — the api (`server/README.md`: crates, HTTP conventions, the
  write path, migrations, jobs, `keep`).
- `src/` — the React SPA: TanStack Router file routes under `src/routes/`,
  the data layer in `src/lib/data/` (TanStack Query over the api, its
  ts-rs types in `rust-types/`), shared shapes and pure rules in
  `src/lib/domain/`, shadcn components under `src/components/ui/`.
- `qc/` — the Playwright QC suite and its budgets (ADR 0018).
- `docs/` — `architecture.md`, `ops.md`, `decisions/` (ADRs),
  `research.md` (CiviCRM/Gift Aid/GDPR domain reference),
  `product-brief.md`, `inherited-from-ngo-go.md`.

`CLAUDE.md` holds the working rules (domain invariants, the write path,
tenancy, validation tiers).
