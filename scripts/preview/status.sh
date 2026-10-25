#!/usr/bin/env bash
# The preview at a glance (docs/ops.md, "Preview (tailnet)"): the commit
# it runs, the last update, its URL and health, and the riverside
# sign-ins. Under KEEP_AUTH_POLICY=relaxed those are the seed's simple
# default (password riverside, no TOTP) unless secrets.env sets one;
# otherwise the passwords and TOTP secrets stay in secrets.env: this
# prints the file's path, never its values.
#
#   ~/.local/share/keep-preview/bin/status.sh    (or scripts/preview/status.sh)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh source-path=SCRIPTDIR
. "$here/lib.sh"
load_config

commit=$(running_commit)
subject=""
if [ -n "$commit" ] && [ -d "$PREVIEW/src/.git" ]; then
  subject=$(git -C "$PREVIEW/src" log -1 --format='%s (%cr)' "$commit" 2>/dev/null || true)
fi
health=$(curl -fsS --max-time 2 "http://127.0.0.1:$KEEP_PORT/healthz" 2>/dev/null |
  jq -r 'if .ok then "ok" else "unhealthy" end' 2>/dev/null || echo "not answering")
service=$(systemctl --user is-active "$UNIT" 2>/dev/null || true)
timer=$(systemctl --user is-active "$UPDATE_UNIT.timer" 2>/dev/null || true)

printf '%-12s %s\n' \
  url "$KEEP_APP_ORIGIN" \
  local "http://127.0.0.1:$KEEP_PORT ($health; service ${service:-unknown}, timer ${timer:-unknown})" \
  running "${commit:-nothing deployed}${subject:+  $subject}" \
  deployed "$(state_get deployed_at)" \
  checked "$(state_get checked_at) ($(state_get result))"
failed=$(state_get failed)
[ -z "$failed" ] || printf '%-12s %s\n' failed "${failed:0:12}: journalctl --user -u $UPDATE_UNIT"

echo
if [ "${KEEP_AUTH_POLICY:-strict}" = relaxed ]; then
  echo "riverside sign-ins (KEEP_AUTH_POLICY=relaxed: password only, no second step):"
  for role in admin staff viewer; do
    var=KEEP_RIVERSIDE_${role^^}_PASSWORD
    if grep -q "^$var=" "$PREVIEW/secrets.env" 2>/dev/null; then
      echo "  $role@keep-together.example  password: $var in $PREVIEW/secrets.env"
    else
      echo "  $role@keep-together.example  password: riverside"
    fi
  done
else
  echo "riverside sign-ins (password + TOTP; values in $PREVIEW/secrets.env as"
  echo "KEEP_RIVERSIDE_<ROLE>_PASSWORD / _TOTP, the TOTP as a base32 secret):"
  for role in admin staff viewer; do
    echo "  $role@keep-together.example"
  done
fi
