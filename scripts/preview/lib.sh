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
