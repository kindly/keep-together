#!/usr/bin/env bash
# QC's history on Actions: an artifact chain (plan gocardless-sandbox-qc.sv,
# g2q8). Each run fetches the last `qc-history` artifact, appends its own
# lines and uploads the result as a new one (kept 90 days), so drift,
# the trend report and the streak survive across runs without a branch to
# write to.
#
#   scripts/qc-actions/history.sh fetch <dir>
#       The last run's history.jsonl and runs.log into <dir> (both made
#       empty when there is none yet). Needs GH_TOKEN (actions: read) and
#       GH_REPO. Exit 1 if GitHub can't be asked or the artifact is
#       wrong: the run must not go on with an empty history and then
#       upload it as the newest, which would cut the chain.
#
#       Trusted only from this workflow's own runs: the newest unexpired
#       `qc-history` of a *completed qc.yml run on main of this repo*
#       (event schedule, workflow_dispatch or workflow_run; the head
#       repository this one). Never the newest artifact of that name
#       repo-wide: ci.yml runs a pull request's own workflow file, which
#       could upload one. The zip is read entry by entry (`unzip -p`), so
#       nothing is ever written to disk from it or followed as a link:
#       only `history.jsonl` and `runs.log`, plain files, each under
#       QC_HISTORY_MAX_BYTES (default 64 MiB), else refused. Then every
#       line is validated (sanitize, below).
#
#   scripts/qc-actions/history.sh sanitize <history.jsonl|-> <runs.log|->
#       Filters the files in place: history lines must be JSON objects
#       with a string runId and flow and an array samplesMs, under 1 MiB;
#       runs.log lines must have the shape report.sh writes. `-` skips one.
#       Anything else is dropped, with a count on stderr.
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

# The shape report.sh writes: time, run, event, commit, result, then
# key=value fields of words and numbers.
RUNS_LINE='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z run=([0-9]+|none) event=[a-z_]+ commit=([0-9a-f]{40}|none) result=(pass|fail|error|void|record)( [a-z-]+=[A-Za-z0-9.,_:-]*)*$'
MAX_LINE=1048576

sanitize() {
  local history=$1 runs=$2 tmp n before
  if [ "$history" != - ] && [ -f "$history" ]; then
    [ ! -L "$history" ] || die "$history is a link"
    tmp=$(mktemp)
    before=$(wc -l <"$history")
    awk -v max="$MAX_LINE" 'length($0) <= max' "$history" |
      jq -cR 'fromjson? | select(type == "object" and (.runId | type) == "string"
        and (.flow | type) == "string" and (.samplesMs | type) == "array")' >"$tmp" ||
      die "could not read $history"
    n=$(wc -l <"$tmp")
    ((n == before)) || echo "history.sh: dropped $((before - n)) history line(s) that aren't QC's" >&2
    cat "$tmp" >"$history"
    rm -f "$tmp"
  fi
  if [ "$runs" != - ] && [ -f "$runs" ]; then
    [ ! -L "$runs" ] || die "$runs is a link"
    tmp=$(mktemp)
    before=$(wc -l <"$runs")
    grep -E "$RUNS_LINE" "$runs" >"$tmp" || true
    n=$(wc -l <"$tmp")
    ((n == before)) || echo "history.sh: dropped $((before - n)) runs.log line(s) that aren't report.sh's" >&2
    cat "$tmp" >"$runs"
    rm -f "$tmp"
  fi
}

fetch() {
  local dir=$1 runs id aid tmp entries f max=${QC_HISTORY_MAX_BYTES:-67108864}
  mkdir -p "$dir"
  : >"$dir/history.jsonl"
  : >"$dir/runs.log"
  [ -n "${GH_REPO:-}" ] || die "GH_REPO is unset"
  # This workflow's completed runs on main of this repo, newest first.
  runs=$(gh api "repos/$GH_REPO/actions/workflows/qc.yml/runs?branch=main&status=completed&per_page=30" \
    --jq '[.workflow_runs[]
      | select(.head_branch == "main" and .path == ".github/workflows/qc.yml"
        and .repository.full_name == $ENV.GH_REPO
        and .head_repository.full_name == $ENV.GH_REPO
        and (.event == "schedule" or .event == "workflow_dispatch" or .event == "workflow_run"))]
      | sort_by(.created_at) | reverse | .[].id') ||
    die "could not list qc.yml's runs"
  aid=""
  for id in $runs; do
    [[ $id =~ ^[0-9]+$ ]] || die "a run id that isn't a number"
    aid=$(gh api "repos/$GH_REPO/actions/runs/$id/artifacts?name=qc-history" \
      --jq '[.artifacts[] | select(.name == "qc-history" and (.expired | not))] | .[0].id // empty') ||
      die "could not list run $id's artifacts"
    [ -z "$aid" ] || break
  done
  if [ -z "$aid" ]; then
    echo "::notice::no qc-history artifact from a qc.yml run on main yet: this run starts the chain"
    return 0
  fi
  [[ $aid =~ ^[0-9]+$ ]] || die "an artifact id that isn't a number"
  tmp=$(mktemp -d)
  gh api "repos/$GH_REPO/actions/artifacts/$aid/zip" >"$tmp/a.zip" ||
    die "could not download qc-history artifact $aid (run $id)"
  # Only the two names, as plain files: no other entry, no link.
  entries=$(unzip -Z1 "$tmp/a.zip") || die "qc-history artifact $aid is not a zip"
  while IFS= read -r f; do
    case $f in history.jsonl | runs.log) ;; *) die "qc-history artifact $aid holds $f" ;; esac
  done <<<"$entries"
  ! unzip -Z "$tmp/a.zip" | grep -qE '^l' || die "qc-history artifact $aid holds a link"
  for f in history.jsonl runs.log; do
    grep -qx "$f" <<<"$entries" || continue
    unzip -p "$tmp/a.zip" "$f" | head -c "$((max + 1))" >"$dir/$f" ||
      die "could not read $f from qc-history artifact $aid"
    (($(wc -c <"$dir/$f") <= max)) || die "$f in qc-history artifact $aid is over $max bytes"
  done
  rm -rf "$tmp"
  sanitize "$dir/history.jsonl" "$dir/runs.log"
  echo "history: artifact $aid of run $id, $(wc -l <"$dir/history.jsonl") history lines, $(wc -l <"$dir/runs.log") runs"
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
sanitize) [ $# = 3 ] || die "usage: history.sh sanitize <history.jsonl|-> <runs.log|->"; sanitize "$2" "$3" ;;
build) [ $# = 5 ] || die "usage: history.sh build <dir> <prev-dir> <history.jsonl|-> <line>"; build "$2" "$3" "$4" "$5" ;;
*) die "usage: history.sh fetch <dir> | sanitize <h> <r> | build <dir> <prev-dir> <history.jsonl|-> <line>" ;;
esac
