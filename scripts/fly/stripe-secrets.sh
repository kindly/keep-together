#!/usr/bin/env bash
# Set the platform's Stripe secrets on keep-<env> (plan stripe.sv, step
# S0). The human runs it, with two things to hand from the platform's
# Stripe account (the staging sandbox for staging, the keep-qc sandbox for
# qc, live mode for prod): a restricted API key, and the signing secret of
# that environment's "connected accounts" webhook endpoint. The api reads
# them as KEEP_STRIPE_API_KEY and KEEP_STRIPE_WEBHOOK_SECRET when
# KEEP_STRIPE=test|live (server/crates/api/src/stripe/; docs/ops.md
# "Stripe"). There is no secret per group: the platform's key plus the
# group's account id is how every call is made.
#
#   fly auth login
#   scripts/fly/stripe-secrets.sh staging     # or qc, or prod
#
# Each value is read from the terminal without echo and reaches flyctl on
# stdin: never argv (the process list), never printed, never in a file.
# --stage: the next deploy applies them. Re-running is safe: it says which
# are already set, and an empty answer keeps that one.
set -euo pipefail

die() { printf 'error: %s\n' "$*" >&2; exit 1; }

case ${1:-} in
staging) APP=keep-staging MODE=test ;;
qc) APP=keep-qc MODE=test ;;
prod) APP=keep-prod MODE=live ;;
*) die "usage: $0 staging|qc|prod" ;;
esac

command -v fly >/dev/null || die "needs flyctl: https://fly.io/docs/flyctl/install/"
command -v jq >/dev/null || die "needs jq"
[ -t 0 ] || die "run it in a terminal: the secrets are typed, not piped"
printf '+ fly auth whoami\n' >&2
fly auth whoami >/dev/null || die "not signed in: fly auth login"

printf '+ fly secrets list -a %s --json\n' "$APP" >&2
set_already=$(fly secrets list -a "$APP" --json | jq -r '.[] | (.Name // .name)')

NAMES=(KEEP_STRIPE_API_KEY KEEP_STRIPE_WEBHOOK_SECRET)
PROMPTS=(
  "the restricted API key (rk_${MODE}_…)"
  "the connected-accounts webhook endpoint's signing secret (whsec_…)"
)
# What each must start with. A sandbox's keys are rk_test_, live mode's
# rk_live_: the wrong one for this app is refused, so a live key never
# reaches staging or keep-qc and a sandbox key never reaches prod. A
# secret key (sk_…) is refused too: the platform's key is a restricted one.
PREFIXES=("rk_${MODE}_" "whsec_")
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
  [[ $value == "${PREFIXES[$i]}"* ]] || die "$name for $APP starts with ${PREFIXES[$i]} (nothing was set)"
  [[ $value =~ ^[A-Za-z0-9_]+$ ]] || die "$name has characters it never has (nothing was set)"
  # printf is a bash builtin: no process carries a secret in its argv.
  lines+=$(printf '%s=%s' "$name" "$value")$'\n'
  unset value
done

if [ -z "$lines" ]; then
  echo "nothing typed: $APP unchanged"
  exit 0
fi
printf '+ fly secrets import -a %s --stage <the Stripe secrets on stdin>\n' "$APP" >&2
printf '%s' "$lines" | fly secrets import -a "$APP" --stage
unset lines

echo "staged on $APP: the next deploy applies them."
echo "The api uses them once the app's [env] has KEEP_STRIPE = \"$MODE\"."
echo "The webhook endpoint in Stripe: <app origin>/api/stripe/webhook, listening to"
echo "events on connected accounts."
