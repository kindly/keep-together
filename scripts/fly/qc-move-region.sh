#!/usr/bin/env bash
# Move keep-qc from lhr to iad (Ashburn), next to GitHub's runners, so
# QC's page timings stop being mostly the Atlantic. Staging and prod stay
# in lhr. The human runs it once, after fly.qc.toml's primary_region =
# "iad" is on main; re-running is safe (each step checks first, and a
# keep-qc already in iad changes nothing).
#
#   fly auth login && gh auth login
#   scripts/fly/qc-move-region.sh
#
# Fly doesn't move a machine between regions: a deploy updates machines
# where they are, and primary_region only says where it creates new
# ones. So the move is: a keep_data volume in iad; the lhr machine and
# its volume destroyed; then a deploy, which finds no machine, creates
# one in primary_region (iad) and mounts the unattached keep_data there
# ("any volume with this name, in the same region, that isn't already
# mounted, may be mounted": fly.io/docs/reference/configuration, [mounts]).
# The volume is made first, at 3 GB like qc.sh's: left to the deploy,
# it would be [mounts]' default size. The machine goes before its
# volume, because Fly won't destroy an attached volume.
#
# The deploy is Actions' (deploy.yml, env=qc), built from main, never
# from a working tree. Nothing is lost that a deploy keeps: keep-qc is
# wiped and reseeded on every deploy. Secrets are the app's, not the
# machine's, so they stay; none is read or printed here.
set -euo pipefail
cd "$(dirname "$0")/../.."

APP=keep-qc
REGION=iad
ORIGIN=https://$APP.fly.dev
VOLUME=keep_data
# Seconds between polls (tests set 0).
POLL=${QC_MOVE_POLL:-5}

