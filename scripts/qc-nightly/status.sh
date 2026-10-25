#!/usr/bin/env bash
# The nightly QC at a glance (docs/ops.md, "Nightly QC"): the last runs,
# the current streak of passing nights in a row (what the C1 gate counts:
# 3) and the commit each ran, the next run, the open issue.
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
  extra=$(field reason "$line")
  [ -n "$extra" ] || extra=$(field step "$line")
  [ -z "$(field staging-check "$line")" ] || extra="$extra staging-check=$(field staging-check "$line")"
  [ "$(field rttover "$line")" = "" ] || [ "$(field rttover "$line")" = 0 ] ||
    extra="$extra (rttover=$(field rttover "$line"))"
  printf '%-25s %-12s %-6s %5s %4s %4s  %s\n' "${line%% *}" "${commit:0:12}" \
    "$(field result "$line")" "$(field flows "$line")" "$(field over "$line")" \
    "$(field rtt "$line")" "$extra"
}
# The night a run belongs to: noon to noon, so a hand run at 23:30 and
# the 03:00 run after it are one night.
night() { date -d "${1%% *} 12 hours ago" +%F; }

if [ ! -s "$runs" ]; then
  echo "no runs yet ($runs)"
else
  echo "last runs ($runs):"
  printf '%-25s %-12s %-6s %5s %4s %4s  %s\n' time commit result flows over rtt ""
  tail -n "$shown" "$runs" | while read -r line; do row "$line"; done

  # The streak (what the gate counts): passing nights in a row, newest
  # first. Any run that isn't a pass ends it (a void too: that night
  # wasn't tested), and so does a night with no run at all.
  streak=()
  prev="" latest=""
  while read -r line; do
    [[ $line == *" result=pass"* ]] || break
    n=$(night "$line")
    if [ -n "$prev" ] && [ "$n" != "$prev" ] &&
      [ "$n" != "$(date -d "$prev -1 day" +%F)" ]; then
      break
    fi
    prev=$n
    latest=${latest:-$n}
    streak=("$line" "${streak[@]}")
  done < <(tac "$runs")
  nights=$(for line in "${streak[@]}"; do night "$line"; done | sort -u | wc -l)
  echo
  echo "streak: $nights passing night(s) in a row (${#streak[@]} run(s))${latest:+, the latest the night of $latest}"
  for line in "${streak[@]}"; do
    commit=$(field commit "$line")
    subject=$(git -C "$NIGHTLY/src" log -1 --format='%s' "$commit" 2>/dev/null || true)
    printf '  night of %s  %s  %s  %s\n' "$(night "$line")" "${line%% *}" "${commit:0:12}" "$subject"
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
