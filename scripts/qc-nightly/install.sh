#!/usr/bin/env bash
# Install the nightly QC run against keep-staging on this machine
# (docs/ops.md, "Nightly QC"). Re-running is safe: each step checks
# first, and the token, runs.log and QC history are kept. Re-run it to
# pick up changed scripts.
#
#   scripts/qc-nightly/install.sh [--token-stdin]
#
# --token-stdin: read KEEP_QC_TOKEN from stdin into qc-token (replacing
#   the one there). Without it a missing qc-token is fetched from a
#   keep-staging machine's env (`fly ssh console`, needs `fly auth
#   login`), straight into the file. The token is never printed.
#
# Creates ~/.local/share/keep-qc-nightly (KEEP_QC_NIGHTLY_HOME), clones the
# repo there over https (its own clone: never a working checkout or a
# factory worktree), installs its node_modules and Playwright's chromium,
# writes nightly.env, qc-token (0600) and the systemd --user units
# keep-qc-nightly.{service,timer} (daily at 03:00 local, Persistent=true:
# a night the machine was off runs at the next boot), and enables the
# timer. It doesn't start a run: the last lines say how.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh source-path=SCRIPTDIR
. "$here/lib.sh"

token_stdin=0
while (($#)); do
  case $1 in
  --token-stdin) token_stdin=1; shift ;;
  *) die "unknown argument $1 (see the header of $0)" ;;
  esac
done

