# Spike 6 — easy dev instances on Convex cloud

Date: 2026-10-17 · Status: **done** (replaces the "self-host on a VPS" spike at David's request; the self-host images are pulled and nothing here precludes doing it later)

## What you get

```sh
pnpm dev:instance <name>            # e.g. pnpm dev:instance demo
```

First run: creates the cloud dev deployment `dev/<name>` in this project
(region `eu` unless `CONVEX_REGION` is set), writes `.env.<name>.local`
(gitignored), generates and sets the Convex Auth keys (`JWT_PRIVATE_KEY`,
`JWKS`) plus `SITE_URL`, and pushes the code. Later runs just push. Dev
deployments are free on the current plan; there is no CLI delete — remove
them from the dashboard.

Point any command at the instance:

```sh
npx convex run --deployment <deployment-name> platform/devSeed:demoTenant '{"slug":"demo"}'
npx convex env list --deployment <deployment-name>
npx convex dev --once --env-file .env.<name>.local
VITE_CONVEX_URL=$(grep VITE_CONVEX_URL .env.<name>.local | cut -d= -f2) pnpm dev
```

`platform/devSeed:demoTenant` gives an instance a tenant with an owner,
the seeded relationship types and three contacts. The owner is a bare
`users` row (no password); sign up through the UI and add a membership
from the dashboard, or extend the seed to call Convex Auth's
`createAccount` — left for when the first screen needs it.

## Gotchas found

- `npx convex dev --env-file X` **also rewrites `.env.local`** to the
  deployment it pushed to. The script backs `.env.local` up and restores
  it on exit, so your main deployment selection survives.
- `npx convex deployment create` defaults to the US region; pass
  `--region eu` for the EU (the error message for a bogus region lists the
  choices: `eu`, `us`, `aws-ca-central-1`, `aws-ap-southeast-2`).
- The Convex-side typecheck (`convex/tsconfig.json`, no Node types) rejected
  `process.env` in `auth.config.ts`; it now uses `env` from
  `_generated/server`, which is what the Convex guidelines ask for.
- Auth keys set this way are byte-compatible with what `npx @convex-dev/auth`
  would set (same PEM-on-one-line and JWKS shape), without the wizard.

## Files

- `scripts/dev-instance.sh` — the command behind `pnpm dev:instance`
- `scripts/convex-auth-keys.mjs` — RS256 key pair in Convex Auth's shape
- `convex/platform/devSeed.ts` — `demoTenant`, `inspectTenant` (internal)
