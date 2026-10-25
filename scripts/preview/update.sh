#!/usr/bin/env bash
# Deploy origin/main to the preview when it has moved (docs/ops.md,
# "Preview (tailnet)"). keep-preview-update.timer runs it every 5 min;
# run it by hand as ~/.local/share/keep-preview/bin/update.sh [--force].
#
# 1. One at a time (flock), and not while a QC run holds .qc.lock in the
#    main checkout: a build would skew its timings.
# 2. Fetch origin/main. Same commit as running: nothing to do. A commit
#    that already failed is skipped until main moves (or --force).
# 3. Build in src/ (cargo --release, pnpm build) at nice 19 / ionice idle
#    with KEEP_PREVIEW_JOBS jobs, into releases/<sha>. A failed build
#    leaves the running preview alone.
# 4. Reseed: stop the api, move data/ aside to data.prev/, point current
#    at the new release and start it; the api seeds riverside at boot
#    (KEEP_RESET_SEED): under KEEP_AUTH_POLICY=relaxed (relaxed_settings in
#    lib.sh, applied first) with the password riverside and no TOTP, else
#    with the sign-ins in secrets.env, so they never change. Not healthy
#    within 2 min: back to the old release and data.
#
# --force: build and reseed even when origin/main is running or failed.
# Exit 0: nothing to do, skipped, or deployed. Exit 1: the build or the
# new release failed (the old one keeps running).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh source-path=SCRIPTDIR
. "$here/lib.sh"
load_config

force=0
case ${1:-} in
--force) force=1 ;;
"") ;;
*) die "usage: update.sh [--force]" ;;
esac

