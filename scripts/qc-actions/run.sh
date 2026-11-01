#!/usr/bin/env bash
# The QC step of .github/workflows/qc.yml (plan gocardless-sandbox-qc.sv,
# A2): QC against keep-qc, the trend report, then the artifact token
# check. Run from the checkout of the commit keep-qc serves.
#
#   scripts/qc-actions/run.sh <prev-dir>
#
# <prev-dir> holds the last run's history.jsonl (history.sh fetch), which
# seeds qc-results/ so the reporter's drift and retry banners see the
# runs before this one.
#
# This is the only step that has KEEP_QC_TOKEN, in its env: from there it
# reaches `pnpm qc` and the check, never an argument, a file or the log.
# The check runs here because it needs the token's value, and nowhere
# else has it.
#
# Env: KEEP_QC_TOKEN, QC_TARGET_URL (keep-qc's origin), QC_MODE (assert
# or record), GITHUB_OUTPUT. QC_CHECK_ONLY=1 skips QC and the report (the
# workflow test drives the rest with a stub qc).
#
# Outputs (always, each a number or a word, never the run's text):
#   exit        pnpm qc's exit status
#   flows       history lines this run appended
#   over        flows with samples over budget
#   rtt         the median of the flows' RTTs (ms)
#   rttover     flows with a worker over the RTT ceiling
#   retries     set-up calls sent again after no answer
#   unbudgeted  flows timed with no budget on this target (not judged)
#   failed      the flows that failed, comma-separated (names only)
#   check       clean: nothing in qc-results/ or qc-report/ holds the
#               token, so they may be uploaded. Anything else (refused,
#               or missing because this script died) means they may not.
#
# Exit 0 when the check passed, whatever QC said (the report step judges
# QC); 1 when the check refused or the outputs can't be written.
set -uo pipefail
prev=${1:?usage: run.sh <prev-dir>}
here=$(cd "$(dirname "$0")" && pwd)
out=${GITHUB_OUTPUT:?GITHUB_OUTPUT is unset}

# A word or a number, else nothing: what reaches the outputs.
word() { [[ $1 =~ ^[A-Za-z0-9.,_:-]*$ ]] && printf '%s' "$1"; }
put() { printf '%s=%s\n' "$1" "$(word "$2")" >>"$out"; }

history=qc-results/history.jsonl
mkdir -p qc-results
# A plain file only, never followed as a link, and every line validated
# again (history.sh fetch already did): what seeds the reporter is QC's.
: >"$history"
if [ -f "$prev/history.jsonl" ] && [ ! -L "$prev/history.jsonl" ]; then
  cat "$prev/history.jsonl" >"$history"
  "$here/history.sh" sanitize "$history" - || : >"$history"
fi
before=$(wc -l <"$history")

qc_rc=0
if [ -z "${QC_CHECK_ONLY:-}" ]; then
  # The token is inherited from this step's env, never named here.
  pnpm qc --target qc || qc_rc=$?
  pnpm qc:report || echo "::warning::pnpm qc:report failed (the result stands)"
fi
put exit "$qc_rc"

new=$(tail -n +"$((before + 1))" "$history")
read -r flows over rtt rttover retries unbudgeted < <(jq -rs '
  [length,
   (map(select(.overBudget > 0)) | length),
   (map(.rttMs) | sort | if length > 0 then .[length / 2 | floor] else "" end),
   (map(select(.rttOver == true)) | length),
   (.[0].setupRetries // {} | [.[]] | add // 0),
   (map(select(.unbudgeted == true)) | length)]
  | map(tostring) | join(" ")' <<<"$new" 2>/dev/null) ||
  { flows=0 over=0 rtt='' rttover=0 retries=0 unbudgeted=0; }
failed=$(jq -rs '[.[] | select(.pass == false) | .flow] | join(",")' <<<"$new" 2>/dev/null || true)
put flows "${flows:-0}"
put over "${over:-0}"
put rtt "${rtt:-}"
put rttover "${rttover:-0}"
put retries "${retries:-0}"
put unbudgeted "${unbudgeted:-0}"
put failed "$failed"

# What the workflow uploads, all of it. A directory QC never made is
# made empty, so the check always covers the same set.
mkdir -p qc-report
if node "$here/check-artifacts.mjs" qc-results qc-report; then
  put check clean
  exit 0
fi
put check refused
exit 1
