#!/usr/bin/env bash
# Set the platform's Ideal Postcodes key on keep-<env> (plan
# address-lookup.sv, step L3). The human runs it; the api reads the key as
# KEEP_IDEAL_POSTCODES_KEY when KEEP_ADDRESS_LOOKUP=ideal
# (rs/crates/api/src/address/; docs/ops.md "Address lookup").
#
#   fly auth login
#   scripts/fly/address-lookup-key.sh staging     # or prod
#
# The key is read from the terminal without echo and reaches flyctl on
# stdin: never argv (the process list), never printed, never in a file.
# --stage: the next deploy applies it. Re-running is safe: it says whether
# a key is already set, and an empty answer keeps that one.
set -euo pipefail

die() { printf 'error: %s\n' "$*" >&2; exit 1; }

case ${1:-} in
staging | prod) APP=keep-$1 ;;
*) die "usage: $0 staging|prod" ;;
esac

command -v fly >/dev/null || die "needs flyctl: https://fly.io/docs/flyctl/install/"
command -v jq >/dev/null || die "needs jq"
[ -t 0 ] || die "run it in a terminal: the key is typed, not piped"
printf '+ fly auth whoami\n' >&2
fly auth whoami >/dev/null || die "not signed in: fly auth login"

printf '+ fly secrets list -a %s --json\n' "$APP" >&2
if fly secrets list -a "$APP" --json |
  jq -e '.[] | (.Name // .name) | select(. == "KEEP_IDEAL_POSTCODES_KEY")' >/dev/null; then
  echo "KEEP_IDEAL_POSTCODES_KEY is already set on $APP: type a new key to replace it, or press Enter to keep it."
else
  echo "KEEP_IDEAL_POSTCODES_KEY is not set on $APP."
fi

IFS= read -rs -p "Ideal Postcodes key (ak_…, not shown): " key
echo
if [ -z "$key" ]; then
  echo "nothing typed: $APP unchanged"
  exit 0
fi
[[ $key == ak_* ]] || die "an Ideal Postcodes key starts with ak_ (nothing was set)"
[[ $key =~ ^[A-Za-z0-9_]+$ ]] || die "the key has characters a key never has (nothing was set)"

# printf is a bash builtin: no process carries the key in its argv.
printf '+ fly secrets import -a %s --stage <KEEP_IDEAL_POSTCODES_KEY on stdin>\n' "$APP" >&2
printf 'KEEP_IDEAL_POSTCODES_KEY=%s\n' "$key" | fly secrets import -a "$APP" --stage
unset key

echo "staged on $APP: the next deploy applies it."
echo "The api uses it once the app's [env] has KEEP_ADDRESS_LOOKUP = \"ideal\" (fly.staging.toml for staging)."
