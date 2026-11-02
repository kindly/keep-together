#!/usr/bin/env bash
# Switch keep-staging to KEEP_RESET_ON=demand: its data and GoCardless
# connection survive deploys from then on (plan gocardless-sandbox-qc.sv,
# S1b; docs/ops.md "Staging"). The human runs it once, from a checkout
# that has it; re-running is safe (each step checks first, and a staging
# that is already kept changes nothing).
#
#   fly auth login && gh auth login
#   scripts/fly/staging-kept.sh
#
# In this order, because the entrypoint (scripts/ops/entrypoint.sh)
# refuses to boot under demand without KEEP_RESET_GENERATION:
#
# 1. Stages the first KEEP_RESET_GENERATION (a UTC timestamp, on stdin,
#    `--stage`): nothing restarts, and the deploy below applies it
#    together with the toml's demand. Set unstaged, it would restart
#    staging for nothing (deploy mode ignores it); left for after the
#    deploy, that deploy's machine would refuse to boot.
# 2. Stages the removal of staging's KEEP_QC_TOKEN, so /api/qc/* is 404
#    there (g2q3), and deletes the repo-wide GitHub secret of that name
#    (the house nightly's copy; keep-qc's lives on the environment `qc`).
# 3. The deploy, through Actions from main (deploy.yml), never from a
#    working tree. When main's fly.staging.toml already says demand it
#    dispatches one; until then it waits for you to merge and push, whose
#    Deploy run does the same.
# 4. Waits for /healthz to report the generation.
#
# That deploy wipes staging once more ("no reset generation recorded"),
# as every deploy did until now, and starts a fresh Litestream prefix
# staging/<generation> (nothing is restored). After it, deploys keep the
# data; scripts/fly/staging-reset.sh resets it when you ask.
set -euo pipefail
cd "$(dirname "$0")/../.."

APP=keep-staging
URL=${KEEP_STAGING_URL:-https://staging.keep-together.org.uk}
# Seconds: how long to wait for your push's deploy, and between polls.
WAIT=${KEEP_KEPT_WAIT:-3600}
POLL=${KEEP_KEPT_POLL:-5}

say() { printf '\n== %s\n' "$*"; }
run() { printf '+ %s\n' "$*" >&2; "$@"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

command -v fly >/dev/null || die "needs flyctl: https://fly.io/docs/flyctl/install/"
command -v gh >/dev/null || die "needs the GitHub CLI (gh): https://cli.github.com"
command -v jq >/dev/null || die "needs jq"
command -v curl >/dev/null || die "needs curl"
fly auth whoami >/dev/null || die "not signed in: fly auth login"
gh auth status >/dev/null 2>&1 || die "not signed in to GitHub: gh auth login"

# Names only, never values, in either case (flyctl's fields differ
# between versions). Captured, then grepped: never `cmd | grep -q`
# under pipefail.
fly_secrets() {
  local out
  out=$(fly secrets list -a "$APP" --json) || die "fly secrets list failed"
  jq -r '.[]? | (.Name // .name // empty)' <<<"$out"
}
# /healthz's resetGeneration: a name, "none" (answered, deploy mode) or
# "" (no answer).
generation_now() {
  local body
  body=$(curl -fsS --max-time 10 "$URL/healthz" 2>/dev/null || true)
  jq -r 'if type == "object" then (.resetGeneration // "none") else empty end' \
    <<<"$body" 2>/dev/null || true
}
main_demand() {
  local toml
  toml=$(gh api -H 'Accept: application/vnd.github.raw' 'repos/{owner}/{repo}/contents/fly.staging.toml?ref=main') ||
    die "could not read fly.staging.toml on main through gh api"
  # Review S1a M3: the generation is a Fly secret only.
  ! grep -Eq '^[[:space:]]*KEEP_RESET_GENERATION[[:space:]]*=' <<<"$toml" ||
    die "main's fly.staging.toml sets KEEP_RESET_GENERATION: it must be a Fly secret only (docs/ops.md \"Staging\")"
  grep -Eq '^[[:space:]]*KEEP_RESET_ON[[:space:]]*=[[:space:]]*"demand"' <<<"$toml"
}
no_deploys_in_flight() {
  local busy
  busy=$(gh run list --workflow deploy.yml -L 20 --json databaseId,status) ||
    die "gh run list --workflow deploy.yml failed"
  busy=$(jq -r '.[]? | select(.status != "completed") | .databaseId' <<<"$busy")
  [[ -z $busy ]] ||
    die "deploy.yml has runs in flight ($(paste -sd" " <<<"$busy")): let them finish (gh run watch), then run this again"
}

say "$APP now"
now=$(generation_now)
secrets=$(fly_secrets)
case $now in
none) echo "resets on every deploy" ;;
"")
  # Down. If a generation is already set, staging may be kept and only
  # unwell: a new generation would wipe it at the next deploy. Only a
  # failed switch (demand on main, no generation: the entrypoint
  # refuses) is mended here.
  grep -qx KEEP_RESET_GENERATION <<<"$secrets" &&
    die "$URL/healthz doesn't answer and KEEP_RESET_GENERATION is set: look first (fly logs -a $APP); nothing was changed"
  echo "no answer from $URL/healthz, and no KEEP_RESET_GENERATION: a switch that didn't finish"
  ;;
