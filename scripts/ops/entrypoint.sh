#!/bin/sh
# The image's entrypoint. In order:
#
# 1. Empty volume (no platform.db) and a backup configured: restore
#    everything first (restore.sh), from Litestream, or from the hourly
#    snapshots when KEEP_RESTORE_SOURCE=snapshot. This is how a lost
#    machine or volume comes back, and what the restore drill times.
# 2. KEEP_RESET_SEED set and this is a new deploy (FLY_IMAGE_REF differs
#    from the one recorded in /data/.image): wipe the data, so the api
#    seeds it fresh. Restarts and restored volumes keep their data.
# 3. Create platform.db (WAL) if missing, so Litestream has it from the
#    first second, then run the api under `litestream replicate -exec`.
#    Without LITESTREAM_BUCKET (a local `docker run`) the api runs alone.
set -eu

DATA=${KEEP_DATA_DIR:-/data}
PLATFORM=$DATA/platform.db
IMAGE=${FLY_IMAGE_REF:-local}
log() { echo "entrypoint: $*" >&2; }

mkdir -p "$DATA/orgs"

# Where Litestream replicates (litestream.yml) and restores from. A reset
# environment gets a fresh prefix per deploy, so a wiped database never
# meets its predecessor's replica (Litestream would see a replica ahead of
# a brand-new file); the same image on a new volume finds it again.
if [ -n "${KEEP_RESET_SEED:-}" ]; then
  generation=$(printf '%s' "${IMAGE##*:}" | tr -c 'A-Za-z0-9_-' '-')
  KEEP_REPLICA_PREFIX=${KEEP_ENV:?}/$generation
else
  KEEP_REPLICA_PREFIX=${KEEP_ENV:?KEEP_ENV is required}
fi
export KEEP_REPLICA_PREFIX

if [ ! -e "$PLATFORM" ] && [ -n "${LITESTREAM_BUCKET:-}${KEEP_SNAPSHOT_BUCKET:-}" ]; then
  # Sources in order: KEEP_RESTORE_SOURCE if set (the drill), else
  # Litestream, then the snapshots when Litestream has nothing.
  sources=${KEEP_RESTORE_SOURCE:-}
  if [ -z "$sources" ]; then
    [ -z "${LITESTREAM_BUCKET:-}" ] || sources=litestream
    [ -z "${KEEP_SNAPSHOT_BUCKET:-}" ] || sources="$sources snapshot"
  fi
  # Only "no backup exists" (exit 3) moves on to the next source, or
  # starts empty after the last. Any other failure (bad credentials, a
  # corrupt file) stops the boot: starting empty would have Litestream
  # replicate an empty platform.db over the real one. restore.sh writes
  # into $DATA/restoring, and the files move into place only when every
  # one is back and checked, so a failed attempt leaves the volume empty
  # and the next boot tries again.
  restored=""
  for source in $sources; do
    log "empty volume: restoring from $source"
    rm -rf "$DATA/restoring"
    status=0
    restore.sh "$source" "$DATA/restoring" || status=$?
    case $status in
    0)
      mv "$DATA"/restoring/orgs/* "$DATA/orgs/" 2>/dev/null || true
      mv "$DATA/restoring/platform.db" "$PLATFORM"
      rm -rf "$DATA/restoring"
      echo "$IMAGE" >"$DATA/.image"
      restored=$source
      break
      ;;
    3)
      rm -rf "$DATA/restoring"
      log "no backup in $source"
      ;;
    *)
      log "restore from $source failed ($status); not starting"
      exit 1
      ;;
    esac
  done
  [ -n "$restored" ] || log "nothing to restore; starting empty"
fi

if [ -n "${KEEP_RESET_SEED:-}" ]; then
  [ "${KEEP_ENV:-}" != prod ] || { log "KEEP_RESET_SEED is refused when KEEP_ENV=prod"; exit 1; }
  if [ "$(cat "$DATA/.image" 2>/dev/null || true)" != "$IMAGE" ]; then
    log "new deploy ($IMAGE): wiping $DATA for the $KEEP_RESET_SEED seed"
    rm -rf "$PLATFORM" "$PLATFORM-wal" "$PLATFORM-shm" "$DATA/orgs" "$DATA/snapshots-tmp"
    mkdir -p "$DATA/orgs"
    echo "$IMAGE" >"$DATA/.image"
  fi
fi

[ -e "$PLATFORM" ] || sqlite3 "$PLATFORM" 'PRAGMA journal_mode=WAL;' >/dev/null

if [ -z "${LITESTREAM_BUCKET:-}" ]; then
  log "LITESTREAM_BUCKET unset: running the api without replication"
  exec api
fi
exec litestream replicate -config /etc/litestream.yml -exec api
