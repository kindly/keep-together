#!/usr/bin/env bash
# QC on Actions at a glance (docs/ops.md "Nightly QC"): the last runs and
# their results, the streak of passing nights in a row, the run under
# way, the open qc-nightly issue.
#
#   scripts/qc-actions/status.sh [N]      (N: runs shown, default 10)
#
# Needs gh, logged in with read access to the repo (GH_REPO, or the
# checkout's origin). Results come from the runs.log in the newest
# qc-history artifact (scripts/qc-actions/report.sh writes a line per
# run). `gh run list --workflow qc.yml` adds
# the scheduled and dispatched runs that never got as far as writing one
# (cancelled, or killed): they show as `no-record` and end the streak.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
die() { printf 'status.sh: %s\n' "$*" >&2; exit 1; }

shown=${1:-10}
[[ $shown =~ ^[0-9]+$ ]] || die "usage: status.sh [N]"
if [ -z "${GH_REPO:-}" ]; then
  GH_REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner) || die "no GH_REPO, and gh can't tell from this checkout"
fi
export GH_REPO

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
"$here/history.sh" fetch "$tmp" >/dev/null || die "could not read the qc-history artifact"
runs=$tmp/runs.log

field() { sed -nE "s/.* $1=([^ ]*).*/\1/p" <<<"$2"; }

# Runs of qc.yml that finished without a runs.log line: as lines of the
# same shape, `result=no-record conclusion=…`.
gh run list --workflow qc.yml --limit 100 \
  --json databaseId,event,status,conclusion,createdAt,headSha,url >"$tmp/gh.json" ||
  die "gh run list failed"
known=$(sed -nE 's/.* run=([0-9]+) .*/\1/p' "$runs" | sort -u)
jq -r --arg known "$known" '
  ($known | split("\n")) as $k
  | .[] | select(.status == "completed" and ((.databaseId | tostring) as $id | $k | index([$id]) | not))
  | "\(.createdAt) run=\(.databaseId) event=\(.event) commit=\(.headSha) result=no-record conclusion=\(.conclusion)"
' "$tmp/gh.json" >"$tmp/missing.log"
busy=$(jq -r '[.[] | select(.status != "completed")] | .[0] | select(.) | "\(.databaseId) (\(.event), \(.status), since \(.createdAt)) \(.url)"' "$tmp/gh.json")
# Every run, oldest first (ISO times sort as text).
sort -k1,1 "$runs" "$tmp/missing.log" | grep -v '^$' >"$tmp/all.log" || true

row() {
  local line=$1 extra
  extra=$(field reason "$line")
  [ -n "$extra" ] || extra=$(field step "$line")
  [ -n "$extra" ] || extra=$(field conclusion "$line")
  [ -z "$(field qc-check "$line")" ] || extra="$extra qc-check=$(field qc-check "$line")"
  [ "$(field retries "$line")" = "" ] || [ "$(field retries "$line")" = 0 ] ||
    extra="$extra (set-up retries=$(field retries "$line"))"
  printf '%-21s %-12s %-9s %-12s %-9s %5s %4s %5s  %s\n' "${line%% *}" "$(field run "$line")" \
    "$(field event "$line")" "$(field commit "$line" | cut -c1-12)" "$(field result "$line")" \
    "$(field flows "$line")" "$(field over "$line")" "$(field rtt "$line")" "$extra"
}
# The night a run belongs to: noon to noon (UTC), so a run by hand at
# 23:30 and the 03:00 one after it are one night.
night() { date -u -d "${1%% *} 12 hours ago" +%F; }

if [ ! -s "$tmp/all.log" ]; then
  echo "no runs yet"
else
  echo "last runs (runs.log in the newest qc-history artifact, and gh run list):"
  printf '%-21s %-12s %-9s %-12s %-9s %5s %4s %5s  %s\n' time run event commit result flows over rtt ""
  tail -n "$shown" "$tmp/all.log" | while read -r line; do row "$line"; done

  # The streak: passing nights in a row, newest first. Any run that isn't
  # a pass ends it (a void too: that night wasn't judged; a record run
  # too), and so does a night with no run at all.
  streak=()
  prev="" latest=""
  while read -r line; do
    [ "$(field result "$line")" = pass ] || break
    n=$(night "$line")
    if [ -n "$prev" ] && [ "$n" != "$prev" ] && [ "$n" != "$(date -u -d "$prev -1 day" +%F)" ]; then
      break
    fi
    prev=$n
    latest=${latest:-$n}
    streak=("$line" "${streak[@]}")
  done < <(tac "$tmp/all.log")
  nights=0
  ((${#streak[@]} == 0)) || nights=$(for line in "${streak[@]}"; do night "$line"; done | sort -u | wc -l)
  echo
  echo "streak: $nights passing night(s) in a row (${#streak[@]} run(s))${latest:+, the latest the night of $latest}"
  for line in "${streak[@]}"; do
    printf '  night of %s  %s  run %s  %s\n' "$(night "$line")" "${line%% *}" "$(field run "$line")" "$(field commit "$line" | cut -c1-12)"
  done
fi

echo
printf '%-8s %s\n' running "${busy:-none}"
issue=$(gh issue list --label qc-nightly --state open \
  --json number,title --jq '.[0] | select(.) | "#\(.number) \(.title)"' 2>/dev/null || echo "(gh failed)")
printf '%-8s %s\n' issue "${issue:-none open}"
printf '%-8s %s\n' runs "gh run list --workflow qc.yml"
