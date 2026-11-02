#!/usr/bin/env bash
# The verdict of a QC run on Actions (.github/workflows/qc.yml; plan
# gocardless-sandbox-qc.sv, A2), as the retired house nightly gave it
# (docs/ops.md "Nightly QC"):
#
#   pass    QC passed against one deploy of keep-qc, latency judged
#   fail    QC failed: a test, a budget, a gate
#   error   the run broke before QC could judge (step=)
#   void    can't be trusted either way (reason=): keep-qc changed during
#           the run (commit-changed), keep-qc couldn't be asked afterwards
#           after a pass (qc-check-unknown), a worker over the RTT ceiling
#           (rtt-over-ceiling), flows with no budget on this target yet
#           (no-budgets: plan step A3 records them), or keep-qc running a
#           commit that isn't on main (commit-not-on-main: never run, and
#           it alerts the first time: a misdeploy or tampering)
#   record  a mode=record run: measured, nothing judged
#
# It writes one runs.log line (into the next qc-history artifact, built
# here), the job summary, and on fail or error opens the `qc-nightly`
# issue or comments on the open one. So do voids that keep coming: the
# last 2 runs void, or 36 h with no pass, fail or error. `no-budgets`
# voids never alert and never count among those voids, and they restart
# the 36 h clock (everything but latency was judged); record runs don't
# count at all.
#
# It never sees KEEP_QC_TOKEN. Everything it writes is built from the
# fields below, each checked to be a word or a number first.
#
# Env (from the workflow): QC_URL, COMMIT (what /healthz said at the
# start), MODE, STEPS ("name=outcome …" of the steps before QC, in order),
# QC_OUTCOME, QC_EXIT, QC_FLOWS, QC_OVER, QC_RTT, QC_RTTOVER, QC_RETRIES,
# QC_UNBUDGETED, QC_FAILED, QC_CHECK (run.sh's outputs), HISTORY_FETCHED
# (history.sh fetch succeeded), PREV (its dir), OUT (the next artifact's
# dir), RUN_ID, RUN_URL, EVENT, GH_TOKEN, GH_REPO, GITHUB_STEP_SUMMARY.
#
# Exit 0: pass, record, or a void that isn't lasting. 1: everything else.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)

word() { [[ ${1:-} =~ ^[A-Za-z0-9.,_:-]*$ ]] && printf '%s' "${1:-}"; }
num() { [[ ${1:-} =~ ^[0-9]+(\.[0-9]+)?$ ]] && printf '%s' "$1"; }
sha() { [[ ${1:-} =~ ^[0-9a-f]{40}$ ]] && printf '%s' "$1"; }

commit=$(sha "${COMMIT:-}")
run_id=$(num "${RUN_ID:-}")
event=$(word "${EVENT:-}")
mode=$(word "${MODE:-assert}")
qc_exit=$(num "${QC_EXIT:-}")
flows=$(num "${QC_FLOWS:-}")
over=$(num "${QC_OVER:-}")
rtt=$(num "${QC_RTT:-}")
rttover=$(num "${QC_RTTOVER:-}")
retries=$(num "${QC_RETRIES:-}")
unbudgeted=$(num "${QC_UNBUDGETED:-}")
failed=$(word "${QC_FAILED:-}")
runs_log=${PREV:-}/runs.log