# One `key=value` per line; unnamed keys keep their value.
write_state() {
  local keys=(checked_at result commit deployed_at deployed failed) k v
  local tmp
  tmp=$(mktemp "$PREVIEW/state.XXXXXX")
  for k in "${keys[@]}"; do
    v=$(state_get "$k")
    for kv in "$@"; do
      [ "${kv%%=*}" = "$k" ] && v=${kv#*=}
    done
    printf '%s=%s\n' "$k" "$v" >>"$tmp"
  done
  mv "$tmp" "$PREVIEW/state"
}

# fd 9 holds the lock; the starts below close it, so nothing they spawn
# keeps it.
exec 9>"$PREVIEW/update.lock"
if ! flock -n 9; then
  log "another update is running; skipping"
  exit 0
fi

# scripts/lockfile.mjs's rule: held while its pid lives and it is younger
# than qc.mjs's LOCK_MAX_AGE_MS (2 h).
qc_running() {
  local lock=${KEEP_PREVIEW_QC_LOCK:-} pid started age
  [ -n "$lock" ] && [ -s "$lock" ] || return 1
  pid=$(jq -r '.pid // empty' "$lock" 2>/dev/null) || return 1
  started=$(jq -r '.startedAt // empty' "$lock" 2>/dev/null) || return 1
  [[ $pid =~ ^[0-9]+$ ]] && [ -d "/proc/$pid" ] || return 1
  age=$(($(date +%s) - $(date -d "$started" +%s 2>/dev/null || echo 0)))
  ((age < 7200))
}
if qc_running; then
  log "a QC run holds $KEEP_PREVIEW_QC_LOCK; skipping"
  write_state "checked_at=$(date -Is)" result=skipped-qc
  exit 0
fi

src=$PREVIEW/src
run git -C "$src" fetch --quiet origin main
new=$(git -C "$src" rev-parse origin/main)
running=$(running_commit)
if ((!force)); then
  if [ "$new" = "$running" ]; then
    write_state "checked_at=$(date -Is)" result=up-to-date
    exit 0
  fi
  if [ "$new" = "$(state_get failed)" ]; then
    log "origin/main ${new:0:12} failed before; waiting for a new commit (or --force)"
    write_state "checked_at=$(date -Is)" result=failed
    exit 0
  fi
fi
log "deploying ${new:0:12} (running: ${running:-nothing})"

fail() {
  log "FAILED ${new:0:12}: $*${running:+; still running ${running:0:12}}"
  write_state "checked_at=$(date -Is)" result=failed "commit=$new" "failed=$new"
  exit 1
}

# ---- build ------------------------------------------------------------------
quiet=(nice -n 19 ionice -c 3)
jobs=${KEEP_PREVIEW_JOBS:-1}
release=$PREVIEW/releases/$new
if [ ! -x "$release/api" ] || [ ! -f "$release/dist/index.html" ]; then
  run git -C "$src" checkout --quiet --force --detach "$new" || fail "checkout"
  (cd "$src/rs" && run "${quiet[@]}" cargo build --release --locked -j "$jobs" -p api) ||
    fail "cargo build"
  (cd "$src" && run "${quiet[@]}" pnpm install --frozen-lockfile --reporter=silent) ||
    fail "pnpm install"
  # The image's build settings (rs/Dockerfile): the SPA talks to its own
  # origin, the Rust api.
  (cd "$src" && VITE_BACKEND=rust VITE_RELEASE=$new run "${quiet[@]}" pnpm build) ||
    fail "pnpm build"
  staging=$release.partial
  {
    rm -rf "$staging" &&
      mkdir -p "$staging/bin" &&
      cp "$src/rs/target/release/api" "$staging/api" &&
      cp -r "$src/dist" "$staging/dist" &&
      # A commit from before these scripts existed has none to copy.
      { [ ! -d "$src/scripts/preview" ] ||
        cp "$src"/scripts/preview/{lib.sh,update.sh,status.sh} "$staging/bin/"; } &&
      rm -rf "$release" &&
      mv "$staging" "$release"
  } || fail "staging the release"
fi

# ---- reseed -----------------------------------------------------------------
healthy() {
  local i
  for ((i = 0; i < 60; i++)); do
    curl -fsS --max-time 2 "http://127.0.0.1:$KEEP_PORT/healthz" 2>/dev/null |
      jq -e '.ok == true' >/dev/null 2>&1 && return 0
    systemctl --user is-failed --quiet "$UNIT" && return 1
    sleep 2
  done
  return 1
}
point_current() { # atomic: a new symlink renamed over the old
  ln -sfn "releases/$1" "$PREVIEW/current.new"
  mv -T "$PREVIEW/current.new" "$PREVIEW/current"
}

relaxed_settings
run systemctl --user stop "$UNIT"
rm -rf "$PREVIEW/data.prev"
[ ! -d "$PREVIEW/data" ] || mv "$PREVIEW/data" "$PREVIEW/data.prev"
mkdir -p "$PREVIEW/data"
point_current "$new"
run systemctl --user start "$UNIT" 9>&- || true
if ! healthy; then
  log "${new:0:12} did not come up healthy: journalctl --user -u $UNIT"
  run systemctl --user stop "$UNIT" || true
  if [ -n "$running" ] && [ -d "$PREVIEW/releases/$running" ]; then
    rm -rf "$PREVIEW/data"
    [ ! -d "$PREVIEW/data.prev" ] || mv "$PREVIEW/data.prev" "$PREVIEW/data"
    point_current "$running"
    run systemctl --user start "$UNIT" 9>&- || true
    healthy || log "the old release ${running:0:12} did not come back either"
  fi
  fail "unhealthy after start"
fi

# The new release's own scripts, for the next run (renamed into place:
# this one keeps reading its own file).
for f in lib.sh update.sh status.sh; do
  [ -f "$release/bin/$f" ] || continue
  cp "$release/bin/$f" "$PREVIEW/bin/.$f.new"
  chmod 755 "$PREVIEW/bin/.$f.new"
  mv "$PREVIEW/bin/.$f.new" "$PREVIEW/bin/$f"
done

# The last 3 releases (the running one among them).
kept=0
while read -r r; do
  [ "$r" = "$new" ] && continue
  kept=$((kept + 1))
  ((kept < 3)) || rm -rf "${PREVIEW:?}/releases/$r"
done < <(ls -1t "$PREVIEW/releases")

write_state "checked_at=$(date -Is)" result=deployed "commit=$new" \
  "deployed_at=$(date -Is)" "deployed=$new" failed=
log "deployed ${new:0:12}: riverside reseeded at $KEEP_APP_ORIGIN"