REPO=${KEEP_QC_NIGHTLY_REPO:-https://github.com/kindly/keep-together.git}
# The checkout this script runs from shares .qc.lock with every worktree
# (scripts/qc.mjs): the main checkout is the common git dir's parent.
main_checkout=$(cd "$(git -C "$here" rev-parse --path-format=absolute --git-common-dir)/.." && pwd)

for tool in git pnpm node jq flock gh systemctl systemd-run; do
  command -v "$tool" >/dev/null || die "needs $tool on PATH"
done

say "Directories ($NIGHTLY)"
run mkdir -p "$NIGHTLY"/{bin,logs}

say "Source clone"
if [ -d "$NIGHTLY/src/.git" ]; then
  echo "exists ($(git -C "$NIGHTLY/src" remote get-url origin))"
else
  run git clone --quiet "$REPO" "$NIGHTLY/src"
fi
# Each run checks out the commit staging runs; until the first, main.
if git -C "$NIGHTLY/src" symbolic-ref -q HEAD >/dev/null; then
  run git -C "$NIGHTLY/src" checkout --quiet --detach origin/main
else
  echo "detached at $(git -C "$NIGHTLY/src" rev-parse --short HEAD)"
fi

say "Dependencies"
(cd "$NIGHTLY/src" && run pnpm install --frozen-lockfile --reporter=silent)
# A no-op when this Playwright's chromium is already downloaded.
(cd "$NIGHTLY/src" && run pnpm exec playwright install chromium)

say "Settings (nightly.env)"
preview_lock=${KEEP_PREVIEW_HOME:-$HOME/.local/share/keep-preview}/update.lock
# The PATH this script found pnpm, node and gh on: systemd --user starts
# units with a bare one.
tmp=$(mktemp "$NIGHTLY/nightly.env.XXXXXX")
cat >"$tmp" <<EOF
# keep-qc-nightly settings, written by scripts/qc-nightly/install.sh
# (re-run it to change them). No secrets: the token is in qc-token.
KEEP_QC_NIGHTLY_QC_LOCK=$main_checkout/.qc.lock
KEEP_QC_NIGHTLY_PREVIEW_LOCK=$preview_lock
KEEP_QC_NIGHTLY_PATH=$PATH
EOF
if [ -f "$NIGHTLY/nightly.env" ] && cmp -s "$tmp" "$NIGHTLY/nightly.env"; then
  rm "$tmp"
  echo "unchanged"
else
  run mv "$tmp" "$NIGHTLY/nightly.env"
fi
grep -v '^KEEP_QC_NIGHTLY_PATH=' "$NIGHTLY/nightly.env" | grep -v '^#'

say "Token (qc-token, 0600)"
# Read into a 0600 file beside qc-token and renamed over it, never into a
# variable, argv or this output. Valid: one line, no spaces, 32+ chars
# (scripts/fly/staging.sh makes 64 hex).
save_token() { # stdin: the source's output
  local tmp lines
  umask 077
  tmp=$(mktemp "$NIGHTLY/qc-token.XXXXXX")
  tr -d '\r' | sed '/^[[:space:]]*$/d' >"$tmp"
  umask 022
  lines=$(wc -l <"$tmp")
  if [ "$lines" != 1 ] || ! grep -Eqx '[A-Za-z0-9_-]{32,}' "$tmp"; then
    rm -f "$tmp"
    die "that doesn't look like KEEP_QC_TOKEN ($lines lines; not shown). Nothing saved. (fly: signed in? fly auth login)"
  fi
  mv "$tmp" "$NIGHTLY/qc-token"
}
if ((token_stdin)); then
  echo "+ <stdin> > $NIGHTLY/qc-token" >&2
  save_token
  echo "saved from stdin"
elif [ -s "$NIGHTLY/qc-token" ]; then
  echo "exists (to replace it: --token-stdin, or delete the file and re-run)"
else
  command -v fly >/dev/null || die "qc-token is missing and fly isn't on PATH: install flyctl, or pass the token with --token-stdin"
  echo "+ fly ssh console -a keep-staging -C 'printenv KEEP_QC_TOKEN' > $NIGHTLY/qc-token" >&2
  fly ssh console -a keep-staging -C 'printenv KEEP_QC_TOKEN' </dev/null | save_token
  echo "fetched from keep-staging"
fi
chmod 600 "$NIGHTLY/qc-token"

say "Scripts (bin/)"
for f in lib.sh run.sh status.sh; do
  run install -m 755 "$here/$f" "$NIGHTLY/bin/$f"
done

say "systemd --user units"
units=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
run mkdir -p "$units"
write_unit() {
  local name=$1 tmp
  tmp=$(mktemp)
  cat >"$tmp"
  if [ -f "$units/$name" ] && cmp -s "$tmp" "$units/$name"; then
    rm "$tmp"
    echo "$name unchanged"
  else
    run mv "$tmp" "$units/$name"
    chmod 644 "$units/$name"
  fi
}
# Not niced: it's a timed run. TimeoutStartSec: a local QC run holding
# .qc.lock (stale after 2 h), deploys (45 min, up to 3 times) and the run
# itself. No network-online.target: a --user unit can't order against it,
# so run.sh waits for the network itself.
write_unit "$UNIT.service" <<EOF
[Unit]
Description=Nightly QC against keep-staging
Documentation=file://$NIGHTLY/src/docs/ops.md

[Service]
Type=oneshot
ExecStart=$NIGHTLY/bin/run.sh
TimeoutStartSec=6h
EOF
write_unit "$UNIT.timer" <<EOF
[Unit]
Description=Nightly QC against keep-staging at 03:00

[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true

[Install]
WantedBy=timers.target
EOF
run systemctl --user daemon-reload
run systemctl --user enable --now "$UNIT.timer"

say "gh from systemd"
# run.sh needs gh (the deploy runs, the issue) from a unit, with no login
# session: a token kept only in a desktop keyring may not be reachable.
if run systemd-run --user --wait --pipe --quiet -p "Environment=PATH=$PATH" gh auth status >/dev/null 2>&1; then
  echo "ok: gh is signed in from a --user unit"
else
  echo "!! gh auth status fails from a --user unit: run.sh can't find staging's commit or open"
  echo "   issues. Store the token in a file (gh auth login --insecure-storage) and re-check."
fi

say "Next"
cat <<EOF
Linger is already on, so the timer fires with nobody logged in. The
first run (watch it, then read the result):
  systemctl --user start --no-block $UNIT.service
  journalctl --user -fu $UNIT.service
  $NIGHTLY/bin/status.sh
EOF
