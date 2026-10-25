#!/usr/bin/env bash
# One nightly QC run against keep-staging (docs/ops.md, "Nightly QC").
# keep-qc-nightly.timer runs it at 03:00; by hand:
# ~/.local/share/keep-qc-nightly/bin/run.sh (or systemctl --user start
# keep-qc-nightly.service, which logs to the journal).
#
# 1. One run at a time (flock): a second one records `void` and exits.
# 2. Waits up to 5 min for the network (a catch-up run at boot can start
#    before it; user units can't order against network-online.target).
#    No DNS by then: void. DNS but gh failing: error step=gh.
# 3. Waits up to 45 min for a Deploy workflow still queued or running,
#    then takes the commit staging runs: the Deploy run that finished last
#    and got as far as its "Deploy keep-staging" step. If that step
#    succeeded, its commit; if it failed or was cancelled part-way,
#    staging could be on either image, so the run is void. Not
#    origin/main: a push may still be deploying, or have failed CI and
#    never reached staging. A deploy whose smoke test failed after flyctl
#    deploy still counts: that image is what staging serves.
# 4. Checks that commit out in src/, pnpm install --frozen-lockfile, and
#    Playwright's chromium (a no-op unless the Playwright version moved).
# 5. A quiet machine: the preview's update.lock if the preview is
#    installed (waiting out a build under way), then the main checkout's
#    .qc.lock (scripts/lockfile.mjs's format, so a local `pnpm qc` and the
#    preview's builds wait for it, and it waits for them).
# 6. Looks again: if a deploy started or another Deploy run finished
#    meanwhile (same commit or not), back to 3 (at most twice more). The
#    lock is re-dated just before QC, so the waits never make it look
#    stale.
# 7. `pnpm qc --target staging` with KEEP_QC_TOKEN read from qc-token
#    into that process's env only, then `pnpm qc:report`.
# 8. Looks again (3 tries): a deploy job started or another Deploy run
#    finished during the run.
# 9. One line in runs.log (fields in docs/ops.md). The result:
#    - pass: QC passed against one deploy, judged at the hosted RTT;
#    - fail: QC failed (the suite, a budget, a gate), or failed and
#      staging couldn't be checked afterwards (staging-check=unknown);
#    - error: the run broke before QC could judge anything;
#    - void, with reason=: the result can't be trusted either way (staging
#      redeployed or a deploy started during the run, a deploy still busy
#      after 45 min, the commit uncertain, latency not judged because the
#      RTT was over the ceiling, staging uncheckable after a pass, no
#      network, another run in progress). It ends the streak of passing
#      nights (status.sh) but isn't a failure.
#    fail and error open a GitHub issue labelled qc-nightly, or comment on
#    the open one; so do voids that keep coming (the last 2 runs, or 36 h
#    with no pass, fail or error), since a lasting one stalls the gate.
#
# Exit 0: pass, or a void that isn't lasting. Exit 1: everything else.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh source-path=SCRIPTDIR
. "$here/lib.sh"
load_config

# tee first, so it doesn't inherit run.lock's fd.
mkdir -p "$NIGHTLY/logs"
logfile=$NIGHTLY/logs/$(date +%Y%m%dT%H%M%S)-$$.log
exec > >(tee -a "$logfile") 2>&1

