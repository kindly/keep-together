#!/usr/bin/env bash
# Grow keep-<env>'s data volume (keep_data) to SIZE GB, 10 by default:
# room for the org files and the declaration scans' files db (plan
# declaration-scans.sv). The human runs it; Fly volumes only grow, never
# shrink, so it refuses a size below the current one.
#
#   fly auth login
#   scripts/fly/volume-size.sh staging        # or prod; optional size: prod 20
#
# `fly volumes extend` grows the volume and its filesystem in place on a
# Machines app. If flyctl says the machine needs a restart, the script
# says so and leaves it to you (the app's own data is unaffected).
set -euo pipefail

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
run() { printf '+ %s\n' "$*" >&2; "$@"; }

case ${1:-} in
staging | prod) APP=keep-$1 ;;
*) die "usage: $0 staging|prod [size-gb]" ;;
esac
SIZE=${2:-10}
[[ $SIZE =~ ^[0-9]+$ ]] || die "size is whole GB, e.g. 10"

command -v fly >/dev/null || die "needs flyctl: https://fly.io/docs/flyctl/install/"
command -v jq >/dev/null || die "needs jq"
printf '+ fly auth whoami\n' >&2
fly auth whoami >/dev/null || die "not signed in: fly auth login"

printf '+ fly volumes list -a %s --json\n' "$APP" >&2
vols=$(fly volumes list -a "$APP" --json |
  jq -c '[.[]? | select((.Name // .name) == "keep_data")]')
count=$(jq 'length' <<<"$vols")
[ "$count" = 1 ] || die "$APP has $count keep_data volumes; expected exactly one"
id=$(jq -r '.[0] | (.ID // .id)' <<<"$vols")
now=$(jq -r '.[0] | (.SizeGb // .size_gb)' <<<"$vols")

echo "$APP keep_data ($id) is ${now} GB"
if [ "$now" -ge "$SIZE" ]; then
  echo "already ${now} GB, at or over ${SIZE} GB: nothing to do"
  exit 0
fi
run fly volumes extend "$id" -a "$APP" --size "$SIZE" --yes
echo "done: $APP keep_data is now ${SIZE} GB. /healthz shows the disk's free bytes once that change is deployed."
