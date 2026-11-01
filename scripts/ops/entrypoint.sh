#!/bin/sh
# The image's entrypoint. In order:
#
# 1. Empty volume (no platform.db) and a backup configured: restore
#    everything first (restore.sh). This is how a lost machine or volume
#    comes back, and what the restore drill times.
#    - The source is KEEP_RESTORE_SOURCE if set (the drill), else
#      Litestream. When Litestream has no replica at all, the snapshots
#      are tried next, except on an environment reset on every deploy
#      (KEEP_RESET_ON=deploy), whose fresh per-deploy prefix is always
#      empty and whose snapshots belong to the previous deploy. That
#      fallback can lose up to an hour of writes, so it is loud: a log
#      line, and /data/.restored with fallback=true, which the api
#      reports to Sentry and /healthz until a human deletes it.
#    - Orgs that platform.db lists but no backup holds (restore.sh exit 4)
#      stop the boot, unless KEEP_RESTORE_ALLOW_MISSING=1 (docs/ops.md).
#    - Any other failure stops the boot: starting empty would have
#      Litestream replicate an empty platform.db over the real one.
# 2. KEEP_RESET_SEED set: wipe the data, so the api seeds it fresh, when
#    - KEEP_RESET_ON=deploy (the default): this is a new deploy
#      (FLY_IMAGE_REF differs from the one recorded in /data/.image);
#    - KEEP_RESET_ON=demand: KEEP_RESET_GENERATION differs from the one
#      recorded in /data/.generation (scripts/fly/staging-reset.sh sets
#      it). Deploys keep the data.
#    Restarts and restored volumes keep their data.
# 3. Create platform.db (WAL) if missing, so Litestream has it from the
#    first second, then run the api under `litestream replicate -exec`.
#    Without LITESTREAM_BUCKET (a local `docker run`) the api runs alone.
set -eu

DATA=${KEEP_DATA_DIR:-/data}
PLATFORM=$DATA/platform.db
IMAGE=${FLY_IMAGE_REF:-local}
RESET_ON=${KEEP_RESET_ON:-deploy}
log() { echo "entrypoint: $*" >&2; }

# Refused before anything is touched.
case $RESET_ON in
deploy | demand) ;;
*) log "KEEP_RESET_ON must be deploy or demand, not '$RESET_ON'"; exit 1 ;;
esac
if [ -n "${KEEP_RESET_SEED:-}" ] && [ "${KEEP_ENV:-}" = prod ]; then
  log "KEEP_RESET_SEED is refused when KEEP_ENV=prod"
  exit 1
fi
GENERATION=""
if [ "$RESET_ON" = demand ]; then
  [ -n "${KEEP_RESET_SEED:-}" ] || { log "KEEP_RESET_ON=demand needs KEEP_RESET_SEED (what a reset seeds)"; exit 1; }
  GENERATION=${KEEP_RESET_GENERATION:-}
  case $GENERATION in
  '' | *[!A-Za-z0-9_-]*)
    log "KEEP_RESET_ON=demand needs KEEP_RESET_GENERATION: letters, digits, _ and - only"
    exit 1
    ;;
  esac
elif [ -n "${KEEP_RESET_GENERATION:-}" ]; then
  log "KEEP_RESET_GENERATION is ignored: KEEP_RESET_ON is deploy"
fi

mkdir -p "$DATA/orgs" "$DATA/files" "$DATA/drill"

# Where Litestream replicates (litestream.yml) and restores from. A reset
# environment gets a fresh prefix per generation (per deploy under
# KEEP_RESET_ON=deploy, per KEEP_RESET_GENERATION under demand), so a wiped
# database never meets its predecessor's replica (Litestream would see a
# replica ahead of a brand-new file); the same generation on a new volume
# finds it again.
if [ -n "$GENERATION" ]; then
  KEEP_REPLICA_PREFIX=${KEEP_ENV:?}/$GENERATION
elif [ -n "${KEEP_RESET_SEED:-}" ]; then
  generation=$(printf '%s' "${IMAGE##*:}" | tr -c 'A-Za-z0-9_-' '-')
  KEEP_REPLICA_PREFIX=${KEEP_ENV:?}/$generation
else
  KEEP_REPLICA_PREFIX=${KEEP_ENV:?KEEP_ENV is required}
fi
export KEEP_REPLICA_PREFIX

