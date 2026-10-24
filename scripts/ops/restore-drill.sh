#!/usr/bin/env bash
# The restore drill on keep-staging (plan migration-rust.sv, F2 step 8;
# docs/ops.md "Restore drill"). The human runs it: it destroys the
# staging machine and volume, twice.
#
#   fly auth login
#   scripts/ops/restore-drill.sh            # both sources
#   scripts/ops/restore-drill.sh litestream # or: snapshot
#
#   scripts/ops/restore-drill.sh local prod # restore-only, on this machine
#
# `local <env>` is the prod drill (and works for staging too). It touches
# no Fly machine: it restores <env> from both backups into a temporary
# directory here, with your own AWS profiles (keep-prod, keep-backup), never
# the drill key, checks every file, prints pass/fail, timings and totals
# only (no org names or ids), and deletes the restored data unless you pass
# --keep. Run it on your own machine or a UK box: it pulls every donor's
# data. Needs the aws CLI, litestream (0.5.17) and sqlite3; it builds
# keep-snapshot from rs/.
#
# 1. Seed a 10k org ("drill", the perf generator's people) with the `seed`
#    bin inside the machine, then take a snapshot pass at once
#    (`keep-snapshot run`) rather than wait for the hourly job.
# 2. Record counts: tenants, and per org contacts, revisions and a set of
#    search matches (FTS), read straight from the files with sqlite3.
# 3. Per source:
#    a. litestream only: start a loop that commits one row a time to
#       drill/marks.db, then crash: `drill.sh hard-stop` SIGKILLs
#       Litestream, the api and the loop at once and deletes the data, so
#       no graceful flush and no restart can ship what wasn't replicated;
#    b. destroy the machine and its volume, create an empty volume;
#    c. redeploy the same image: the entrypoint sees an empty volume and
#       restores (restore.sh), from Litestream, or from the snapshots
#       when the KEEP_RESTORE_SOURCE secret says so;
#    d. wait for /healthz, read restore.sh's timings from the logs,
#       recount and compare; for litestream, the loss is the kill time
#       minus the newest restored mark, both by the machine's clock: an
#       upper bound on the window of committed writes lost (it counts
#       every mark committed before the kill, whether or not its line
#       reached this laptop).
# 4. Print a results table for docs/ops.md and save it under $TMPDIR.
#
# Pass: a 10k org back in < 60 s from either source; counts and search
# matches equal; ≤ 1 s of committed marks lost (litestream). Exit 1
# otherwise.
set -euo pipefail
cd "$(dirname "$0")/../.."

