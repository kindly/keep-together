#!/usr/bin/env bash
# Put org files back as they were before a boot migration.
#
# At boot the api copies every org file it is about to migrate to
# <data>/premigrate/<tenant-id>.v<from>.db (VACUUM INTO) and then migrates
# it. Rolling a release back = deploy the previous image AND put these
# copies back, because the old code refuses a file whose schema is newer
# than it knows.
#
#   scripts/ops/rollback-migration.sh <data-dir> <from-version>           # dry run
#   scripts/ops/rollback-migration.sh <data-dir> <from-version> --apply
#
# <from-version> is the org schema version the previous release ran (the
# `v<N>` in the copies' names). Only copies at that version are restored.
# STOP THE API FIRST: the files must not be open. Writes made after the
# migration are lost for every org restored (that is what a rollback is);
# the replaced files are kept as <id>.db.rolled-back-<utc> beside them.
set -euo pipefail

data="${1:?usage: $0 <data-dir> <from-version> [--apply]}"
from="${2:?usage: $0 <data-dir> <from-version> [--apply]}"
apply="${3:-}"
[[ "$from" =~ ^[0-9]+$ ]] || { echo "from-version must be a number" >&2; exit 2; }

premigrate="$data/premigrate"
orgs="$data/orgs"
[[ -d "$premigrate" ]] || { echo "no $premigrate: nothing was migrated" >&2; exit 1; }

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
shopt -s nullglob
copies=("$premigrate"/*.v"$from".db)
if (( ${#copies[@]} == 0 )); then
  echo "no copies at v$from in $premigrate" >&2
  exit 1
fi

for copy in "${copies[@]}"; do
  name="$(basename "$copy")"
  id="${name%.v$from.db}"
  [[ "$id" =~ ^[0-9a-f]{32}$ ]] || { echo "skip $name: not a tenant id" >&2; continue; }
  target="$orgs/$id.db"
  echo "+ $copy -> $target"
  if [[ "$apply" == "--apply" ]]; then
    if [[ -e "$target" ]]; then
      mv "$target" "$target.rolled-back-$stamp"
      rm -f "$target-wal" "$target-shm"
    fi
    cp "$copy" "$target"
    if command -v sqlite3 >/dev/null; then
      sqlite3 "$target" "PRAGMA integrity_check;" | grep -qx ok \
        || { echo "integrity check failed on $target" >&2; exit 1; }
    fi
  fi
done

if [[ "$apply" != "--apply" ]]; then
  echo "dry run: re-run with --apply (API stopped) to restore ${#copies[@]} file(s)"
fi