*) echo "kept: generation $now" ;;
esac

say "main's fly.staging.toml"
on_main=
if main_demand; then on_main=1; fi
echo "KEEP_RESET_ON = $([[ -n $on_main ]] && echo '"demand"' || echo "not \"demand\" yet")"
if [[ -z $on_main && $now != none ]]; then
  die "main's fly.staging.toml doesn't say demand, yet $APP" \
    "$([[ -z $now ]] && echo "doesn't answer" || echo "is kept"): look first (fly logs -a $APP;" \
    "git log main -- fly.staging.toml); nothing was changed"
fi

deploy=
case $now in
none | "")
  no_deploys_in_flight
  say "1. First reset generation (staged)"
  generation=$(date -u +%Y%m%dT%H%M%SZ)
  printf '+ fly secrets import -a %s --stage <KEEP_RESET_GENERATION=%s on stdin>\n' "$APP" "$generation" >&2
  printf 'KEEP_RESET_GENERATION=%s\n' "$generation" | fly secrets import -a "$APP" --stage
  deploy=1
  ;;
*)
  generation=$now
  say "1. First reset generation"
  echo "done: $generation"
  ;;
esac

say "2. Staging's QC token"
if grep -qx KEEP_QC_TOKEN <<<"$secrets"; then
  [[ -n $deploy ]] || no_deploys_in_flight
  run fly secrets unset --stage KEEP_QC_TOKEN -a "$APP"
  deploy=1
else
  echo "not on $APP"
fi
gh_secrets=$(gh secret list --json name) || die "gh secret list failed"
if jq -e 'any(.[]?; .name == "KEEP_QC_TOKEN")' <<<"$gh_secrets" >/dev/null; then
  # Repo-wide only: keep-qc's is on the environment `qc` (gh secret
  # list --env qc), which this neither lists nor deletes.
  run gh secret delete KEEP_QC_TOKEN
else
  echo "no repo-wide GitHub secret KEEP_QC_TOKEN"
fi

say "3. Deploy"
if [[ -z $deploy ]]; then
  echo "nothing staged: no deploy needed"
elif [[ -n $on_main ]]; then
  echo "main's fly.staging.toml says KEEP_RESET_ON = \"demand\": deploying main through Actions"
  before=$(gh run list --workflow deploy.yml --event workflow_dispatch -L 1 --json databaseId --jq '.[0].databaseId // 0') ||
    die "gh run list failed"
  out=$(run gh workflow run deploy.yml --ref main -f env=staging) || die "gh workflow run failed"
  printf '%s\n' "$out"
  id=
  if [[ $out =~ /actions/runs/([0-9]+) ]]; then id=${BASH_REMATCH[1]}; fi
  start=$SECONDS
  while [[ -z $id ]]; do
    latest=$(gh run list --workflow deploy.yml --event workflow_dispatch -L 1 --json databaseId --jq '.[0].databaseId // 0') ||
      die "gh run list failed"
    if ((latest > before)); then id=$latest; break; fi
    ((SECONDS - start < 120)) ||
      die "the dispatched run didn't show up: gh run list --workflow deploy.yml, then run this again"
    sleep "$POLL"
  done
  run gh run watch "$id" --exit-status ||
    die "run $id failed: gh run view $id --log-failed (then run this again: it stages a new generation)"
  WAIT=150
else
  cat <<NEXT
main's fly.staging.toml doesn't say KEEP_RESET_ON = "demand" yet. Merge the
branch that does (feat/staging-kept) and push main now: its Deploy run
applies what is staged here. Waiting up to $((WAIT / 60)) min for $URL/healthz
to report generation $generation. Ctrl-C is safe: run this again once
the deploy is done.
NEXT
fi

say "4. $URL/healthz"
deadline=$((SECONDS + WAIT))
while :; do
  seen=$(generation_now)
  [[ $seen != "$generation" ]] || break
  ((SECONDS < deadline)) ||
    die "after ${WAIT}s /healthz reports generation '${seen:-no answer}', not '$generation': fly logs -a $APP"
  sleep "$POLL"
done
echo "generation $generation"
secrets=$(fly_secrets)
! grep -qx KEEP_QC_TOKEN <<<"$secrets" ||
  die "$APP still has KEEP_QC_TOKEN: the deploy should have removed it (fly secrets list -a $APP)"

say "Done"
cat <<DONE
$APP is kept: deploys keep its data (generation $generation). /api/qc/*
is 404 there. To start again from a fresh riverside seed:
scripts/fly/staging-reset.sh. The old per-deploy Litestream prefixes
(staging/<image tag>) can go: docs/ops.md "Backups".
DONE
