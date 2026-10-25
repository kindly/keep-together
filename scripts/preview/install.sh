#!/usr/bin/env bash
# Install the always-on preview of main on this machine (docs/ops.md,
# "Preview (tailnet)"): main, built in release, serving the riverside
# sample data on 127.0.0.1, which `tailscale serve` puts on the tailnet.
# Re-running is safe: each step checks first, and settings, secrets and
# data are kept.
#
#   scripts/preview/install.sh [--origin https://<host>.<tailnet>.ts.net] [--port 8780]
#
# --origin: the tailnet URL the SPA is reached at (KEEP_APP_ORIGIN: the
#   trusted Origin for writes, links in emails). Default: this machine's
#   MagicDNS name from `tailscale status`, https on 443. Behind `tailscale
#   serve --https=<n>` with n != 443, pass the URL with :n.
# --port: the api's loopback port (default 8780, or the installed one).
#
# Creates ~/.local/share/keep-preview (KEEP_PREVIEW_HOME), clones the repo
# there over https (its own clone: never a working checkout), writes
# preview.env (KEEP_AUTH_POLICY=relaxed: riverside signs in with the
# password "riverside", no TOTP), secrets.env (auth keys, made once,
# 0600), the systemd --user units keep-preview.service and
# keep-preview-update.{service,timer} (every 5 min), runs the first
# update (a full release build: several minutes) and prints the one-time
# steps for the human (linger, tailscale serve).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh source-path=SCRIPTDIR
. "$here/lib.sh"

origin=""
port=""
while (($#)); do
  case $1 in
  --origin) origin=${2:?--origin needs a URL}; shift 2 ;;
  --port) port=${2:?--port needs a number}; shift 2 ;;
  *) die "unknown argument $1 (see the header of $0)" ;;
  esac
done

REPO=${KEEP_PREVIEW_REPO:-https://github.com/kindly/keep-together.git}
# The checkout this script runs from shares .qc.lock with every worktree
# (scripts/qc.mjs): the main checkout is the common git dir's parent.
main_checkout=$(cd "$(git -C "$here" rev-parse --path-format=absolute --git-common-dir)/.." && pwd)

for tool in git cargo pnpm node jq flock ionice openssl base32 curl systemctl; do
  command -v "$tool" >/dev/null || die "needs $tool on PATH"
done

say "Directories ($PREVIEW)"
run mkdir -p "$PREVIEW"/{bin,data,releases}

say "Source clone"
if [ -d "$PREVIEW/src/.git" ]; then
  echo "exists ($(git -C "$PREVIEW/src" remote get-url origin))"
else
  run git clone --no-checkout "$REPO" "$PREVIEW/src"
fi

say "Settings (preview.env)"
if [ -f "$PREVIEW/preview.env" ]; then
  old_origin=$(sed -n 's/^KEEP_APP_ORIGIN=//p' "$PREVIEW/preview.env")
  old_port=$(sed -n 's/^KEEP_PORT=//p' "$PREVIEW/preview.env")
  policy=$(sed -n 's/^KEEP_AUTH_POLICY=//p' "$PREVIEW/preview.env")
fi
port=${port:-${old_port:-8780}}
if [ -z "$origin" ] && [ -n "${old_origin:-}" ]; then
  origin=$old_origin
fi
if [ -z "$origin" ]; then
  dns=$(tailscale status --json 2>/dev/null | jq -r '.Self.DNSName // empty' | sed 's/\.$//') || true
  [ -n "$dns" ] || die "can't read this machine's tailnet name (tailscale status --json); pass --origin https://<host>.<tailnet>.ts.net"
  origin=https://$dns
fi
case $origin in
https://*.ts.net | https://*.ts.net:*) ;;
https://*) echo "note: $origin is not a ts.net name; fine if that's where tailscale serve answers" ;;
*) die "--origin must be https:// (tailscale serve terminates TLS): got $origin" ;;
esac
[[ $port =~ ^[0-9]+$ ]] || die "--port must be a number: got $port"
# Builds get half the cores, so a timed QC run or the human's own work
# isn't starved (on top of nice/ionice; update.sh also skips while QC runs).
jobs=$(($(nproc) / 2))
((jobs >= 1)) || jobs=1
# The PATH this script found cargo, pnpm and node on: systemd --user
# starts units with a bare one.
tmp=$(mktemp "$PREVIEW/preview.env.XXXXXX")
cat >"$tmp" <<EOF
# keep-preview settings, written by scripts/preview/install.sh (re-run it
# to change them). Read by the api (systemd EnvironmentFile) and by the
# scripts; KEEP_PREVIEW_* are the scripts' own.
KEEP_ENV=dev
KEEP_BIND=127.0.0.1
KEEP_PORT=$port
KEEP_DATA_DIR=$PREVIEW/data
KEEP_STATIC_DIR=$PREVIEW/current/dist
KEEP_APP_ORIGIN=$origin
KEEP_MAIL=log
KEEP_AUTH_POLICY=${policy:-relaxed}
KEEP_RESET_SEED=riverside
KEEP_PREVIEW_QC_LOCK=$main_checkout/.qc.lock
KEEP_PREVIEW_JOBS=$jobs
KEEP_PREVIEW_PATH=$PATH
EOF
if [ -f "$PREVIEW/preview.env" ] && cmp -s "$tmp" "$PREVIEW/preview.env"; then
  rm "$tmp"
  echo "unchanged"
