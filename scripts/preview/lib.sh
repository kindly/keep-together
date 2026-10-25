# shellcheck shell=bash
# Shared by install.sh, update.sh and status.sh (sourced, never run).
#
# Layout under $PREVIEW (KEEP_PREVIEW_HOME, default
# ~/.local/share/keep-preview):
#   src/              a clone of the GitHub repo, detached at origin/main;
#                     builds happen here (rs/target and node_modules stay
#                     between updates)
#   releases/<sha>/   api + dist/ of one built commit; the last 3 are kept
#   current           symlink to the release the service runs
#   data/             KEEP_DATA_DIR (data.prev: the one before the last reseed)
#   bin/              these scripts, copied from the running release's src
#   preview.env       the api's settings and the scripts' (KEEP_PREVIEW_*)
#   secrets.env       0600: auth keys and the riverside sign-ins
#   state             last update: when, commit, result
#   update.lock       flock: one update at a time

PREVIEW=${KEEP_PREVIEW_HOME:-$HOME/.local/share/keep-preview}
# shellcheck disable=SC2034 # used by the scripts that source this
UNIT=keep-preview.service
# shellcheck disable=SC2034
UPDATE_UNIT=keep-preview-update

say() { printf '\n== %s\n' "$*"; }
run() { printf '+ %s\n' "$*" >&2; "$@"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
log() { printf '%s %s\n' "$(date -Is)" "$*"; }

# The scripts' settings. secrets.env is the api's only (never sourced
# here: nothing in these scripts needs a secret).
load_config() {
  [ -f "$PREVIEW/preview.env" ] || die "$PREVIEW/preview.env missing: run scripts/preview/install.sh first"
  set -a
  # shellcheck source=/dev/null
  . "$PREVIEW/preview.env"
  set +a
  [ -z "${KEEP_PREVIEW_PATH:-}" ] || PATH=$KEEP_PREVIEW_PATH
}

# The commit the service runs (the release `current` points at).
running_commit() {
  local target
  target=$(readlink "$PREVIEW/current" 2>/dev/null) || return 0
  basename "$target"
}

# One `key=value` from the state file.
state_get() {
  [ -f "$PREVIEW/state" ] || return 0
  sed -n "s/^$1=//p" "$PREVIEW/state" | tail -n 1
}

# The preview signs in with KEEP_AUTH_POLICY=relaxed (docs/ops.md): a
# password alone, and the riverside users' password is "riverside" with
# no TOTP (the api's seed default under relaxed). An install from before
# that gets it here: preview.env gains the line if it has no
# KEEP_AUTH_POLICY (one already there is the human's choice, kept), and
# under relaxed the generated riverside sign-ins leave secrets.env so the
# next reseed uses the simple ones. Prints what it changed.
relaxed_settings() {
  local env=$PREVIEW/preview.env secrets=$PREVIEW/secrets.env tmp
  if ! grep -q '^KEEP_AUTH_POLICY=' "$env"; then
    printf '%s\n' KEEP_AUTH_POLICY=relaxed >>"$env"
    echo "preview.env: added KEEP_AUTH_POLICY=relaxed"
  fi
  [ "$(sed -n 's/^KEEP_AUTH_POLICY=//p' "$env" | tail -n 1)" = relaxed ] || return 0
  if [ -f "$secrets" ] && grep -q '^KEEP_RIVERSIDE_' "$secrets"; then
    tmp=$(mktemp "$PREVIEW/secrets.env.XXXXXX")
    chmod 600 "$tmp"
    grep -v '^KEEP_RIVERSIDE_' "$secrets" >"$tmp" || true
    mv "$tmp" "$secrets"
    echo "secrets.env: removed the generated riverside sign-ins (relaxed: password riverside, no TOTP)"
  fi
}
