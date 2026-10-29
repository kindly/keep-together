#!/bin/sh
# drill.sh <command>: the restore drill's helpers inside the machine
# (scripts/ops/restore-drill.sh calls them over `fly ssh console -C`, so no
# SQL has to survive two layers of quoting). Read-only except `marks` and
# `cleanup`.
#
#   census        one "<key> <value>" line per fact, sorted: tenants; per
#                 org (by slug) contacts, revisions, the match count of a
#                 few search terms (FTS), and its files db's blobs and
#                 bytes and the hash of its keys (0 when it has none). The
#                 drill diffs it, so a restore must bring both files back.
#   has-org SLUG  prints 1 if the org exists, else 0.
#   marks         the write-loss probe: commits one row at a time to
#                 drill/marks.db (Litestream replicates drill/ like orgs/;
#                 the api and the snapshot job never look there) and prints
#                 "<n> <epoch ms>" after each commit, until killed.
#   hard-stop     the crash: print the kill time (epoch ms, this machine's
#                 clock, the same as the marks), then SIGKILL Litestream,
#                 the api and the marks loop at once, then delete the data
#                 if still alive (best effort: init may take the VM, and
#                 this session, down first). The drill sets the machine to
#                 `--restart no` beforehand, so nothing comes back up to
#                 ship what wasn't replicated.
#   marks-max     "<n> <ms>" of the last restored mark.
#   cleanup       removes drill/marks.db and the uploaded JSONL.
set -eu
DATA=${KEEP_DATA_DIR:-/data}
MARKS=$DATA/drill/marks.db
TERMS="smith gmail jo* london 07700"
q() { sqlite3 -readonly "$@"; }

case ${1:-} in
census)
  {
    echo "tenants $(q "$DATA/platform.db" 'SELECT count(*) FROM tenants')"
    q -separator ' ' "$DATA/platform.db" 'SELECT id, slug FROM tenants' |
      while read -r id slug; do
        f=$DATA/orgs/$id.db
        echo "$slug.contacts $(q "$f" 'SELECT count(*) FROM contacts')"
        echo "$slug.revisions $(q "$f" 'SELECT count(*) FROM revisions')"
        for t in $TERMS; do
          echo "$slug.search.$t $(q "$f" "SELECT count(*) FROM contact_search_words WHERE contact_search_words MATCH '$t'")"
        done
        files=$DATA/files/$id.db
        if [ -e "$files" ]; then
          echo "$slug.files.blobs $(q "$files" 'SELECT count(*) FROM blobs')"
          echo "$slug.files.bytes $(q "$files" 'SELECT coalesce(sum(size), 0) FROM blobs')"
          echo "$slug.files.keys $(q "$files" 'SELECT sha256 FROM blobs ORDER BY sha256' | sha256sum | cut -c1-16)"
        else
          echo "$slug.files.blobs 0"
        fi
      done
  } | sort
  ;;
has-org)
  slug=$(printf '%s' "${2:?slug}" | tr -cd 'a-z0-9-')
  q "$DATA/platform.db" "SELECT count(*) FROM tenants WHERE slug = '$slug'"
  ;;
marks)
  mkdir -p "$DATA/drill"
  sqlite3 "$MARKS" 'PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS marks (i INTEGER PRIMARY KEY, at_ms INTEGER NOT NULL); DELETE FROM marks;' >/dev/null
  i=0
  while :; do
    i=$((i + 1))
    ms=$(date +%s%3N)
    sqlite3 "$MARKS" "INSERT INTO marks VALUES ($i, $ms)"
    echo "$i $ms"
  done
  ;;
hard-stop)
  pids=""
  for d in /proc/[0-9]*; do
    # A process may exit mid-scan: read through cat, errors dropped.
    cmd=$(cat "$d/cmdline" 2>/dev/null | tr '\0' ' ') || cmd=""
    case $cmd in
    litestream\ replicate* | api | api\ * | */api | */api\ * | *drill.sh\ marks*) pids="$pids ${d#/proc/}" ;;
    esac
  done
  [ -n "$pids" ] || { echo "hard-stop: nothing to kill" >&2; exit 1; }
  # The time goes out first: the kill may end this session with the VM.
  date +%s%3N
  # shellcheck disable=SC2086
  kill -9 $pids
  rm -rf "$DATA"/platform.db* "$DATA/orgs" "$DATA/files" "$DATA/drill" 2>/dev/null || true
  ;;
marks-max)
  q -separator ' ' "$MARKS" 'SELECT coalesce(max(i), 0), coalesce(max(at_ms), 0) FROM marks'
  ;;
cleanup)
  rm -f "$MARKS" "$MARKS-wal" "$MARKS-shm" "$DATA/drill.jsonl"
  ;;
*)
  echo "usage: drill.sh census|has-org SLUG|marks|hard-stop|marks-max|cleanup" >&2
  exit 2
  ;;
esac
