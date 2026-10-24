#!/bin/sh
# drill.sh <command>: the restore drill's helpers inside the machine
# (scripts/ops/restore-drill.sh calls them over `fly ssh console -C`, so no
# SQL has to survive two layers of quoting). Read-only except `marks` and
# `cleanup`.
#
#   census        one "<key> <value>" line per fact, sorted: tenants; per
#                 org (by slug) contacts, revisions, and the match count
#                 of a few search terms (FTS). The drill diffs it.
#   has-org SLUG  prints 1 if the org exists, else 0.
#   marks         the write-loss probe: commits one row at a time to
#                 drill/marks.db (Litestream replicates drill/ like orgs/;
#                 the api and the snapshot job never look there) and prints
#                 "<n> <epoch ms>" after each commit, until killed.
#   hard-stop     the crash: SIGKILL Litestream, the api and the marks loop
#                 at once, then delete the data (the volume is lost anyway),
#                 so nothing unreplicated can be shipped by a restart. Prints
#                 the kill time in epoch ms, by this machine's clock (the
#                 same clock as the marks).
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
  ms=$(date +%s%3N)
  # shellcheck disable=SC2086
  kill -9 $pids
  rm -rf "$DATA"/platform.db* "$DATA/orgs" "$DATA/drill"
  echo "$ms"
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
