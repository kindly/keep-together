#!/usr/bin/env bash
# Set the GoCardless partner app's secrets on keep-<env> (plan
# gocardless.sv, step D0). The human runs it, with the partner app's
# OAuth client id and secret and its webhook endpoint secret to hand (the
# sandbox app's for staging, the live app's for prod). The api reads them
# as KEEP_GOCARDLESS_CLIENT_ID, KEEP_GOCARDLESS_CLIENT_SECRET and
# KEEP_GOCARDLESS_WEBHOOK_SECRET when KEEP_GOCARDLESS=sandbox|live
# (server/crates/api/src/gocardless/).
#
#   fly auth login
#   scripts/fly/gocardless-secrets.sh staging     # or prod
#
# Each value is read from the terminal without echo and reaches flyctl on
# stdin: never argv (the process list), never printed, never in a file.
# --stage: the next deploy applies them. Re-running is safe: it says which
# are already set, and an empty answer keeps that one.
set -euo pipefail

die() { printf 'error: %s\n' "$*" >&2; exit 1; }

case ${1:-} in
staging) APP=keep-staging MODE=sandbox ;;
prod) APP=keep-prod MODE=live ;;
*) die "usage: $0 staging|prod" ;;
esac

command -v fly >/dev/null || die "needs flyctl: https://fly.io/docs/flyctl/install/"
command -v jq >/dev/null || die "needs jq"
[ -t 0 ] || die "run it in a terminal: the secrets are typed, not piped"
printf '+ fly auth whoami\n' >&2
fly auth whoami >/dev/null || die "not signed in: fly auth login"

printf '+ fly secrets list -a %s --json\n' "$APP" >&2
set_already=$(fly secrets list -a "$APP" --json | jq -r '.[] | (.Name // .name)')

NAMES=(KEEP_GOCARDLESS_CLIENT_ID KEEP_GOCARDLESS_CLIENT_SECRET KEEP_GOCARDLESS_WEBHOOK_SECRET)
PROMPTS=(
  "the partner app's OAuth client id"
  "the partner app's OAuth client secret"
  "the partner app's webhook endpoint secret"
)
lines=""
for i in "${!NAMES[@]}"; do
  name=${NAMES[$i]}
  if grep -qx "$name" <<<"$set_already"; then
    echo "$name is already set on $APP: type a new value to replace it, or press Enter to keep it."
  else
    echo "$name is not set on $APP."
  fi
  IFS= read -rs -p "${PROMPTS[$i]} (not shown): " value
  echo
  if [ -z "$value" ]; then
    echo "  $name unchanged"
    continue
  fi
  [[ $value =~ ^[[:graph:]]+$ ]] || die "$name has spaces or control characters (nothing was set)"
  # printf is a bash builtin: no process carries a secret in its argv.
  lines+=$(printf '%s=%s' "$name" "$value")$'\n'
  unset value
done

if [ -z "$lines" ]; then
  echo "nothing typed: $APP unchanged"
  exit 0
fi
printf '+ fly secrets import -a %s --stage <the GoCardless secrets on stdin>\n' "$APP" >&2
printf '%s' "$lines" | fly secrets import -a "$APP" --stage
unset lines

echo "staged on $APP: the next deploy applies them."
echo "The api uses them once the app's [env] has KEEP_GOCARDLESS = \"$MODE\"."
echo "Register on the partner app: redirect URI <app origin>/api/gocardless/callback,"
echo "webhook endpoint <app origin>/api/gocardless/webhook."