# Move a finished restore from $DATA/restoring into place, and record how
# it went in $DATA/.restored (read by the api: Sentry and /healthz).
put_in_place() { # source fallback missing
  set -- "$1" "$2" "$3"
  for f in "$DATA"/restoring/orgs/*.db; do
    [ -e "$f" ] || continue # no orgs: the glob stayed literal
    mv "$f" "$DATA/orgs/"
  done
  for f in "$DATA"/restoring/files/*.db; do
    [ -e "$f" ] || continue # no files dbs: the glob stayed literal
    mv "$f" "$DATA/files/"
  done
  if [ -e "$DATA/restoring/drill/marks.db" ]; then
    mv "$DATA/restoring/drill/marks.db" "$DATA/drill/"
  fi
  mv "$DATA/restoring/platform.db" "$PLATFORM"
  rm -rf "$DATA/restoring"
  printf '{"source":"%s","fallback":%s,"missingOrgs":%s,"at":"%s"}\n' \
    "$1" "$2" "$3" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$DATA/.restored"
  echo "$IMAGE" >"$DATA/.image"
  # Restored from this generation's prefix: the data belongs to it.
  [ -z "$GENERATION" ] || echo "$GENERATION" >"$DATA/.generation"
}

if [ ! -e "$PLATFORM" ] && [ -n "${LITESTREAM_BUCKET:-}${KEEP_SNAPSHOT_BUCKET:-}" ]; then
  if [ -n "${KEEP_RESTORE_SOURCE:-}" ]; then
    sources=$KEEP_RESTORE_SOURCE
  else
    sources=""
    [ -z "${LITESTREAM_BUCKET:-}" ] || sources=litestream
    if [ -n "${KEEP_SNAPSHOT_BUCKET:-}" ] && { [ -z "${KEEP_RESET_SEED:-}" ] || [ "$RESET_ON" = demand ]; }; then
      sources="$sources snapshot"
    fi
  fi
  restored=""
  tried=""
  for source in $sources; do
    log "empty volume: restoring from $source"
    rm -rf "$DATA/restoring"
    status=0
    restore.sh "$source" "$DATA/restoring" >"$DATA/restore.log" 2>&1 || status=$?
    cat "$DATA/restore.log" >&2
    fallback=false
    [ -z "$tried" ] || fallback=true
    case $status in
    0)
      put_in_place "$source" "$fallback" 0
      restored=$source
      break
      ;;
    3)
      rm -rf "$DATA/restoring"
      log "no backup in $source"
      tried="$tried $source"
      ;;
    4)
      missing=$(grep -c '^MISSING org ' "$DATA/restore.log" || true)
      if [ "${KEEP_RESTORE_ALLOW_MISSING:-}" = 1 ]; then
        log "restored from $source WITHOUT $missing org(s) (KEEP_RESTORE_ALLOW_MISSING=1)"
        put_in_place "$source" "$fallback" "$missing"
        restored=$source
        break
      fi
      log "restore from $source is missing $missing org(s); not starting." \
        "Boot without them: set KEEP_RESTORE_ALLOW_MISSING=1 (docs/ops.md)"
      exit 1
      ;;
    *)
      log "restore from $source failed ($status); not starting"
      exit 1
      ;;
    esac
  done
  if [ -n "$restored" ] && [ -n "$tried" ]; then
    log "FALLBACK: restored from $restored because$tried had no backup;" \
      "up to an hour of writes may be missing. Check, then delete $DATA/.restored"
  fi
  [ -n "$restored" ] || log "nothing to restore; starting empty"
fi

wipe() {
  # Litestream's own state for platform.db goes too: kept beside a new
  # file, it points at LTX files the old one wrote and replication stops
  # ("open ltx file … no such file"). The orgs', files' and drill's are
  # inside their directories.
  rm -rf "$PLATFORM" "$PLATFORM-wal" "$PLATFORM-shm" "$DATA/.platform.db-litestream" \
    "$DATA/orgs" "$DATA/files" "$DATA/drill" "$DATA/snapshots-tmp" "$DATA/.restored"
  mkdir -p "$DATA/orgs" "$DATA/files" "$DATA/drill"
}

if [ "$RESET_ON" = demand ]; then
  if [ "$(cat "$DATA/.generation" 2>/dev/null || true)" != "$GENERATION" ]; then
    log "new reset generation ($GENERATION): wiping $DATA for the $KEEP_RESET_SEED seed"
    wipe
    echo "$GENERATION" >"$DATA/.generation"
  fi
elif [ -n "${KEEP_RESET_SEED:-}" ]; then
  if [ "$(cat "$DATA/.image" 2>/dev/null || true)" != "$IMAGE" ]; then
    log "new deploy ($IMAGE): wiping $DATA for the $KEEP_RESET_SEED seed"
    wipe
    echo "$IMAGE" >"$DATA/.image"
  fi
fi

[ -e "$PLATFORM" ] || sqlite3 "$PLATFORM" 'PRAGMA journal_mode=WAL;' >/dev/null

if [ -z "${LITESTREAM_BUCKET:-}" ]; then
  log "LITESTREAM_BUCKET unset: running the api without replication"
  exec api
fi
exec litestream replicate -config /etc/litestream.yml -exec api