# ---- local: restore-only drill on this machine (prod) ----------------------
if [[ ${1:-} == local ]]; then
  ENV_NAME=${2:-}
  [[ $ENV_NAME == prod || $ENV_NAME == staging ]] || { echo "usage: $0 local prod|staging [--keep]" >&2; exit 2; }
  KEEP_DATA=${3:-}
  die() { printf 'error: %s\n' "$*" >&2; exit 1; }
  for tool in aws litestream sqlite3 cargo awk; do command -v $tool >/dev/null || die "needs $tool"; done
  litestream version | grep -q '0\.5\.' || die "needs litestream 0.5.x (the image pins 0.5.17)"
  creds() { aws configure export-credentials --profile "$1" --format env-no-export; }
  value() { sed -n "s/^$1=//p"; }
  prod_creds=$(creds keep-prod) || die "no keep-prod credentials: aws sso login --profile mgmt"
  backup_creds=$(creds keep-backup) || die "no keep-backup credentials"
  prod_account=$(aws sts get-caller-identity --profile keep-prod --query Account --output text)
  backup_account=$(aws sts get-caller-identity --profile keep-backup --query Account --output text)
  (cd rs && cargo build --release --locked --bin keep-snapshot -q)
  PATH=$PWD/rs/target/release:$PWD/scripts/ops:$PATH

  prefix=$ENV_NAME
  if [[ $ENV_NAME == staging ]]; then
    prefix=$(aws s3api list-objects-v2 --profile keep-prod --bucket "keep-litestream-$prod_account" \
      --prefix staging/ --delimiter / --query 'CommonPrefixes[].Prefix' --output text |
      tr '\t' '\n' | sort | tail -1)
    prefix=${prefix%/}
  fi
  WORK=$(mktemp -d "${TMPDIR:-/tmp}/keep-drill-$ENV_NAME.XXXXXX")
  chmod 700 "$WORK"
  [[ $KEEP_DATA == --keep ]] || trap 'rm -rf "$WORK"' EXIT
  pass=1
  echo "local restore drill: $ENV_NAME, $(date -u +%Y-%m-%dT%H:%MZ)"
  for source in litestream snapshot; do
    status=0
    if [[ $source == litestream ]]; then
      LITESTREAM_BUCKET=keep-litestream-$prod_account KEEP_ENV=$ENV_NAME KEEP_REPLICA_PREFIX=$prefix \
        LITESTREAM_ACCESS_KEY_ID=$(value AWS_ACCESS_KEY_ID <<<"$prod_creds") \
        LITESTREAM_SECRET_ACCESS_KEY=$(value AWS_SECRET_ACCESS_KEY <<<"$prod_creds") \
        LITESTREAM_SESSION_TOKEN=$(value AWS_SESSION_TOKEN <<<"$prod_creds") \
        restore.sh litestream "$WORK/$source" >"$WORK/$source.log" 2>&1 || status=$?
    else
      KEEP_SNAPSHOT_BUCKET=keep-snapshots-$backup_account KEEP_ENV=$ENV_NAME \
        KEEP_SNAPSHOT_ACCESS_KEY_ID=$(value AWS_ACCESS_KEY_ID <<<"$backup_creds") \
        KEEP_SNAPSHOT_SECRET_ACCESS_KEY=$(value AWS_SECRET_ACCESS_KEY <<<"$backup_creds") \
        KEEP_SNAPSHOT_SESSION_TOKEN=$(value AWS_SESSION_TOKEN <<<"$backup_creds") \
        restore.sh snapshot "$WORK/$source" >"$WORK/$source.log" 2>&1 || status=$?
    fi
    log=$WORK/$source.log
    secs=$(grep -o 'restore: all files [0-9.]*s' "$log" | grep -o '[0-9.]*s$' || echo '?')
    files=$(grep -c '^restore: ok ' "$log" || true)
    contacts=$(grep -o 'contacts=[0-9]*' "$log" | awk -F= '{ n += $2 } END { print n + 0 }')
    fast=yes
    awk -v t="${secs%s}" 'BEGIN { exit !(t != "?" && t < 60) }' || { fast=no; pass=0; }
    result=PASS
    ((status == 0)) || { result="FAIL (restore.sh exit $status)"; pass=0; }
    echo "  $source: $result, $files files, $contacts contacts, all files in $secs (< 60 s: $fast)"
  done
  if [[ -e $WORK/litestream/platform.db && -e $WORK/snapshot/platform.db ]]; then
    t() { sqlite3 -readonly "$1/platform.db" 'SELECT id FROM tenants ORDER BY id' | sha256sum; }
    if [[ $(t "$WORK/litestream") == "$(t "$WORK/snapshot")" ]]; then
      echo "  both sources list the same tenants"
    else
      echo "  the two sources list different tenants"
      pass=0
    fi
  fi
  [[ $KEEP_DATA == --keep ]] && echo "restored data kept in $WORK (delete it when done)"
  ((pass)) && echo PASS || { echo FAIL; exit 1; }
  exit 0
fi

