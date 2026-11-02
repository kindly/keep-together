#!/usr/bin/env bash
# Reset keep-staging to a fresh riverside seed, when you ask (plan
# gocardless-sandbox-qc.sv, S1a). The human runs it:
#
#   fly auth login
#   scripts/fly/staging-reset.sh
#
# Only on a kept staging (KEEP_RESET_ON = "demand", switched once by
# scripts/fly/staging-kept.sh); under deploy the generation is ignored,
# and this script times out.
#
# It sets KEEP_RESET_GENERATION to a new UTC timestamp with `fly secrets
# set`. That isn't a secret; it's how to change the machine's env
# without a deploy. It lives only as a Fly secret, never in
# fly.staging.toml's [env] (docs/ops.md "Staging"). Fly restarts the machine, and the entrypoint
# (scripts/ops/entrypoint.sh) sees a generation that differs from
# /data/.generation: it wipes /data, the api seeds riverside with the
# same sign-ins, and Litestream starts a fresh prefix staging/<generation>.
# The script waits until /healthz reports the new generation.
set -euo pipefail

APP=keep-staging
URL=https://staging.keep-together.org.uk
PHRASE="reset $APP"
# Seconds: how long to wait for the new generation, and between polls.
WAIT=${KEEP_RESET_WAIT:-600}
POLL=${KEEP_RESET_POLL:-5}

die() { printf 'error: %s\n' "$*" >&2; exit 1; }

command -v fly >/dev/null || die "needs flyctl: https://fly.io/docs/flyctl/install/"
command -v curl >/dev/null || die "needs curl"
command -v jq >/dev/null || die "needs jq"
printf '+ fly auth whoami\n' >&2
fly auth whoami >/dev/null || die "not signed in: fly auth login"

echo "This wipes everything on $APP ($URL): every org, user and gift."
echo "It comes back as a fresh riverside seed with the same sign-ins."
IFS= read -r -p "Type '$PHRASE' to go on: " answer || answer=""
[ "$answer" = "$PHRASE" ] || die "you typed '$answer', not '$PHRASE': nothing was changed"

generation=$(date -u +%Y%m%dT%H%M%SZ)
printf '+ fly secrets set -a %s KEEP_RESET_GENERATION=%s\n' "$APP" "$generation" >&2
fly secrets set -a "$APP" "KEEP_RESET_GENERATION=$generation"

echo "waiting for $URL/healthz to report generation $generation (up to ${WAIT}s)"
deadline=$((SECONDS + WAIT))
seen=""
while :; do
  body=$(curl -fsS --max-time 10 "$URL/healthz" 2>/dev/null || true)
  seen=$(jq -r 'if .ok == true then .resetGeneration // "none" else "not ok" end' \
    <<<"$body" 2>/dev/null || echo "no answer")
  seen=${seen:-no answer}
  if [ "$seen" = "$generation" ]; then
    echo "$APP reset: generation $generation"
    exit 0
  fi
  [ "$SECONDS" -lt "$deadline" ] || break
  sleep "$POLL"
done
die "after ${WAIT}s /healthz reports generation '$seen', not '$generation'." \
  "Check fly logs -a $APP; fly.staging.toml needs KEEP_RESET_ON = \"demand\"."
