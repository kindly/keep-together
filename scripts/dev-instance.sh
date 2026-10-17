#!/usr/bin/env bash
# Spin up (or refresh) a named dev instance on Convex cloud.
#
#   scripts/dev-instance.sh <name> [site-url]
#
# First run: creates `dev/<name>` in this project, writes `.env.<name>.local`
# (gitignored), sets the Convex Auth keys + SITE_URL, pushes the code.
# Later runs: just pushes the code. Point any `npx convex` command at the
# instance with `--env-file .env.<name>.local` (dev) or
# `--deployment <deployment-name>` (env/export/import/run/data).
#
#   pnpm dev:instance demo               # create + push
#   npx convex run --env-file .env.demo.local platform/devSeed:demoTenant '{"slug":"demo"}'
#   VITE_CONVEX_URL=$(grep VITE_CONVEX_URL .env.demo.local | cut -d= -f2) pnpm dev
set -euo pipefail
cd "$(dirname "$0")/.."

name=${1:?usage: dev-instance.sh <name> [site-url]}
site=${2:-http://localhost:3000}
envfile=".env.$name.local"

if [ ! -f "$envfile" ]; then
  echo "▸ creating dev deployment dev/$name"
  # Same region as the main deployment (EU) unless CONVEX_REGION is set (eu | us | …)
  out=$(npx convex deployment create "dev/$name" --type dev --region "${CONVEX_REGION:-eu}" 2>&1 | tee /dev/stderr)
  url=$(printf '%s' "$out" | grep -o 'https://[a-z0-9.-]*\.convex\.cloud' | head -1)
  [ -n "$url" ] || { echo "could not parse deployment URL"; exit 1; }
  slug=$(printf '%s' "$url" | sed -E 's#https://([a-z0-9-]+)\..*#\1#')
  printf 'CONVEX_DEPLOYMENT=dev:%s\nVITE_CONVEX_URL=%s\n' "$slug" "$url" > "$envfile"
  echo "▸ wrote $envfile"
fi

# shellcheck disable=SC1090
deployment=$(grep '^CONVEX_DEPLOYMENT=' "$envfile" | cut -d= -f2 | sed 's/^dev://')

if ! npx convex env list --deployment "$deployment" 2>/dev/null | grep -q '^JWKS='; then
  echo "▸ setting Convex Auth keys + SITE_URL on $deployment"
  keys=$(node scripts/convex-auth-keys.mjs)
  npx convex env set --deployment "$deployment" JWT_PRIVATE_KEY -- "$(printf '%s' "$keys" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).JWT_PRIVATE_KEY)')" >/dev/null
  npx convex env set --deployment "$deployment" JWKS -- "$(printf '%s' "$keys" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).JWKS)')" >/dev/null
  npx convex env set --deployment "$deployment" SITE_URL "$site" >/dev/null
fi

# `convex dev` rewrites .env.local to whatever it pushed to; keep yours.
[ -f .env.local ] && cp .env.local .env.local.bak
trap '[ -f .env.local.bak ] && mv .env.local.bak .env.local' EXIT
echo "▸ pushing code to $deployment"
npx convex dev --once --env-file "$envfile"
echo "✔ $name ready: $(grep VITE_CONVEX_URL "$envfile" | cut -d= -f2)"