src=$NIGHTLY/src
slug=$(repo_slug)
history=$src/qc-results/history.jsonl
staging_url=${QC_STAGING_URL:-https://staging.keep-together.org.uk}
commit=""

# ---- the outcome --------------------------------------------------------------
report_issue() { # $1: the runs.log line, $2: the failing flows (or empty), $3: a note
  local title body open
  # shellcheck disable=SC2016 # backticks are markdown
  body=$(
    printf 'Nightly QC against staging: **%s**\n\n' "$(field result "$1")"
    [ -z "${3:-}" ] || printf '%s\n\n' "$3"
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
    title="Nightly QC needs a look ($(date -u +%Y-%m-%dT%H:%MZ))"
    run gh issue create -R "$slug" --label qc-nightly --title "$title" --body "$body"
  fi
}

# Voids that keep coming: the last 2 runs void, or no pass, fail or error
# for 36 h (since the first run, if none yet). Prints why.
voids_persist() {
  local runs=$NIGHTLY/runs.log judged since
  if [ "$(tail -n 2 "$runs" | grep -cE ' result=void( |$)')" = 2 ]; then
    echo "The last 2 runs were void: no verdict, and the gate isn't moving."
    return 0
  fi
  judged=$(grep -E ' result=(pass|fail|error)( |$)' "$runs" | tail -n 1)
  since=${judged:-$(head -n 1 "$runs")}
  since=${since%% *}
  (($(date +%s) - $(date -d "$since" +%s) > 36 * 3600)) || return 1
  echo "No pass or fail since $since (36 h): only void runs, and the gate isn't moving."
}

# Write the runs.log line, alert on fail, error and voids that keep
# coming, exit.
finish() { # $1: result, then key=value fields
  local result=$1 line failed="" note=""
  shift
  line="$(date -Is) commit=${commit:-none} result=$result $*"
  echo "$line" >>"$NIGHTLY/runs.log"
  log "runs.log: $line"
  # The last 30 logs (named by time, so the glob sorts them).
  local logs=("$NIGHTLY"/logs/*.log)
  ((${#logs[@]} <= 30)) || rm -f "${logs[@]:0:${#logs[@]}-30}"
  case $result in
  pass) exit 0 ;;
  void) note=$(voids_persist) || exit 0 ;;
  esac
  [ -z "${new_lines:-}" ] ||
    failed=$(jq -rs '[.[] | select(.pass == false) | .flow] | join(", ")' <<<"$new_lines" 2>/dev/null || true)
  report_issue "$line" "$failed" "$note" || log "could not open or comment the qc-nightly issue"
  exit 1
}
error() { finish error "step=$1"; }
void() { finish void "reason=$1"; }

exec 9>"$NIGHTLY/run.lock"
if ! flock -n 9; then
  log "another nightly run holds $NIGHTLY/run.lock; skipping"
  void another-run
fi

# ---- the network --------------------------------------------------------------
# Up to 5 min. DNS never answering is no network (void); DNS answering but
# gh failing is gh's fault (an expired token, a lost keyring): error.
dns_ok() { getent hosts "$(sed -E 's#^https?://([^/:]+).*#\1#' <<<"$staging_url")" >/dev/null; }
gh_ok() { gh api rate_limit >/dev/null 2>&1; }
for ((i = 0; ; i++)); do
  dns_ok && gh_ok && break
  if ((i >= 30)); then
    dns_ok || void no-network
    error gh
  fi
  ((i)) || log "waiting for the network (DNS for $staging_url, gh api)"
  sleep 10
done

# ---- which commit staging runs ------------------------------------------------
# Deploy runs not yet completed.
deploys_busy() {
  gh run list -R "$slug" --workflow deploy.yml --limit 20 --json status \
    --jq '[.[] | select(.status != "completed")] | length'
}
# Of those, the ones whose deploy job has started: staging may be changing.
deploys_deploying() {
  local id n=0 started
  while read -r id; do
    [ -n "$id" ] || continue
    started=$(gh run view "$id" -R "$slug" --json jobs --jq \
      '[.jobs[] | select(.name == "deploy" and (.status | IN("queued", "waiting", "pending", "requested") | not))] | length') ||
      return 1
    n=$((n + started))
  done < <(gh run list -R "$slug" --workflow deploy.yml --limit 20 --json databaseId,status \
    --jq '.[] | select(.status != "completed") | .databaseId')
  echo "$n"
}
# The Deploy run that finished last (by updatedAt, so a re-run of an old
# run counts when it ran) and reached its "Deploy keep-staging" step.
# Prints `<commit> <run id> <updatedAt>`: the run and its time tell a
# redeploy of the same commit (every deploy reseeds) from no deploy.
# Returns 0 if the step succeeded, 2 if it failed or was cancelled
# (staging on either image), 1 if gh failed or there's none.
staging_commit() {
  local id sha at step
  while read -r id sha at; do
    step=$(gh run view "$id" -R "$slug" --json jobs \
      --jq '[.jobs[].steps[] | select(.name == "Deploy keep-staging") | .conclusion] | first // empty') ||
      return 1
    case $step in
    success) echo "$sha $id $at"; return 0 ;;
    failure | cancelled | timed_out) echo "$sha $id $at"; return 2 ;;
    esac
  done < <(gh run list -R "$slug" --workflow deploy.yml --status completed --limit 20 \
    --json databaseId,headSha,updatedAt \
    --jq 'sort_by(.updatedAt) | reverse | .[] | "\(.databaseId) \(.headSha) \(.updatedAt)"')
  return 1
}

# Wait for deploys, then set $commit to what staging runs and $deployed to
# staging_commit's whole answer.
resolve() {
  local waited=0 busy rc=0
  while :; do
    busy=$(deploys_busy) || error deploy-status
    ((busy > 0)) || break
    ((waited < ${KEEP_QC_NIGHTLY_DEPLOY_WAIT:-2700})) || void deploy-busy
    ((waited > 0)) || log "waiting for $busy deploy run(s) to finish"
    sleep 60
    waited=$((waited + 60))
  done
  deployed=$(staging_commit) || rc=$?
  commit=${deployed%% *}
  case $rc in
  0) log "staging runs ${commit:0:12} (the last Deploy run that deployed it)" ;;
  2) void commit-uncertain ;;
  *) commit=""; error staging-commit ;;
  esac
}

# ---- the checkout -------------------------------------------------------------
checkout() {
  run git -C "$src" fetch --quiet origin main || error fetch
  # A deploy dispatched from a branch: fetch the commit itself.
  git -C "$src" cat-file -e "$commit^{commit}" 2>/dev/null ||
    run git -C "$src" fetch --quiet origin "$commit" || error "commit-missing"
  run git -C "$src" checkout --quiet --force --detach "$commit" || error checkout
  run git -C "$src" clean -fdq || error clean
  (cd "$src" && run pnpm install --frozen-lockfile --reporter=silent) || error "pnpm-install"
  (cd "$src" && run pnpm exec playwright install chromium) || error "playwright-install"
}

resolve
checkout
[ -s "$NIGHTLY/qc-token" ] || error "no-qc-token"

# ---- a quiet machine ----------------------------------------------------------
# The preview's builds skip while .qc.lock is held; this waits out one
# already under way (and keeps the next from starting). Taken first, so
# its wait doesn't age .qc.lock.
preview_lock=${KEEP_QC_NIGHTLY_PREVIEW_LOCK:-}
if [ -n "$preview_lock" ] && [ -f "$preview_lock" ]; then
  exec 8>>"$preview_lock"
  flock -w 3600 8 || log "the preview's update.lock is still held after an hour; going ahead"
fi

lock_token=$(cat /proc/sys/kernel/random/uuid)
qc_lock() { # $1: take | refresh | release; exit 0 done, 3 held (the holder on stdout)
  LOCK_PATH=$KEEP_QC_NIGHTLY_QC_LOCK LOCK_TOKEN=$lock_token LOCK_PID=$$ \
    LOCK_WHO="$NIGHTLY (qc-nightly)" LOCK_OP=$1 \
    node --input-type=module -e "
      import { tryLock, refreshLock, releaseLock } from '$src/scripts/lockfile.mjs'
      const e = process.env
      if (e.LOCK_OP === 'release') {
        releaseLock(e.LOCK_PATH, (l) => l?.token === e.LOCK_TOKEN)
      } else if (e.LOCK_OP === 'refresh') {
        // startedAt: what the preview's update.sh ages the lock by.
        if (!refreshLock(e.LOCK_PATH, e.LOCK_TOKEN, { startedAt: new Date().toISOString() }))
          process.exit(3)
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

# ---- still the same staging? --------------------------------------------------
for attempt in 1 2 3; do
  busy=$(deploys_busy) || error deploy-status
  rc=0
  now=$(staging_commit) || rc=$?
  ((rc != 2)) || void commit-uncertain
  ((rc == 0)) || error staging-commit
  ((busy == 0)) && [ "$now" = "$deployed" ] && break
  ((attempt < 3)) || void staging-kept-changing
  log "staging moved or a deploy started while waiting (${now:0:12}, $busy busy): preparing again"
  resolve
  checkout
done
qc_lock refresh >/dev/null || error "qc-lock-lost"

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
# retries: set-up calls sent again after no answer (qc/retries.ts); the
# same on every line of a run. Passing, but status.sh shows them.
read -r flows over rtt rttover retries < <(jq -rs '
  [length,
   (map(select(.overBudget > 0)) | length),
   (map(.rttMs) | sort | if length > 0 then .[length / 2 | floor] else "" end),
   (map(select(.rttOver == true)) | length),
   (.[0].setupRetries // {} | [.[]] | add // 0)]
  | map(tostring) | join(" ")' <<<"${new_lines:-}") || { flows=0 over=0 rtt='' rttover=0 retries=0; }
fields="flows=$flows over=$over rtt=$rtt rttover=${rttover:-0} retries=${retries:-0}"

# Staging as it is now: a deploy under way, or another Deploy run (even of
# the same commit: every deploy reseeds), means some of the run may have hit
# another image or a reset. gh gets 3 tries.
check_staging() { # sets changed: "" (same), the new answer, or unknown
  local deploying after rc=0
  deploying=$(deploys_deploying) || return 1
  after=$(staging_commit) || rc=$?
  ((rc != 1)) || return 1
  changed=""
  if [ "$after" != "$deployed" ] || ((rc == 2)) || ((deploying > 0)); then
    changed="${after%% *} ($deploying deploying)"
  fi
}
changed=unknown
for attempt in 1 2 3; do
  check_staging && break
  changed=unknown
  ((attempt == 3)) || sleep 20
done

if [ "$changed" = unknown ] && ((qc_rc != 0)); then
  # Can't tell whether staging moved; a loud false fail beats a quiet one.
  finish fail "$fields exit=$qc_rc staging-check=unknown"
elif [ "$changed" = unknown ]; then
  finish void "$fields reason=staging-check-unknown"
elif [ -n "$changed" ]; then
  log "staging changed during the run: now $changed"
  finish void "$fields reason=staging-changed-during-run now=${changed%% *} exit=$qc_rc"
elif ((qc_rc != 0)); then
  finish fail "$fields exit=$qc_rc"
elif ((flows == 0)); then
  finish error "$fields step=no-history-lines"
elif ((${rttover:-0} > 0)); then
  finish void "$fields reason=rtt-over-ceiling"
fi
finish pass "$fields"
