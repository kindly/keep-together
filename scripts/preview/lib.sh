# shellcheck shell=bash
# Shared by install.sh, update.sh and status.sh (sourced, never run).
#
# Layout under $PREVIEW (KEEP_PREVIEW_HOME, default
# ~/.local/share/keep-preview):
#   src/              a clone of the GitHub repo, detached at origin/main;
#                     builds happen here (server/target and node_modules stay
#                     between updates)
#   releases/<sha>/   api + dist/ of one built commit; the last 3 are kept
#   current           symlink to the release the service runs
#   data/             KEEP_DATA_DIR (data.prev: the one before the last reseed)
#   bin/              these scripts, from the last commit update.sh took up
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
# that is converted here, once:
# - preview.env gains KEEP_AUTH_POLICY=relaxed if it names no policy (one
#   already there is the human's choice, kept);
# - under relaxed, the riverside sign-ins install.sh generated leave
#   secrets.env, so the next reseed uses the simple ones. Only lines of
#   install.sh's own shape go (a _PASSWORD of 24 [A-Za-z0-9_-], a _TOTP of
#   32 base32); anything else is the human's and stays. What goes is kept
#   in secrets.env.pre-relaxed (0600), and the marker relaxed-converted
#   means secrets.env is never touched again, so a sign-in the human sets
#   later stays.
# Prints what it changed.
relaxed_settings() {
  local env=$PREVIEW/preview.env secrets=$PREVIEW/secrets.env
  local marker=$PREVIEW/relaxed-converted backup=$PREVIEW/secrets.env.pre-relaxed
  local generated='^KEEP_RIVERSIDE_(ADMIN|STAFF|VIEWER)_(PASSWORD=[A-Za-z0-9_-]{24}|TOTP=[A-Z2-7]{32})$'
  local tmp
  if ! grep -q '^KEEP_AUTH_POLICY=' "$env"; then
    printf '%s\n' KEEP_AUTH_POLICY=relaxed >>"$env"
    echo "preview.env: added KEEP_AUTH_POLICY=relaxed"
  fi
  [ "$(sed -n 's/^KEEP_AUTH_POLICY=//p' "$env" | tail -n 1)" = relaxed ] || return 0
  [ ! -e "$marker" ] || return 0
  if [ -f "$secrets" ] && grep -Eq "$generated" "$secrets"; then
    (
      umask 077
      grep -E "$generated" "$secrets" >>"$backup"
      tmp=$(mktemp "$PREVIEW/secrets.env.XXXXXX")
      grep -Ev "$generated" "$secrets" >"$tmp" || true
      mv "$tmp" "$secrets"
    )
    echo "secrets.env: moved the generated riverside sign-ins to $backup (relaxed: password riverside, no TOTP)"
  fi
  date -Is >"$marker"
}

# The preview's address lookup is the fake provider (fixed addresses, no
# network, no credit spent: server/crates/api/src/address/fake.rs). An install
# from before it gains KEEP_ADDRESS_LOOKUP=fake once; one already there
# is the human's choice, kept. Prints what it changed.
lookup_settings() {
  local env=$PREVIEW/preview.env
  grep -q '^KEEP_ADDRESS_LOOKUP=' "$env" && return 0
  printf '%s\n' KEEP_ADDRESS_LOOKUP=fake >>"$env"
  echo "preview.env: added KEEP_ADDRESS_LOOKUP=fake"
}
