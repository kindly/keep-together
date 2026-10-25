#!/usr/bin/env bash
# One nightly QC run against keep-staging (docs/ops.md, "Nightly QC").
# keep-qc-nightly.timer runs it at 03:00; by hand:
# ~/.local/share/keep-qc-nightly/bin/run.sh (or systemctl --user start
# keep-qc-nightly.service, which logs to the journal).
#
# 1. One run at a time (flock): a second one exits at once.
# 2. Waits (up to 45 min) for a Deploy workflow still queued or running,
#    then takes the commit staging runs: the newest completed Deploy run
#    whose "Deploy keep-staging" step succeeded. Not origin/main: a push
#    may still be deploying, or have failed CI and never reached staging.
#    A deploy whose smoke test failed after flyctl deploy still counts:
#    that image is what staging serves.
# 3. Checks that commit out in src/, pnpm install --frozen-lockfile, and
#    Playwright's chromium (a no-op unless the Playwright version moved).
# 4. A quiet machine: holds the main checkout's .qc.lock (scripts/
#    lockfile.mjs's format, so a local `pnpm qc` and the preview's builds
#    wait for it, and it waits for them), and the preview's update.lock
#    if the preview is installed (so no build is mid-way).
# 5. `pnpm qc --target staging` with KEEP_QC_TOKEN read from qc-token
#    into that process's env only, then `pnpm qc:report`.
# 6. One line in runs.log: time, commit, result (pass | fail | error),
#    flows timed, flows over budget, median RTT, and `redeployed=<sha>`
#    when staging changed under the run. Anything but pass opens a GitHub
#    issue labelled qc-nightly, or comments on the open one.
#
# Exit 0: passed, or another run was in progress. Exit 1: anything else.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh source-path=SCRIPTDIR
. "$here/lib.sh"
load_config

exec 9>"$NIGHTLY/run.lock"
if ! flock -n 9; then
  log "another nightly run is in progress; skipping"
  exit 0
fi

mkdir -p "$NIGHTLY/logs"
logfile=$NIGHTLY/logs/$(date +%Y%m%dT%H%M%S)-$$.log
exec > >(tee -a "$logfile") 2>&1

src=$NIGHTLY/src
slug=$(repo_slug)
history=$src/qc-results/history.jsonl
commit=""

# ---- the outcome --------------------------------------------------------------
report_issue() { # $1: the runs.log line, $2: the failing flows (or empty)
  local title body open
  # shellcheck disable=SC2016 # backticks are markdown
  body=$(
    printf 'Nightly QC against staging: **%s**\n\n' "$(field result "$1")"
    printf -- '- commit: %s\n' "${commit:-unknown}"
    printf -- '- runs.log: `%s`\n' "$1"
    [ -z "$2" ] || printf -- '- flows that failed: %s\n' "$2"
    printf -- '- full output on the QC machine: `%s`\n' "${logfile/#"$HOME"/\~}"
    printf -- '- `~/.local/share/keep-qc-nightly/bin/status.sh` for the streak\n'
  )
  run gh label create qc-nightly -R "$slug" --color B60205 --description "scripts/qc-nightly alerts" 2>/dev/null || true
  open=$(gh issue list -R "$slug" --label qc-nightly --state open --json number --jq '.[0].number // empty') || return 1
  if [ -n "$open" ]; then
    run gh issue comment "$open" -R "$slug" --body "$body"
  else
    title="Nightly QC failing ($(date -u +%Y-%m-%dT%H:%MZ))"
    run gh issue create -R "$slug" --label qc-nightly --title "$title" --body "$body"
  fi
}

