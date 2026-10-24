#!/usr/bin/env bash
# The restore drill on keep-staging (plan migration-rust.sv, F2 step 8;
# docs/ops.md "Restore drill"). The human runs it: it destroys the
# staging machine and volume, twice.
#
#   fly auth login
#   scripts/ops/restore-drill.sh            # both sources
#   scripts/ops/restore-drill.sh litestream # or: snapshot
#
# 1. Seed a 10k org ("drill", the perf generator's people) with the `seed`
#    bin inside the machine, then wait for an hourly snapshot to cover it
#    (a restart triggers one a minute after boot).
# 2. Record counts: tenants, and per org contacts, revisions and a set of
#    search matches (FTS), read straight from the files with sqlite3.
# 3. Per source:
#    a. litestream only: start a loop that commits one row a time to
#       orgs/drill-marks.db and prints each number once committed;
#    b. destroy the machine (--force: no graceful shutdown, the worst
#       case) and its volume, create an empty volume;
#    c. redeploy the same image: the entrypoint sees an empty volume and
#       restores (restore.sh), from Litestream, or from the snapshots
#       when the KEEP_RESTORE_SOURCE secret says so;
#    d. wait for /healthz, read restore.sh's timings from the logs,
#       recount and compare; for litestream, compare the last committed
#       mark with the last restored one.
# 4. Print a results table for docs/ops.md and save it under $TMPDIR.
#
# Pass: a 10k org back in < 60 s from either source; counts and search
# matches equal; ≤ 1 s of committed marks lost (litestream). Exit 1
# otherwise.
set -euo pipefail
cd "$(dirname "$0")/../.."