# ---- the verdict --------------------------------------------------------------
result="" extra=""
# The first step before QC that didn't succeed (skipped ones follow a
# failure).
for s in ${STEPS:-}; do
  name=$(word "${s%%=*}") outcome=${s#*=}
  if [ "$name" = onmain ] && [ "$outcome" = failure ] && [ "${ONMAIN:-}" = not-on-main ]; then
    # keep-qc runs a commit that isn't on main: not run, no verdict, but
    # a misdeploy or tampering, so it alerts the first time (below). A
    # git error there is an error step=onmain, as any failing step.
    result=void extra="reason=commit-not-on-main"
    break
  elif [ "$outcome" != success ]; then
    result=error extra="step=${name:-unknown}"
    break
  fi
done

# keep-qc's commit now: "" when it couldn't be asked.
healthz_commit() {
  local body
  body=$(curl -fsS --max-time 10 --retry 2 "${QC_URL:-}/healthz") || return 0
  sha "$(jq -r '.commit // empty' <<<"$body" 2>/dev/null)"
}

if [ -z "$result" ]; then
  if [ "${QC_CHECK:-}" = refused ]; then
    result=error extra="step=artifact-check"
  elif [ "${QC_CHECK:-}" != clean ] || [ -z "$qc_exit" ]; then
    result=error extra="step=qc"
  else
    now=$(healthz_commit)
    fields="flows=${flows:-0} over=${over:-0} rtt=${rtt} rttover=${rttover:-0} retries=${retries:-0} unbudgeted=${unbudgeted:-0}"
    ((qc_exit == 0)) || fields="$fields exit=$qc_exit"
    if [ -n "$now" ] && [ "$now" != "$commit" ]; then
      result=void extra="$fields reason=commit-changed now=$now"
    elif [ -z "$now" ] && ((qc_exit != 0)); then
      # Can't tell whether keep-qc moved; a loud false fail beats a quiet one.
      result=fail extra="$fields qc-check=unknown"
    elif [ -z "$now" ]; then
      result=void extra="$fields reason=qc-check-unknown"
    elif [ "$mode" = record ]; then
      result=record extra="$fields"
    elif ((qc_exit != 0)); then
      result=fail extra="$fields"
    elif ((${flows:-0} == 0)); then
      result=error extra="$fields step=no-history-lines"
    elif ((${rttover:-0} > 0)); then
      result=void extra="$fields reason=rtt-over-ceiling"
    elif ((${unbudgeted:-0} > 0)); then
      result=void extra="$fields reason=no-budgets"
    else
      result=pass extra="$fields"
    fi
  fi
fi

# The history chain restarted (history.sh fetch found none to go on).
restarted=""
if [ "${HISTORY_CHAIN:-}" = restarted ]; then
  restarted="history chain RESTARTED: none of the last 100 qc.yml runs on main left a qc-history artifact, so drift and the streak start over from this run"
  extra="$extra history=restarted"
fi
line="$(date -u +%Y-%m-%dT%H:%M:%SZ) run=${run_id:-none} event=${event:-none} commit=${commit:-none} result=$result $extra"
line=${line% }
echo "runs.log: $line"

# ---- the next history artifact --------------------------------------------------
# Only when this run read the last one (else uploading would cut the
# chain), and with this run's history only when the check cleared it.
if [ "${HISTORY_FETCHED:-}" = true ] && [ -n "${OUT:-}" ]; then
  hist=-
  [ "${QC_CHECK:-}" != clean ] || hist=qc-results/history.jsonl
  "$here/history.sh" build "$OUT" "$PREV" "$hist" "$line" ||
    echo "::warning::could not build the next qc-history artifact"
fi

# ---- voids that keep coming ---------------------------------------------------
field() { sed -nE "s/.* $1=([^ ]*).*/\1/p" <<<"$2"; }
# The last 2 runs void (this one and the one before), or no pass, fail or
# error for 36 h (since the first run, if none yet). Prints why.
# Record runs judge nothing and don't count. A no-budgets void judged
# everything but latency (keep-qc before A3 recorded its set): it isn't one of the voids
# in a row, and it restarts the 36 h clock like a pass.
voids_persist() {
  local all judged since
  all=$( { [ ! -f "$runs_log" ] || cat "$runs_log"; printf '%s\n' "$line"; } | grep -v ' result=record' )
  if [ "$(grep -v ' reason=no-budgets' <<<"$all" | tail -n 2 | grep -cE ' result=void( |$)')" = 2 ]; then
    echo "The last 2 runs were void: no verdict, and the streak isn't moving."
    return 0
  fi
  judged=$(grep -E ' result=(pass|fail|error)( |$)| reason=no-budgets( |$)' <<<"$all" | tail -n 1)
  since=${judged:-$(head -n 1 <<<"$all")}
  since=${since%% *}
  (($(date +%s) - $(date -d "$since" +%s) > 36 * 3600)) || return 1
  echo "No pass or fail since $since (36 h): only void runs, and the streak isn't moving."
}

alert=0 note=""
case $result in
fail | error) alert=1 ;;
void)
  if [ "$(field reason "$line")" = commit-not-on-main ]; then
    alert=1 note="keep-qc serves $commit, which isn't on main: a deploy from somewhere else, or tampering. QC didn't run it."
  elif [ "$(field reason "$line")" != no-budgets ] && note=$(voids_persist); then
    alert=1
  fi
  ;;
esac

# ---- the summary and the issue ------------------------------------------------
{
  printf '### QC against keep-qc: %s%s\n\n' "$result" "${restarted:+ (HISTORY CHAIN RESTARTED)}"
  [ -z "$restarted" ] || printf '> **%s**\n\n' "$restarted"
  [ -z "$note" ] || printf '%s\n\n' "$note"
  printf -- '- commit: `%s`\n' "${commit:-unknown}"
  printf -- '- runs.log: `%s`\n' "$line"
  [ -z "$failed" ] || printf -- '- flows that failed: %s\n' "${failed//,/, }"
  [ "$(field reason "$line")" != no-budgets ] ||
    printf -- '- no budgets on this target yet for %s flows: latency recorded, not judged (A3)\n' "${unbudgeted:-?}"
} >>"${GITHUB_STEP_SUMMARY:-/dev/null}"

report_issue() {
  local body open title
  # shellcheck disable=SC2016 # backticks are markdown
  body=$(
    printf 'QC against keep-qc (GitHub Actions): **%s**\n\n' "$result"
    [ -z "$note" ] || printf '%s\n\n' "$note"
    [ -z "$restarted" ] || printf '**%s**\n\n' "$restarted"
    printf -- '- commit: %s\n' "${commit:-unknown}"
    printf -- '- runs.log: `%s`\n' "$line"
    [ -z "$failed" ] || printf -- '- flows that failed: %s\n' "${failed//,/, }"
    printf -- '- run: %s\n' "${RUN_URL:-unknown}"
    printf -- '- `scripts/qc-actions/status.sh` for the streak\n'
  )
  gh label create qc-nightly --color B60205 --description "QC alerts (Actions and the house nightly)" 2>/dev/null || true
  open=$(gh issue list --label qc-nightly --state open --json number --jq '.[0].number // empty') || return 1
  if [ -n "$open" ]; then
    gh issue comment "$open" --body "$body"
  else
    title="QC needs a look ($(date -u +%Y-%m-%dT%H:%MZ))"
    gh issue create --label qc-nightly --title "$title" --body "$body"
  fi
}

if ((alert)); then
  report_issue || echo "::error::could not open or comment on the qc-nightly issue"
  exit 1
fi
exit 0