else
  run mv "$tmp" "$PREVIEW/preview.env"
fi
grep -v '^KEEP_PREVIEW_PATH=' "$PREVIEW/preview.env" | grep -v '^#'

say "Secrets (secrets.env, 0600)"
# Made once and kept: replacing KEEP_SETTINGS_KEY would unseal nothing
# (enrolled authenticators are sealed under it). Under relaxed the
# riverside sign-ins are the seed's simple default (password riverside,
# no TOTP), so none are made; under strict a password and TOTP secret per
# role are made once and stay the same across every reseed, so an
# authenticator app keeps working. Never printed here: status.sh says
# where they are.
umask 077
touch "$PREVIEW/secrets.env"
chmod 600 "$PREVIEW/secrets.env"
added=0
add_secret() {
  grep -q "^$1=" "$PREVIEW/secrets.env" && return 0
  printf '%s=%s\n' "$1" "$2" >>"$PREVIEW/secrets.env"
  added=$((added + 1))
}
b32() { head -c 20 /dev/urandom | base32 | tr -d '=\n'; }
add_secret KEEP_SETTINGS_KEY "$(openssl rand -base64 32)"
add_secret KEEP_AUTH_PEPPER "$(openssl rand -base64 32)"
if [ "$(sed -n 's/^KEEP_AUTH_POLICY=//p' "$PREVIEW/preview.env")" != relaxed ]; then
  for role in ADMIN STAFF VIEWER; do
    add_secret "KEEP_RIVERSIDE_${role}_PASSWORD" "$(openssl rand -base64 18 | tr '+/' '-_')"
    add_secret "KEEP_RIVERSIDE_${role}_TOTP" "$(b32)"
  done
fi
relaxed_settings
umask 022
echo "$added added; the file holds $(grep -c '=' "$PREVIEW/secrets.env") values"

say "Scripts (bin/)"
for f in lib.sh update.sh status.sh; do
  run install -m 755 "$here/$f" "$PREVIEW/bin/$f"
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
write_unit "$UNIT" <<EOF
[Unit]
Description=keep-together preview of main (riverside sample data)
Documentation=file://$PREVIEW/src/docs/ops.md
After=network.target

[Service]
EnvironmentFile=$PREVIEW/preview.env
EnvironmentFile=$PREVIEW/secrets.env
ExecStart=$PREVIEW/current/api
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
write_unit "$UPDATE_UNIT.service" <<EOF
[Unit]
Description=Build and deploy origin/main to the keep-together preview

[Service]
Type=oneshot
ExecStart=$PREVIEW/bin/update.sh
Nice=19
IOSchedulingClass=idle
EOF
write_unit "$UPDATE_UNIT.timer" <<EOF
[Unit]
Description=Check origin/main for the keep-together preview every 5 minutes

[Timer]
OnBootSec=2min
OnUnitInactiveSec=5min

[Install]
WantedBy=timers.target
EOF
run systemctl --user daemon-reload

say "First build"
if [ -n "$(running_commit)" ]; then
  echo "running $(running_commit); the timer picks up new commits"
else
  run "$PREVIEW/bin/update.sh"
fi

say "Enable"
run systemctl --user enable --now "$UNIT" "$UPDATE_UNIT.timer"

say "One-time steps for the human (not run by this script)"
https_port=${origin##*:}
[[ $https_port =~ ^[0-9]+$ ]] || https_port=443
cat <<EOF
1. Keep your user's services running after logout and across reboots:
     sudo loginctl enable-linger $USER
2. Put the preview on the tailnet (TLS by tailscale; add sudo, or run
   'sudo tailscale set --operator=$USER' once, if it asks for rights):
     tailscale serve --bg --https=$https_port http://127.0.0.1:$port
   Then open $origin on any tailnet device.
3. Sign in with a riverside user: $PREVIEW/bin/status.sh lists them.
EOF