say() { printf '\n== %s\n' "$*"; }
run() { printf '+ %s\n' "$*" >&2; "$@"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

command -v fly >/dev/null || die "needs flyctl: https://fly.io/docs/flyctl/install/"
command -v gh >/dev/null || die "needs the GitHub CLI (gh): https://cli.github.com"
command -v jq >/dev/null || die "needs jq"
fly auth whoami >/dev/null || die "not signed in: fly auth login"
gh auth status >/dev/null 2>&1 || die "not signed in to GitHub: gh auth login"

# Main, on GitHub, must already deploy keep-qc to iad: otherwise the
# deploy below would make the new machine wherever main's fly.qc.toml
# says. The working tree proves nothing about what Actions builds.
say "main's fly.qc.toml"
toml=$(gh api -H 'Accept: application/vnd.github.raw' 'repos/{owner}/{repo}/contents/fly.qc.toml?ref=main') ||
  die "could not read fly.qc.toml on main through gh api"
grep -qx "primary_region = \"$REGION\"" <<<"$toml" ||
  die "main's fly.qc.toml doesn't say primary_region = \"$REGION\" yet: merge the change to main first"
echo "primary_region = \"$REGION\""

# Lists captured, then read: never `cmd | grep -q` under pipefail (qc.sh).
# Fields in either case (they differ between flyctl commands and versions).
machines() {
  local out
  out=$(fly machines list -a "$APP" --json) || die "fly machines list failed"
  jq -r '.[]? | "\(.id // .ID) \(.region // .Region)"' <<<"$out"
}
volumes() {
  local out
  out=$(fly volumes list -a "$APP" --json) || die "fly volumes list failed"
  jq -r --arg v "$VOLUME" \
    '.[]? | select((.name // .Name) == $v) | "\(.id // .ID) \(.region // .Region)"' <<<"$out"
}
outside() { awk -v r="$REGION" '$2 != r' <<<"$1" | grep . || true; }
inside() { awk -v r="$REGION" '$2 == r' <<<"$1" | grep . || true; }

say "$APP now"
m=$(machines)
v=$(volumes)
printf 'machines: %s\n' "$(tr '\n' ' ' <<<"${m:-none}")"
printf 'volumes:  %s\n' "$(tr '\n' ' ' <<<"${v:-none}")"
if [[ -n $(inside "$m") && -z $(outside "$m") && -z $(outside "$v") ]]; then
  echo "already in $REGION: nothing to move"
  moved=
else
  moved=1
fi

if [[ -n $moved ]]; then
  # A deploy or a QC run in flight would meet a machine that vanishes
  # (deploy-qc and QC share the concurrency group keep-qc; this script
  # isn't in it). Wait for them to finish, then run this again.
  say "Deploys and QC runs in flight"
  for wf in deploy.yml qc.yml; do
    busy=$(gh run list --workflow "$wf" -L 20 --json databaseId,status) ||
      die "gh run list --workflow $wf failed"
    busy=$(jq -r '.[]? | select(.status != "completed") | .databaseId' <<<"$busy")
    [[ -z $busy ]] ||
      die "$wf has runs in flight ($(paste -sd" " <<<"$busy")): let them finish (gh run watch), then run this again"
  done
  echo "none"

  say "1. Volume $VOLUME in $REGION (3 GB)"
  if [[ -n $(inside "$v") ]]; then
    echo "exists"
  else
    run fly volumes create "$VOLUME" -a "$APP" --region "$REGION" --size 3 --yes
  fi

  say "2. Machines outside $REGION"
  gone=$(outside "$m")
  if [[ -z $gone ]]; then
    echo "none"
  else
    # Ids into an array first: a command in a `while read` loop could
    # eat the rest of the list from its stdin.
    mapfile -t ids < <(awk '{print $1}' <<<"$gone")
    for id in "${ids[@]}"; do
      run fly machine destroy "$id" -a "$APP" --force
    done
  fi

  say "3. $VOLUME volumes outside $REGION"
  # Listed on its own line: a failure inside "$(…)" as an argument
  # would be lost, and read as no volumes.
  v=$(volumes)
  gone=$(outside "$v")
  if [[ -z $gone ]]; then
    echo "none"
  else
    mapfile -t ids < <(awk '{print $1}' <<<"$gone")
    for id in "${ids[@]}"; do
      # Fly may take a moment to see the destroyed machine let go.
      for try in 1 2 3 4 5 6; do
        run fly volumes destroy "$id" -a "$APP" --yes && break
        ((try < 6)) || die "could not destroy volume $id: fly volumes list -a $APP, then run this again"
        sleep "$POLL"
      done
    done
  fi

  say "4. Deploy from main through Actions (deploy.yml, env=qc)"
  # The newest dispatched run before ours, in case gh doesn't print
  # the new run's URL.
  before=$(gh run list --workflow deploy.yml --event workflow_dispatch -L 1 --json databaseId --jq '.[0].databaseId // 0') ||
    die "gh run list failed"
  out=$(run gh workflow run deploy.yml --ref main -f env=qc) || die "gh workflow run failed"
  printf '%s\n' "$out"
  id=
  if [[ $out =~ /actions/runs/([0-9]+) ]]; then id=${BASH_REMATCH[1]}; fi
  start=$(date +%s)
  while [[ -z $id ]]; do
    latest=$(gh run list --workflow deploy.yml --event workflow_dispatch -L 1 --json databaseId --jq '.[0].databaseId // 0') ||
      die "gh run list failed"
    if ((latest > before)); then id=$latest; break; fi
    (($(date +%s) - start < 120)) ||
      die "the dispatched run didn't show up: gh run list --workflow deploy.yml, then run this again"
    sleep "$POLL"
  done

  say "5. Waiting for run $id"
  run gh run watch "$id" --exit-status ||
    die "run $id failed: gh run view $id --log-failed (re-run this script once fixed)"
  echo "succeeded"
fi

say "$ORIGIN/healthz"
start=$(date +%s)
while :; do
  body=$(curl -fsS --max-time 5 "$ORIGIN/healthz" || true)
  [[ $(jq -r '.db // empty' <<<"$body" 2>/dev/null || true) == ok ]] && break
  (($(date +%s) - start < 150)) || die "$ORIGIN/healthz isn't ok (last: ${body:-no answer})"
  sleep "$POLL"
done
echo "ok (commit $(jq -r '.commit // "unknown"' <<<"$body"))"
m=$(machines)
[[ -n $(inside "$m") && -z $(outside "$m") ]] ||
  die "$APP's machines aren't all in $REGION: $(tr '\n' ' ' <<<"$m")"
v=$(volumes)
[[ -z $(outside "$v") ]] ||
  die "$APP still has $VOLUME volumes outside $REGION: fly volumes list -a $APP"

say "Done"
if [[ -n $moved ]]; then
  cat <<DONE
$APP runs in $REGION: one machine, its $VOLUME volume, deployed from main
by Actions. Its data, riverside and the GoCardless sandbox connection,
is reseeded on every deploy (KEEP_RESET_SEED; the QC account's token
is a secret on the app, and secrets don't move with machines), so
nothing needs restoring. QC's next run times against $REGION.
DONE
else
  echo "$APP was already in $REGION: nothing changed."
fi
