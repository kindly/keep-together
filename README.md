# keep-together

Open-source (AGPL-3.0) fundraising CRM for small UK community groups and
charities: donor records, Direct Debit, painless HMRC Gift Aid. Rebuild of
[ngo-go](../ngo-go) on a fully managed stack — Convex backend, React SPA,
nothing of ours runs on a server. Why: `docs/decisions/0017-*.md`.

## Run it

```sh
pnpm install
pnpm convex          # first run: logs you into Convex, creates a dev deployment,
                     # writes .env.local (CONVEX_DEPLOYMENT, VITE_CONVEX_URL),
                     # pushes functions, generates convex/_generated. Keep it running.
npx @convex-dev/auth # once per deployment: sets JWT keys + SITE_URL for Convex Auth
pnpm dev             # Vite on http://localhost:3000
pnpm check           # typecheck + lint + tests (CI)
pnpm dev:instance scratch   # another cloud dev deployment: dev/scratch, auth keys set, code pushed
npx convex run platform/devSeed:demoTenant '{"slug":"demo"}'   # a tenant with contacts
# (dev/demo and dev/preview are taken: see "Manual test instances")
```

## Create a tenant

Groups can't sign up for a tenant in the app; the operator creates each one
from the CLI. The admin signs up first (any email + password). Before
you run `create`, check with them that they can sign in. Sign-up is open
and emails aren't verified yet, so anyone could have registered that
address first (invitations will close this gap). Then:

```sh
npx convex run platform/tenants:create \
  '{"slug":"anytown-hall","name":"Anytown Village Hall","adminEmail":"jo@example.org"}'
```

The slug is lowercase letters, digits and hyphens, 3–40 characters, and
must be unused. `adminEmail` must match an existing user exactly; that
user becomes the tenant's admin. Add `--prod` (or `--deployment <name>`)
to target a deployment other than the one in `.env.local`. For a demo
tenant you can open yourself, pass your email to the seed:
`platform/devSeed:demoTenant '{"slug":"demo","adminEmail":"you@example.org"}'`.

## Manual test instances

Two cloud dev deployments always run main, seeded with the same world:
tenant `riverside` ("Riverside Community Trust"), one password user per
membership role, and 100 generated donors (individuals, organisations,
households; shared and malformed emails, missing postcodes, archived
contacts, notes, relationships). The data comes from a fixed random seed,
so it is identical on both instances and after every reset.

| Instance | Deployment | Browse at |
|---|---|---|
| demo (for demos) | `dev/demo` = `careful-dolphin-689` | GitHub Pages, built from main (`vars.VITE_CONVEX_URL` = `https://careful-dolphin-689.eu-west-1.convex.cloud`) |
| preview (fast feedback) | `dev/preview` = `robust-spider-537` | `http://lenovo.tail6804fa.ts.net:4300/` over Tailscale, while `pnpm instances:serve` runs |

```sh
pnpm instances:sync           # after every merge, from the main checkout on main:
                              # push main to both, (re)seed, rebuild dist-preview
pnpm instances:sync --reset   # wipe both and reseed from scratch (same passwords)
pnpm instances:sync --only preview   # just one of them
pnpm instances:serve          # serve dist-preview on this machine's Tailscale IP, port 4300
```

Sync resets the seeded users' passwords and roles; other data you create
is kept (the seed only fills in what is missing). It refuses to run from
a branch other than `main`, with uncommitted changes, or with untracked
files under `convex/`, `src/` or `public/` (`--any-branch` overrides,
for working on the script). It runs the Convex CLI and writes to the
main checkout, so run it outside the Claude sandbox.

- **Sign-ins** are in `.env.test-users.local` in the main checkout (mode
  600, gitignored): email and password per role. Passwords are generated
  once and kept across resets. Edit one and sync to change it.
- **Deploy keys** are in `.env.demo.local` / `.env.preview.local` in the
  main checkout. Before writing, the sync checks that each key really
  belongs to `dev/demo` / `dev/preview`. A missing file means the
  deployment is created (EU, auth keys, deploy key).
- **Deployment env**: `TEST_SEED_ENABLED=1` allows `platform/testSeed`
  there and nowhere else. `AUTH_2FA_REQUIRED=0` exempts these instances
  from staff 2FA once it exists (auth-roles R4).
- `dist-preview` is a symlink to the newest build in
  `dist-preview.builds/`; the one before stays until the next sync, so
  tabs already open keep loading their route chunks.
- The seed is `convex/platform/testSeed.ts` (users, tenant) and
  `testSeedData.ts` (the donors). A new membership role is one line in
  `TEST_USERS`; the next sync mints its password.

## Where things are

- `convex/` — backend: `schema.ts`, `lib/tenancy.ts` (scoped function
  constructors — the only way to declare domain functions), `platform/`
  (tenants, memberships), `auth.ts`/`http.ts`.
- `src/` — React SPA: TanStack Router file routes under `src/routes/`,
  shadcn components under `src/components/ui/`.
- `docs/` — `architecture.md`, `decisions/` (ADRs; 0017 is the founding
  one), `research.md` (CiviCRM/Gift Aid/GDPR domain reference),
  `product-brief.md`, `competition.md`, `inherited-from-ngo-go.md` (what
  the Django predecessor proved in code; the checklist to re-prove here).

`CLAUDE.md` holds the working rules (domain invariants, contracts,
tenancy, validation tiers). `docs/spikes/` records what each ADR 0017
spike proved.

## Deploy the SPA

It is static. `.github/workflows/pages.yml` builds to GitHub Pages with
`VITE_CONVEX_URL` from a repository variable and the repo name as base
path. Any static host works; nothing may depend on where the files are
served from. The backend deploys with `npx convex deploy`.
