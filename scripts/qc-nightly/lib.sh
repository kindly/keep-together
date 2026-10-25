# shellcheck shell=bash
# Shared by install.sh, run.sh and status.sh (sourced, never run).
#
# Layout under $NIGHTLY (KEEP_QC_NIGHTLY_HOME, default
# ~/.local/share/keep-qc-nightly):
#   src/              a clone of the GitHub repo, detached at the commit
#                     staging ran last night; QC runs here, and its
#                     qc-results/history.jsonl and qc-report/ stay between
#                     runs (gitignored)
#   bin/              these scripts, copied by install.sh
#   nightly.env       the scripts' settings (KEEP_QC_NIGHTLY_*)
#   qc-token          0600: KEEP_QC_TOKEN, read only into the env of `pnpm qc`
#   runs.log          one line per run (see run.sh); status.sh reads it
#   logs/<time>-<pid>.log  each run's full output; the last 30 are kept
#   run.lock          flock: one run at a time

NIGHTLY=${KEEP_QC_NIGHTLY_HOME:-$HOME/.local/share/keep-qc-nightly}
# shellcheck disable=SC2034 # used by the scripts that source this
UNIT=keep-qc-nightly

say() { printf '\n== %s\n' "$*"; }
# Children never inherit run.sh's locks (fd 9: run.lock, 8: the preview's).
run() { printf '+ %s\n' "$*" >&2; "$@" 9>&- 8>&-; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
log() { printf '%s %s\n' "$(date -Is)" "$*"; }

load_config() {
  [ -f "$NIGHTLY/nightly.env" ] || die "$NIGHTLY/nightly.env missing: run scripts/qc-nightly/install.sh first"
  set -a
  # shellcheck source=/dev/null
  . "$NIGHTLY/nightly.env"
  set +a
  [ -z "${KEEP_QC_NIGHTLY_PATH:-}" ] || PATH=$KEEP_QC_NIGHTLY_PATH
}

# `owner/name` of the clone's origin, for gh -R.
repo_slug() {
  git -C "$NIGHTLY/src" remote get-url origin |
    sed -E 's#^(https://github\.com/|git@github\.com:)##; s#\.git$##'
}

# One `key=value` field from a runs.log line.
field() { sed -nE "s/.* $1=([^ ]*).*/\1/p" <<<"$2"; }