APP=${APP:-keep-staging}
REGION=lhr
URL=${URL:-https://$APP.fly.dev}
SOURCES=${1:-both}
[[ $SOURCES == both ]] && SOURCES="litestream snapshot"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/keep-drill.XXXXXX")
RESULTS=$WORK/results.md
SET_SECRETS=() # secrets this run set, unset again on any exit

say() { printf '\n== %s\n' "$*"; }
run() { printf '+ %s\n' "$*" >&2; "$@"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
confirm() { local a; read -r -p "$1 [y/N] " a; [[ $a == [yY]* ]]; }

command -v fly >/dev/null || die "needs flyctl"
command -v node >/dev/null || die "needs node (the 10k generator)"
command -v jq >/dev/null || die "needs jq"
confirm "This destroys $APP's machine and volume (twice for both sources). Go on?" || exit 1

# Leave no drill secret behind, even when a step dies: unset at once (not
# --stage), so the next boot of a lost volume restores normally.
cleanup() {
  ((${#SET_SECRETS[@]})) || return 0
  printf '+ fly secrets unset -a %s %s\n' "$APP" "${SET_SECRETS[*]}" >&2
  fly secrets unset -a "$APP" "${SET_SECRETS[@]}" >/dev/null 2>&1 ||
    echo "WARNING: unset these secrets by hand: fly secrets unset -a $APP ${SET_SECRETS[*]}" >&2
  SET_SECRETS=()
}
trap cleanup EXIT
stage_secret() { # NAME=value
  run fly secrets set -a "$APP" --stage "$1"
  SET_SECRETS+=("${1%%=*}")
}

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
# A snapshot pass now, so the snapshot source has the seeded org.
run fly ssh console -a "$APP" -C "keep-snapshot run --data /data"

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
    # One committed row per line printed; runs until the hard stop.
    fly ssh console -a "$APP" -q -C "drill.sh marks" >"$marks" 2>/dev/null &
    loop_pid=$!
    sleep 15 # Litestream picks the new file up and replicates the stream
    stage_secret RESTORE_DRILL=1 # the restore puts the probe back too
  fi
  [[ $source == snapshot ]] && stage_secret KEEP_RESTORE_SOURCE=snapshot

  m=$(machine)
  v=$(volume)
  killed_ms=""
  if [[ $source == litestream ]]; then
    killed_ms=$(drill hard-stop | grep -E '^[0-9]+$' | tail -1)
    [[ -n $killed_ms ]] || die "hard-stop didn't report a kill time"
    kill "$loop_pid" 2>/dev/null || true
  fi
  run fly machine destroy "$m" -a "$APP" --force
  run fly volumes destroy "$v" -a "$APP" --yes
  run fly volumes create keep_data -a "$APP" --region "$REGION" --size 1 --yes >/dev/null

  started=$(date +%s)
  run fly deploy -c fly.staging.toml -a "$APP" --image "$IMAGE" --ha=false --yes
  wait_healthy
  boot=$(($(date +%s) - started))
  restore_line=$(fly logs -a "$APP" --no-tail 2>/dev/null | grep -o 'restore: all files [0-9.]*s' | tail -1 || true)
  restore_secs=${restore_line##* }

  census >"$WORK/after-$source.txt"
  if diff -u "$WORK/before.txt" "$WORK/after-$source.txt"; then counts=equal; else counts=DIFFERENT; pass=0; fi

  lost="n/a"
  if [[ $source == litestream ]]; then
    seen=$(tr -d '\r' <"$marks" | grep -cE '^[0-9]+ [0-9]+$' || true)
    read -r restored restored_ms < <(drill marks-max)
    lost_ms=$((killed_ms - ${restored_ms:-0}))
    ((lost_ms < 0)) && lost_ms=0
    lost="≤ ${lost_ms} ms (restored up to mark ${restored:-0}; $seen seen here)"
    ((lost_ms <= 1000)) || pass=0
    drill cleanup
  fi
  cleanup
  awk -v s="${restore_secs%s}" 'BEGIN { exit !(s != "" && s < 60) }' || pass=0
  echo "| $source | ${restore_secs:-?} | ${boot}s | $counts | $lost |" >>"$RESULTS"
done

say "4. Results"
cat "$RESULTS"
echo
echo "saved: $RESULTS (paste into docs/ops.md, Drill log)"
((pass)) && echo "PASS" || { echo "FAIL"; exit 1; }
