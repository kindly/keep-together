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
pnpm dev:instance demo   # another cloud dev deployment: dev/demo, auth keys set, code pushed
npx convex run platform/devSeed:demoTenant '{"slug":"demo"}'   # a tenant with contacts
```

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
