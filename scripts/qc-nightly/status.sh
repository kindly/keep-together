#!/usr/bin/env bash
# The nightly QC at a glance (docs/ops.md, "Nightly QC"): the last runs,
# the current streak of green runs (what the C1 gate counts: 3 nightly
# runs in a row) and the commit each ran, the next run, the open issue.
#
#   ~/.local/share/keep-qc-nightly/bin/status.sh [N]    (N: runs shown, default 10)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh source-path=SCRIPTDIR
. "$here/lib.sh"
load_config

shown=${1:-10}
[[ $shown =~ ^[0-9]+$ ]] || die "usage: status.sh [N]"
runs=$NIGHTLY/runs.log

row() { # one runs.log line, as a table row
  local line=$1 commit extra
  commit=$(field commit "$line")
  extra=$(field redeployed "$line")
  [ -z "$extra" ] || extra="staging redeployed mid-run (${extra:0:12})"
  [ -n "$extra" ] || extra=$(field step "$line")
  printf '%-25s %-12s %-6s %5s %4s %4s  %s\n' "${line%% *}" "${commit:0:12}" \
    "$(field result "$line")" "$(field flows "$line")" "$(field over "$line")" \
    "$(field rtt "$line")" "$extra"
}

if [ ! -s "$runs" ]; then
  echo "no runs yet ($runs)"
else
  echo "last runs ($runs):"
  printf '%-25s %-12s %-6s %5s %4s %4s  %s\n' time commit result flows over rtt ""
  tail -n "$shown" "$runs" | while read -r line; do row "$line"; done

  # The streak: green runs since the last run that wasn't.
  mapfile -t streak < <(tac "$runs" | awk '/ result=pass( |$)/ { print; next } { exit }' | tac)
  nights=$(printf '%s\n' "${streak[@]}" | grep -v '^$' | cut -c1-10 | sort -u | wc -l)
  echo
  echo "streak: ${#streak[@]} green run(s) in a row, on $nights night(s)"
  for line in "${streak[@]}"; do
    commit=$(field commit "$line")
    subject=$(git -C "$NIGHTLY/src" log -1 --format='%s' "$commit" 2>/dev/null || true)
    printf '  %s  %s  %s\n' "${line%% *}" "${commit:0:12}" "$subject"
  done
fi

echo
next=$(systemctl --user show "$UNIT.timer" -p NextElapseUSecRealtime --value 2>/dev/null || true)
state=$(systemctl --user is-active "$UNIT.timer" 2>/dev/null || true)
printf '%-8s %s\n' timer "${state:-unknown}${next:+, next $next}"
issue=$(gh issue list -R "$(repo_slug)" --label qc-nightly --state open \
  --json number,title --jq '.[0] | select(.) | "#\(.number) \(.title)"' 2>/dev/null || echo "(gh failed)")
printf '%-8s %s\n' issue "${issue:-none open}"
printf '%-8s %s\n' trend "$NIGHTLY/src/qc-report/trend.html"
printf '%-8s %s\n' logs "$NIGHTLY/logs/ (journalctl --user -u $UNIT.service)"