APP=${APP:-keep-staging}
REGION=lhr
URL=${URL:-https://$APP.fly.dev}
SOURCES=${1:-both}
[[ $SOURCES == both ]] && SOURCES="litestream snapshot"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/keep-drill.XXXXXX")
RESULTS=$WORK/results.md

say() { printf '\n== %s\n' "$*"; }
run() { printf '+ %s\n' "$*" >&2; "$@"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
confirm() { local a; read -r -p "$1 [y/N] " a; [[ $a == [yY]* ]]; }

command -v fly >/dev/null || die "needs flyctl"
command -v node >/dev/null || die "needs node (the 10k generator)"
command -v jq >/dev/null || die "needs jq"
confirm "This destroys $APP's machine and volume (twice for both sources). Go on?" || exit 1

image() { fly status -a "$APP" --json | jq -r '.Machines[0].config.image'; }
machine() { fly machines list -a "$APP" --json | jq -r '.[0].id // empty'; }
volume() { fly volumes list -a "$APP" --json | jq -r '.[0].id // empty'; }
healthz() { curl -fsS --max-time 5 "$URL/healthz"; }
wait_healthy() {
  local i
  for i in $(seq 120); do
    healthz >/dev/null 2>&1 && return 0
    sleep 2
  done
  die "$URL/healthz not healthy after 4 minutes"
}

# drill.sh is in the image.
drill() { fly ssh console -a "$APP" -q -C "drill.sh $*" | tr -d '\r'; }
census() { drill census; }

IMAGE=$(image)
[[ -n $IMAGE && $IMAGE != null ]] || die "no machine in $APP to take the image from"
echo "image: $IMAGE   work dir: $WORK"

say "1. Seed the 10k org"
if [[ $(drill has-org drill) != 1 ]]; then
  run node scripts/perf-search10k-rs/export-jsonl.mjs "$WORK/jsonl" >/dev/null
  run fly ssh sftp put -a "$APP" "$WORK/jsonl/a.jsonl" /data/drill.jsonl
  run fly ssh console -a "$APP" -C "seed --data /data --slug drill --name 'Drill 10k' --admin drill@example.com --jsonl /data/drill.jsonl --prefix drill"
  drill cleanup
fi
# The snapshot job runs a minute after boot: restart, then wait for a
# platform snapshot younger than the seed.
run fly machine restart "$(machine)" -a "$APP"
wait_healthy
for _ in $(seq 60); do
  age=$(healthz | jq -r '.backup.snapshotAgeSeconds // empty')
  [[ -n $age && $age -lt 120 ]] && break
  sleep 5
done
[[ -n ${age:-} && $age -lt 120 ]] || die "no fresh snapshot after the restart (backup: $(healthz | jq -c .backup))"

say "2. Census before"
census | tee "$WORK/before.txt"
grep -q '^drill.contacts 10000$' "$WORK/before.txt" || die "the drill org doesn't have 10000 contacts"

{
  echo "## Restore drill $(date -u +%Y-%m-%dT%H:%MZ), $APP, image ${IMAGE##*:}"
  echo
  echo "| source | restore (all files) | boot to healthy | counts | marks lost |"
  echo "|---|---|---|---|---|"
} >"$RESULTS"
pass=1

for source in $SOURCES; do
  say "3. Drill: $source"
  marks=$WORK/marks-$source.log
  loop_pid=""
  if [[ $source == litestream ]]; then
    # One committed row per line printed; runs until the machine dies.
    fly ssh console -a "$APP" -q -C "drill.sh marks" >"$marks" 2>/dev/null &
    loop_pid=$!
    sleep 15 # Litestream picks the new file up and replicates the stream
    # The restore puts it back alongside the tenants.
    run fly secrets set -a "$APP" --stage RESTORE_EXTRA=drill-marks
  fi
  [[ $source == snapshot ]] && run fly secrets set -a "$APP" --stage KEEP_RESTORE_SOURCE=snapshot

  m=$(machine)
  v=$(volume)
  run fly machine destroy "$m" -a "$APP" --force
  [[ -z $loop_pid ]] || { sleep 2; kill "$loop_pid" 2>/dev/null || true; }
  run fly volumes destroy "$v" -a "$APP" --yes
  run fly volumes create keep_data -a "$APP" --region "$REGION" --size 1 --yes >/dev/null

  started=$(date +%s)
  run fly deploy -c fly.staging.toml -a "$APP" --image "$IMAGE" --ha=false --yes
  wait_healthy
  boot=$(($(date +%s) - started))
  restore_line=$(fly logs -a "$APP" --no-tail 2>/dev/null | grep -o 'restore: all files [0-9.]*s' | tail -1 || true)
  restore_secs=${restore_line##* }

  census | grep -v '^drill-marks' >"$WORK/after-$source.txt"
  if diff -u "$WORK/before.txt" "$WORK/after-$source.txt"; then counts=equal; else counts=DIFFERENT; pass=0; fi

  lost="n/a"
  if [[ $source == litestream ]]; then
    read -r acked acked_ms < <(tr -d '\r' <"$marks" | grep -E '^[0-9]+ [0-9]+$' | tail -1)
    read -r restored restored_ms < <(drill marks-max)
    restored=${restored:-0}
    lost_ms=$((acked_ms - ${restored_ms:-0}))
    ((lost_ms < 0)) && lost_ms=0
    lost="$((acked - restored)) rows, ${lost_ms} ms (last committed $acked, restored $restored)"
    ((lost_ms <= 1000)) || pass=0
    drill cleanup
    run fly secrets unset -a "$APP" --stage RESTORE_EXTRA
  fi
  if [[ $source == snapshot ]]; then
    run fly secrets unset -a "$APP" --stage KEEP_RESTORE_SOURCE
  fi
  awk -v s="${restore_secs%s}" 'BEGIN { exit !(s != "" && s < 60) }' || pass=0
  echo "| $source | ${restore_secs:-?} | ${boot}s | $counts | $lost |" >>"$RESULTS"
done

say "4. Results"
cat "$RESULTS"
echo
echo "saved: $RESULTS (paste into docs/ops.md, Drill log)"
((pass)) && echo "PASS" || { echo "FAIL"; exit 1; }