# Write the runs.log line, alert on anything but pass, exit.
finish() { # $1: result, then key=value fields
  local result=$1 line failed=""
  shift
  line="$(date -Is) commit=${commit:-none} result=$result $*"
  echo "$line" >>"$NIGHTLY/runs.log"
  log "runs.log: $line"
  # The last 30 logs (named by time, so the glob sorts them).
  local logs=("$NIGHTLY"/logs/*.log)
  ((${#logs[@]} <= 30)) || rm -f "${logs[@]:0:${#logs[@]}-30}"
  if [ "$result" = pass ]; then
    exit 0
  fi
  [ -z "${new_lines:-}" ] ||
    failed=$(jq -rs '[.[] | select(.pass == false) | .flow] | join(", ")' <<<"$new_lines" 2>/dev/null || true)
  report_issue "$line" "$failed" || log "could not open or comment the qc-nightly issue"
  exit 1
}
error() { finish error "flows=0 over=0 rtt= step=$1"; }

# ---- which commit staging runs ------------------------------------------------
deploys_busy() {
  gh run list -R "$slug" --workflow deploy.yml --limit 20 --json status \
    --jq '[.[] | select(.status != "completed")] | length'
}
# The newest completed Deploy run whose staging deploy step succeeded.
staging_commit() {
  local id sha step
  while read -r id sha; do
    step=$(gh run view "$id" -R "$slug" --json jobs \
      --jq '[.jobs[].steps[] | select(.name == "Deploy keep-staging") | .conclusion] | first // empty') ||
      return 1
    if [ "$step" = success ]; then
      echo "$sha"
      return 0
    fi
  done < <(gh run list -R "$slug" --workflow deploy.yml --status completed --limit 20 \
    --json databaseId,headSha --jq '.[] | "\(.databaseId) \(.headSha)"')
  return 1
}

waited=0
while busy=$(deploys_busy) && ((busy > 0)); do
  if ((waited >= ${KEEP_QC_NIGHTLY_DEPLOY_WAIT:-2700})); then
    log "a deploy is still running after ${waited} s; going ahead"
    break
  fi
  ((waited > 0)) || log "waiting for $busy deploy run(s) to finish"
  sleep 60
  waited=$((waited + 60))
done
commit=$(staging_commit) || error staging-commit
log "staging runs ${commit:0:12} (the last Deploy run that deployed it)"

# ---- the checkout -------------------------------------------------------------
run git -C "$src" fetch --quiet origin main || error fetch
# A deploy dispatched from a branch: fetch the commit itself.
git -C "$src" cat-file -e "$commit^{commit}" 2>/dev/null ||
  run git -C "$src" fetch --quiet origin "$commit" || error "commit-missing"
run git -C "$src" checkout --quiet --force --detach "$commit" || error checkout
run git -C "$src" clean -fdq || error clean
(cd "$src" && run pnpm install --frozen-lockfile --reporter=silent) || error "pnpm-install"
(cd "$src" && run pnpm exec playwright install chromium) || error "playwright-install"
[ -s "$NIGHTLY/qc-token" ] || error "no-qc-token"

# ---- a quiet machine ----------------------------------------------------------
lock_token=$(cat /proc/sys/kernel/random/uuid)
qc_lock() { # $1: take | release; exit 0 done, 3 held (the holder on stdout)
  LOCK_PATH=$KEEP_QC_NIGHTLY_QC_LOCK LOCK_TOKEN=$lock_token LOCK_PID=$$ \
    LOCK_WHO="$NIGHTLY (qc-nightly)" LOCK_OP=$1 \
    node --input-type=module -e "
      import { tryLock, releaseLock } from '$src/scripts/lockfile.mjs'
      const e = process.env
      if (e.LOCK_OP === 'release') {
        releaseLock(e.LOCK_PATH, (l) => l?.token === e.LOCK_TOKEN)
      } else {
        const holder = tryLock(e.LOCK_PATH, {
          pid: Number(e.LOCK_PID), worktree: e.LOCK_WHO,
          startedAt: new Date().toISOString(), token: e.LOCK_TOKEN,
        }, { maxAgeMs: 2 * 60 * 60 * 1000, label: 'QC lock' })
        if (holder) {
          console.log(\`pid \${holder.pid}, \${holder.worktree ?? '?'}, since \${holder.startedAt ?? '?'}\`)
          process.exit(3)
        }
      }"
}
# shellcheck disable=SC2329 # the EXIT trap's
release_lock() { qc_lock release >/dev/null 2>&1 || true; }
announced=0
while :; do
  rc=0
  holder=$(qc_lock take) || rc=$?
  ((rc == 0)) && break
  ((rc == 3)) || error "qc-lock"
  ((announced)) || log "waiting for the QC lock ($holder): $KEEP_QC_NIGHTLY_QC_LOCK"
  announced=1
  sleep 10
done
trap release_lock EXIT
log "holding $KEEP_QC_NIGHTLY_QC_LOCK"
# The preview's builds skip while .qc.lock is held; this waits out one
# already under way (and keeps the next from starting).
preview_lock=${KEEP_QC_NIGHTLY_PREVIEW_LOCK:-}
if [ -n "$preview_lock" ] && [ -f "$preview_lock" ]; then
  exec 8>>"$preview_lock"
  flock -w 3600 8 || log "the preview's update.lock is still held after an hour; going ahead"
fi

# ---- the run ------------------------------------------------------------------
mkdir -p "$(dirname "$history")"
touch "$history"
before=$(wc -l <"$history")
qc=(pnpm qc --target staging)
qc_rc=0
printf '+ %s  (KEEP_QC_TOKEN from %s)\n' "${qc[*]}" "$NIGHTLY/qc-token" >&2
(
  cd "$src"
  KEEP_QC_TOKEN=$(<"$NIGHTLY/qc-token")
  export KEEP_QC_TOKEN
  exec "${qc[@]}" 9>&- 8>&-
) || qc_rc=$?
(cd "$src" && run pnpm qc:report) || log "pnpm qc:report failed (the result stands)"

new_lines=$(tail -n +"$((before + 1))" "$history")
read -r flows over rtt < <(jq -rs '
  [length,
   (map(select(.overBudget > 0)) | length),
   (map(.rttMs) | sort | if length > 0 then .[length / 2 | floor] else "" end)]
  | map(tostring) | join(" ")' <<<"${new_lines:-}") || { flows=0 over=0 rtt=; }

after=$(staging_commit) || after=""
extra=""
if [ -n "$after" ] && [ "$after" != "$commit" ]; then
  log "staging was redeployed during the run: ${after:0:12}"
  extra=" redeployed=$after"
fi

fields="flows=$flows over=$over rtt=$rtt$extra"
if ((qc_rc != 0)); then
  finish fail "$fields exit=$qc_rc"
elif ((flows == 0)); then
  finish error "$fields step=no-history-lines"
fi
finish pass "$fields"
