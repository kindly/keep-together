#!/bin/sh
# restore.sh litestream|snapshot <data-dir>
#
# Put platform.db and every org it lists back into an empty data dir, then
# check each file (PRAGMA integrity_check) and print its row counts.
# Timings go to stdout as `restore: <what> <seconds>s`, which the drill
# records.
#
# litestream: platform.db first (its replica in the Litestream bucket),
#   then each org listed in its `tenants` table, 4 at a time. Litestream
#   0.5 can't restore a whole `dir` in one command, hence the loop.
#   Needs LITESTREAM_BUCKET, LITESTREAM_ACCESS_KEY_ID,
#   LITESTREAM_SECRET_ACCESS_KEY and KEEP_REPLICA_PREFIX (the entrypoint
#   sets it; KEEP_ENV when unset).
#   RESTORE_EXTRA names other files under orgs/ to restore (the drill's
#   write-loss marker file).
# snapshot: the newest hourly/daily/monthly snapshot of each file
#   (`keep-snapshot restore`, KEEP_SNAPSHOT_* settings).
#
# Exit 0: everything restored and checked. Exit 3: no backup to restore
# from (an environment that never had data). Anything else: failure.
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
  # Each name is 32 hex chars (or a fixed RESTORE_EXTRA name), so word
  # splitting is safe.
  # shellcheck disable=SC2086
  printf '%s\n' $ids ${RESTORE_EXTRA:-} | grep -v '^$' |
    xargs -r -P 4 -I{} litestream restore -o "$DATA/orgs/{}.db" "$replica/orgs/{}.db"
  ;;
snapshot)
  if ! out=$(keep-snapshot restore --data "$DATA" 2>&1); then
    echo "$out" >&2
    case $out in *"no platform snapshot"*) exit 3 ;; esac
    exit 1
  fi
  echo "$out"
  ;;
*)
  echo "restore: unknown source $source" >&2
  exit 2
  ;;
esac
echo "restore: all files $(secs "$started")s"

# Checks: every restored file is intact; row counts for the record.
fail=0
for db in "$DATA/platform.db" "$DATA"/orgs/*.db; do
  [ -e "$db" ] || continue
  check=$(sqlite3 -readonly "$db" 'PRAGMA integrity_check' 2>&1 | head -1)
  if [ "$check" != ok ]; then
    echo "restore: $db integrity_check: $check" >&2
    fail=1
    continue
  fi
  case $db in
  */platform.db) counts=$(sqlite3 -readonly "$db" "SELECT 'tenants=' || count(*) FROM tenants") ;;
  */drill-marks.db) counts=$(sqlite3 -readonly "$db" "SELECT 'marks=' || count(*) || ' max=' || coalesce(max(i), 0) FROM marks") ;;
  *) counts=$(sqlite3 -readonly "$db" "SELECT 'contacts=' || count(*) FROM contacts; SELECT 'revisions=' || count(*) FROM revisions" | tr '\n' ' ') ;;
  esac
  echo "restore: ok $(basename "$db") $counts"
done
echo "restore: checked $(secs "$started")s"
exit $fail
