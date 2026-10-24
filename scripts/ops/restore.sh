#!/bin/sh
# restore.sh litestream|snapshot <data-dir>
#
# Put platform.db and every org it lists back into an empty data dir,
# rotate each org's recovery generation, then check each file (PRAGMA
# integrity_check) and print its row counts.
# Timings go to stdout as `restore: <what> <seconds>s`, which the drill
# records.
#
# litestream: platform.db first (its replica in the Litestream bucket),
#   then each org listed in its `tenants` table, 4 at a time. Litestream
#   0.5 can't restore a whole `dir` in one command, hence the loop.
#   Needs LITESTREAM_BUCKET, LITESTREAM_ACCESS_KEY_ID,
#   LITESTREAM_SECRET_ACCESS_KEY and KEEP_REPLICA_PREFIX (the entrypoint
#   sets it; KEEP_ENV when unset). LITESTREAM_BUCKET=file:///dir reads a
#   local replica instead (trying it out without S3).
#   RESTORE_DRILL=1 also restores drill/marks.db, the drill's write-loss
#   probe.
# snapshot: the newest good hourly/daily/monthly snapshot of each file
#   (`keep-snapshot restore`, KEEP_SNAPSHOT_* settings).
#
# Exit 0: everything restored and checked. Exit 3: no backup to restore
# from (an environment that never had data). Exit 4: restored and checked,
# but some orgs platform.db lists had no backup (printed as `MISSING org
# <id>`). Anything else: failure.
set -eu

source=${1:?usage: restore.sh litestream|snapshot <data-dir>}
DATA=${2:?usage: restore.sh litestream|snapshot <data-dir>}
ENV_NAME=${KEEP_ENV:?KEEP_ENV is required}

[ ! -e "$DATA/platform.db" ] || { echo "restore: $DATA/platform.db exists; restore only into an empty dir" >&2; exit 1; }
mkdir -p "$DATA/orgs"
now() { date +%s.%N; }
secs() { awk -v a="$1" -v b="$(now)" 'BEGIN { printf "%.1f", b - a }'; }
started=$(now)

case $source in
litestream)
  : "${LITESTREAM_BUCKET:?}"
  case $LITESTREAM_BUCKET in
  file://*) # a local replica directory (trying this out without S3)
    replica=$LITESTREAM_BUCKET/${KEEP_REPLICA_PREFIX:-$ENV_NAME}
    ;;
  *)
    : "${LITESTREAM_ACCESS_KEY_ID:?}" "${LITESTREAM_SECRET_ACCESS_KEY:?}"
    export AWS_ACCESS_KEY_ID=$LITESTREAM_ACCESS_KEY_ID
    export AWS_SECRET_ACCESS_KEY=$LITESTREAM_SECRET_ACCESS_KEY
    export AWS_REGION=${LITESTREAM_REGION:-eu-west-2}
    # Temporary credentials (a human's SSO profile, for a local drill).
    [ -z "${LITESTREAM_SESSION_TOKEN:-}" ] || export AWS_SESSION_TOKEN=$LITESTREAM_SESSION_TOKEN
    replica=s3://$LITESTREAM_BUCKET/${KEEP_REPLICA_PREFIX:-$ENV_NAME}
    ;;
  esac
  litestream restore -if-replica-exists -o "$DATA/platform.db" "$replica/platform.db"
  if [ ! -e "$DATA/platform.db" ]; then
    echo "restore: no platform.db replica at $replica" >&2
    exit 3
  fi
  echo "restore: platform.db $(secs "$started")s"
  ids=$(sqlite3 -readonly "$DATA/platform.db" 'SELECT id FROM tenants')
  # Ids are 32 hex chars, so word splitting is safe. A missing replica
  # (an org created in the last second) is reported below, not fatal here.
  # shellcheck disable=SC2086
  printf '%s\n' $ids | grep -v '^$' |
    xargs -r -P 4 -I{} litestream restore -if-replica-exists -o "$DATA/orgs/{}.db" "$replica/orgs/{}.db"
  for id in $ids; do
    [ -e "$DATA/orgs/$id.db" ] || echo "MISSING org $id: no replica"
  done
  if [ "${RESTORE_DRILL:-}" = 1 ]; then
    mkdir -p "$DATA/drill"
    litestream restore -if-replica-exists -o "$DATA/drill/marks.db" "$replica/drill/marks.db"
  fi
  ;;
snapshot)
  status=0
  out=$(keep-snapshot restore --data "$DATA" 2>&1) || status=$?
  echo "$out"
  case $status in
  0 | 4) ;; # 4: MISSING lines, counted below
  *)
    case $out in *"no platform snapshot"*) exit 3 ;; esac
    exit 1
    ;;
  esac
  ;;
*)
  echo "restore: unknown source $source" >&2
  exit 2
  ;;
esac
echo "restore: all files $(secs "$started")s"

# A new recovery generation in every org file (rs/crates/api/src/events.rs):
# a tab's event cursor from before names the old one, so the stream resets
# it instead of replaying from a seq this history reuses. A file from
# before the table existed gets a fresh one when it migrates.
for db in "$DATA"/orgs/*.db; do
  [ -e "$db" ] || continue
  if [ "$(sqlite3 "$db" "SELECT count(*) FROM sqlite_master WHERE name = 'recovery'")" = 1 ]; then
    sqlite3 "$db" "UPDATE recovery SET generation = lower(hex(randomblob(16)))"
  fi
done

# Checks: every restored file is intact; row counts for the record.
fail=0
for db in "$DATA/platform.db" "$DATA"/orgs/*.db "$DATA"/drill/*.db; do
  [ -e "$db" ] || continue
  check=$(sqlite3 -readonly "$db" 'PRAGMA integrity_check' 2>&1 | head -1)
  if [ "$check" != ok ]; then
    echo "restore: $db integrity_check: $check" >&2
    fail=1
    continue
  fi
  case $db in
  */platform.db) counts=$(sqlite3 -readonly "$db" "SELECT 'tenants=' || count(*) FROM tenants") ;;
  */drill/marks.db) counts=$(sqlite3 -readonly "$db" "SELECT 'marks=' || count(*) || ' max=' || coalesce(max(i), 0) FROM marks") ;;
  *) counts=$(sqlite3 -readonly "$db" "SELECT 'contacts=' || count(*) FROM contacts; SELECT 'revisions=' || count(*) FROM revisions" | tr '\n' ' ') ;;
  esac
  echo "restore: ok $(basename "$db") $counts"
done
echo "restore: checked $(secs "$started")s"
[ "$fail" = 0 ] || exit 1
missing=0
for id in $(sqlite3 -readonly "$DATA/platform.db" 'SELECT id FROM tenants'); do
  [ -e "$DATA/orgs/$id.db" ] || missing=$((missing + 1))
done
if [ "$missing" -gt 0 ]; then
  echo "restore: $missing org(s) missing" >&2
  exit 4
fi
