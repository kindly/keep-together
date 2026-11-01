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
#    - KEEP_RESET_ON=demand: KEEP_RESET_GENERATION (a Fly secret that
#      scripts/fly/staging-reset.sh sets) differs from the one recorded
#      in /data/.generation, or an earlier wipe didn't finish. Deploys
#      keep the data. This is decided before step 1: a reset never
#      restores.
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
# Only named environments reset: a misspelled prod (Prod, production) is
# refused here, before the api would refuse it, and never wiped.
if [ -n "${KEEP_RESET_SEED:-}" ]; then
  case ${KEEP_ENV:-} in
  staging | dev) ;;
  *)
    log "KEEP_RESET_SEED is refused when KEEP_ENV=${KEEP_ENV:-} (only staging or dev reset)"
    exit 1
    ;;
  esac
fi
GENERATION=""
if [ "$RESET_ON" = demand ]; then
  [ -n "${KEEP_RESET_SEED:-}" ] || { log "KEEP_RESET_ON=demand needs KEEP_RESET_SEED (what a reset seeds)"; exit 1; }
  # A Fly secret, set only by scripts/fly/staging-reset.sh, never in the
  # toml's [env] (docs/ops.md "Staging reset"). The same rule as
  # /healthz's resetGeneration (api::reset::generation).
  GENERATION=${KEEP_RESET_GENERATION:-}
  case $GENERATION in
  '' | *[!A-Za-z0-9_-]*) bad=1 ;;
  *) bad="" ;;
  esac
  if [ -n "$bad" ] || [ "${#GENERATION}" -gt 64 ]; then
    log "KEEP_RESET_ON=demand needs KEEP_RESET_GENERATION: 1 to 64 letters, digits, _ and -"
    exit 1
  fi
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

WIPING=$DATA/.wiping

wipe() {
  # Litestream's own state for platform.db goes too: kept beside a new
  # file, it points at LTX files the old one wrote and replication stops
  # ("open ltx file … no such file"). The orgs', files' and drill's are
  # inside their directories. The generation marker goes too: the data it
  # named is gone.
  rm -rf "$PLATFORM" "$PLATFORM-wal" "$PLATFORM-shm" "$DATA/.platform.db-litestream" \
    "$DATA/orgs" "$DATA/files" "$DATA/drill" "$DATA/snapshots-tmp" "$DATA/.restored" \
    "$DATA/.generation"
  mkdir -p "$DATA/orgs" "$DATA/files" "$DATA/drill"
}

# KEEP_RESET_ON=demand: decided before the restore below, because a
# changed generation has nothing to restore (its prefix is new) and a
# half-wiped volume must never be "restored" from the snapshots of the
# data it was asked to drop. The wipe is crash-safe: $WIPING is written
# first and removed last, so a boot that finds it finishes the wipe.
RESET_NOW=""
if [ "$RESET_ON" = demand ]; then
  if [ -e "$WIPING" ]; then
    log "an earlier wipe didn't finish: wiping $DATA again for generation $GENERATION"
    RESET_NOW=1
  elif [ -e "$DATA/.generation" ]; then
    current=$(cat "$DATA/.generation") || {
      log "can't read $DATA/.generation; not starting (nothing was wiped)"
      exit 1
    }
    if [ "$current" != "$GENERATION" ]; then
      log "new reset generation ($GENERATION): wiping $DATA for the $KEEP_RESET_SEED seed"
      RESET_NOW=1
    fi
  elif [ -e "$PLATFORM" ]; then
    log "no reset generation recorded (the switch from KEEP_RESET_ON=deploy):" \
      "wiping $DATA for generation $GENERATION"
    RESET_NOW=1
  fi
  # Otherwise an empty volume: restored below from this generation.
  if [ -n "$RESET_NOW" ]; then
    echo "$GENERATION" >"$WIPING"
    wipe
    echo "$GENERATION" >"$DATA/.generation"
    rm -f "$WIPING"
  fi
fi

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

if [ -z "$RESET_NOW" ] && [ ! -e "$PLATFORM" ] && [ -n "${LITESTREAM_BUCKET:-}${KEEP_SNAPSHOT_BUCKET:-}" ]; then
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

# demand: a volume that started empty (nothing to restore, or no backups)
# belongs to this generation; a restore marked it in put_in_place.
if [ "$RESET_ON" = demand ] && [ ! -e "$DATA/.generation" ]; then
  echo "$GENERATION" >"$DATA/.generation"
fi

if [ "$RESET_ON" = deploy ]; then
  # A marker left from KEEP_RESET_ON=demand would point data made under
  # deploy at an old generation's replica if demand came back.
  rm -rf "$DATA/.generation" "$WIPING"
fi

if [ -n "${KEEP_RESET_SEED:-}" ] && [ "$RESET_ON" = deploy ]; then
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
