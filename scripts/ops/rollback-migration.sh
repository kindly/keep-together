#!/usr/bin/env bash
# Put a data directory back as it was before the last boot that migrated.
#
# Before migrating, the api copies every file it is about to migrate
# (`platform.db` and each org file) into one directory per boot,
# <data>/premigrate/boot-<ms>/<name>.v<from>.db, with a `manifest` of the
# org files that existed at that boot. Rolling a release back = deploy the
# previous image AND run this, because the old code refuses any file whose
# schema is newer than it knows:
#
#   scripts/ops/rollback-migration.sh <data-dir>            # dry run
#   scripts/ops/rollback-migration.sh <data-dir> --apply
#
# It restores every copy in the newest boot directory, and sets aside org
# files the manifest doesn't list (made at the new schema after the boot;
# their tenants' rows are gone with the restored platform.db anyway).
# STOP THE API FIRST: the files must not be open. Writes made since that
# boot are lost for every restored file (that is what a rollback is); each
# replaced or set-aside file, with its -wal and -shm, is kept beside it as
# <file>.rolled-back-<utc>[-wal|-shm]. Nothing is deleted.
set -euo pipefail

data="${1:?usage: $0 <data-dir> [--apply]}"
apply="${2:-}"
premigrate="$data/premigrate"
orgs="$data/orgs"

shopt -s nullglob
boots=("$premigrate"/boot-*/)
if (( ${#boots[@]} == 0 )); then
  echo "no boot copies in $premigrate: nothing was migrated" >&2
  exit 1
fi
boot="${boots[-1]%/}"
manifest="$boot/manifest"
[[ -f "$manifest" ]] || { echo "$boot has no manifest" >&2; exit 1; }
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
echo "boot copies: $boot"

run() {
  echo "+ $*"
  if [[ "$apply" == "--apply" ]]; then "$@"; fi
}

# Move a database and its -wal/-shm aside (the WAL may hold its last commits).
set_aside() {
  local file="$1"
  for suffix in "" -wal -shm; do
    if [[ -e "$file$suffix" ]]; then
      run mv "$file$suffix" "$file.rolled-back-$stamp$suffix"
    fi
  done
}

restore() {
  local copy="$1" target="$2"
  set_aside "$target"
  run cp "$copy" "$target"
  if [[ "$apply" == "--apply" ]] && command -v sqlite3 >/dev/null; then
    sqlite3 "$target" "PRAGMA integrity_check;" | grep -qx ok \
      || { echo "integrity check failed on $target" >&2; exit 1; }
  fi
}

# An org file put back gets a new recovery generation
# (rs/crates/api/src/events.rs), so a tab's event cursor from the history
# rolled back resets instead of replaying from a reused seq. A copy from
# before the table existed gets a fresh one when it next migrates.
rotate_generation() {
  local target="$1"
  echo "+ new recovery generation in $target"
  [[ "$apply" == "--apply" ]] || return 0
  command -v sqlite3 >/dev/null \
    || { echo "sqlite3 is needed to rotate $target's recovery generation" >&2; exit 1; }
  if [[ $(sqlite3 "$target" "SELECT count(*) FROM sqlite_master WHERE name = 'recovery'") == 1 ]]; then
    sqlite3 "$target" "UPDATE recovery SET generation = lower(hex(randomblob(16)))"
  fi
}

for copy in "$boot"/*.v*.db; do
  name="$(basename "$copy")"
  stem="${name%.v*.db}"
  if [[ "$stem" == platform ]]; then
    restore "$copy" "$data/platform.db"
  elif [[ "$stem" =~ ^[0-9a-f]{32}$ ]]; then
    restore "$copy" "$orgs/$stem.db"
    rotate_generation "$orgs/$stem.db"
  else
    echo "skip $name: not platform or a tenant id" >&2
  fi
done

# Org files created after that boot: at the new schema, unknown to the
# restored platform.db.
for file in "$orgs"/*.db; do
  if ! grep -qxF "$(basename "$file")" "$manifest"; then
    echo "created after the boot: $(basename "$file")"
    set_aside "$file"
  fi
done

if [[ "$apply" != "--apply" ]]; then
  echo "dry run: re-run with --apply (API stopped)"
fi
