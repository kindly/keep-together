#!/usr/bin/env bash
# QC's history on Actions: an artifact chain (plan gocardless-sandbox-qc.sv,
# g2q8). Each run fetches the last `qc-history` artifact, appends its own
# lines and uploads the result as a new one (kept 90 days), so drift,
# the trend report and the streak survive across runs without a branch to
# write to.
#
#   scripts/qc-actions/history.sh fetch <dir>
#       The newest unexpired qc-history artifact's history.jsonl and
#       runs.log into <dir> (both made empty when there is none yet).
#       Needs GH_TOKEN (actions: read) and GH_REPO. Exit 1 if GitHub
#       can't be asked or the artifact can't be read: the run must not go
#       on with an empty history and then upload it as the newest, which
#       would cut the chain.
#
#   scripts/qc-actions/history.sh build <dir> <prev-dir> <history.jsonl|-> <runs.log line>
#       The next artifact into <dir>: <prev-dir>'s runs.log plus the line,
#       and the given history.jsonl (this run's, already checked for the
#       token), or <prev-dir>'s when `-` (this run's can't be uploaded).
#       Both trimmed: history to the last QC_HISTORY_RUNS runs (default
#       60; the trend report shows 30, drift reads 5), runs.log to the
#       last 1000 lines.
set -euo pipefail

die() { printf 'history.sh: %s\n' "$*" >&2; exit 1; }

fetch() {
  local dir=$1 id tmp
  mkdir -p "$dir"
  : >"$dir/history.jsonl"
  : >"$dir/runs.log"
  [ -n "${GH_REPO:-}" ] || die "GH_REPO is unset"
  # Newest first by creation time, expired ones left out.
  id=$(gh api "repos/$GH_REPO/actions/artifacts?name=qc-history&per_page=100" \
    --jq '[.artifacts[] | select(.expired | not)] | sort_by(.created_at) | reverse | .[0].id // empty') ||
    die "could not list the qc-history artifacts"
  if [ -z "$id" ]; then
    echo "::notice::no qc-history artifact yet: this run starts the chain"
    return 0
  fi
  [[ $id =~ ^[0-9]+$ ]] || die "an artifact id that isn't a number"
  tmp=$(mktemp -d)
  gh api "repos/$GH_REPO/actions/artifacts/$id/zip" >"$tmp/a.zip" ||
    die "could not download qc-history artifact $id"
  unzip -qo "$tmp/a.zip" -d "$tmp/x" || die "qc-history artifact $id is not a zip"
  local f
  for f in history.jsonl runs.log; do
    if [ -f "$tmp/x/$f" ]; then cp "$tmp/x/$f" "$dir/$f"; fi
  done
  rm -rf "$tmp"
  echo "history: artifact $id, $(wc -l <"$dir/history.jsonl") history lines, $(wc -l <"$dir/runs.log") runs"
}

build() {
  local dir=$1 prev=$2 history=$3 line=$4 runs=${QC_HISTORY_RUNS:-60}
  [[ $runs =~ ^[0-9]+$ ]] && ((runs > 0)) || die "QC_HISTORY_RUNS must be a positive integer"
  [ "$history" != - ] || history=$prev/history.jsonl
  mkdir -p "$dir"
  # The last $runs runs by first appearance, in file order. A line jq
  # can't read is dropped rather than losing the whole file.
  if [ -s "$history" ]; then
    jq -cR 'fromjson? // empty' "$history" | jq -cs --argjson n "$runs" '
      (reduce (.[] | .runId) as $r ([]; if index([$r]) then . else . + [$r] end) | .[-$n:]) as $keep
      | .[] | select(.runId as $r | $keep | index([$r]))' >"$dir/history.jsonl"
  else
    : >"$dir/history.jsonl"
  fi
  { [ ! -f "$prev/runs.log" ] || cat "$prev/runs.log"; printf '%s\n' "$line"; } | tail -n 1000 >"$dir/runs.log"
}

case ${1:-} in
fetch) [ $# = 2 ] || die "usage: history.sh fetch <dir>"; fetch "$2" ;;
build) [ $# = 5 ] || die "usage: history.sh build <dir> <prev-dir> <history.jsonl|-> <line>"; build "$2" "$3" "$4" "$5" ;;
*) die "usage: history.sh fetch <dir> | build <dir> <prev-dir> <history.jsonl|-> <line>" ;;
esac
