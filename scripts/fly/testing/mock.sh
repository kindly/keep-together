#!/bin/bash
# fly, gh, curl and date for scripts/fly/*.test.mjs (stubs.mjs links them
# here). Logs argv like the wrapper, answers from $STUB_STATE's files, and
# logs what it reads on stdin as NUL-separated "<command>\n<body>" records.
# Uses only bash builtins and $STUB_REAL_PATH's jq.
set -euo pipefail
name=${0##*/}
S=$STUB_STATE
{ printf '%s' "$name"; printf '\x1f%s' "$@"; printf '\n'; } >>"$STUB_LOG/argv.log"
jq() {
  local IFS=: d
  for d in $STUB_REAL_PATH; do [[ -x $d/jq ]] && { "$d/jq" "$@"; return; }; done
  return 127
}
body=
take_stdin() {
  body=$(cat; printf x)
  body=${body%x}
  printf '%s %s\n%s\0' "$name" "$*" "$body" >>"$S/stdin.log"
}
answer() { if [[ -f $S/$1 ]]; then printf '%s\n' "$(<"$S/$1")"; else printf '%s\n' "${2-[]}"; fi; }
add_names() { # file, names on stdin (one per line)
  local cur
  cur=$(answer "$1")
  jq -c --argjson cur "$cur" -R -s '$cur + (split("\n") | map(select(. != "") | {name: .})) | unique_by(.name)' >"$S/$1.new"
  mv "$S/$1.new" "$S/$1"
}
# keep-staging's deploy (deploy.yml, env=staging): what the staged
# secrets and main's fly.staging.toml make of /healthz (main-at-push: what
# main holds by the time the human's push lands, if it differs).
deploy_staging() {
  local g toml
  rm -f "$S/fail-curl" # the machine is up again
  toml=$(answer main-at-push "$(answer gh-main-fly-staging-toml "")")
  if [[ $toml != *'KEEP_RESET_ON = "demand"'* ]]; then
    echo '{"ok":true,"resetGeneration":null}' >"$S/curl-answer"
  elif [[ -f $S/staged-KEEP_RESET_GENERATION ]]; then
    g=$(<"$S/staged-KEEP_RESET_GENERATION")
    printf '{"ok":true,"resetGeneration":"%s"}\n' "$g" >"$S/curl-answer"
  fi # demand, nothing staged: the generation it already had
}
fail_if() { [[ ! -f $S/fail-$1 ]] || { printf '%s\n' "$(<"$S/fail-$1")" >&2; exit 1; }; }

case $name in
fly)
  case "$*" in
  "auth whoami") echo "qc-test@example.com" ;;
  "apps list --json") fail_if fly-apps; answer fly-apps.json ;;
  "apps create keep-qc --org "*) echo '[{"Name":"keep-qc"}]' >"$S/fly-apps.json" ;;
  "volumes list -a keep-qc --json") answer fly-volumes.json ;;
  "volumes create keep_data -a keep-qc --region "*" --size 3 --yes")
    fail_if fly-volume-create
    jq -c --arg r "$7" '. + [{id: "vol_new_\($r)", name: "keep_data", region: $r, attached_machine_id: null}]' \
      <<<"$(answer fly-volumes.json)" >"$S/fly-volumes.json.new"
    mv "$S/fly-volumes.json.new" "$S/fly-volumes.json"
    ;;
  "volumes destroy "*" -a keep-qc --yes")
    fail_if fly-volume-destroy
    jq -e --arg id "$3" 'any(.[]; .id == $id and .attached_machine_id == null)' <<<"$(answer fly-volumes.json)" >/dev/null ||
      { echo "Error: volume $3 is attached or missing" >&2; exit 1; }
    jq -c --arg id "$3" 'map(select(.id != $id))' <<<"$(answer fly-volumes.json)" >"$S/fly-volumes.json.new"
    mv "$S/fly-volumes.json.new" "$S/fly-volumes.json"
    ;;
  "machines list -a keep-qc --json") answer fly-machines.json ;;
  "machine destroy "*" -a keep-qc --force")
    jq -c --arg id "$3" 'map(select(.id != $id))' <<<"$(answer fly-machines.json)" >"$S/fly-machines.json.new"
    mv "$S/fly-machines.json.new" "$S/fly-machines.json"
    jq -c --arg id "$3" 'map(if .attached_machine_id == $id then .attached_machine_id = null else . end)' \
      <<<"$(answer fly-volumes.json)" >"$S/fly-volumes.json.new"
    mv "$S/fly-volumes.json.new" "$S/fly-volumes.json"
    ;;
  "secrets list -a "*" --json") answer fly-secrets.json ;;
  "secrets import -a "*" --stage")
    fail_if fly-import
    take_stdin "$@"
    while IFS= read -r l; do [[ -z $l ]] || printf '%s\n' "${l%%=*}"; done <<<"$body" | add_names fly-secrets.json
    while IFS= read -r l; do
      [[ $l != KEEP_RESET_GENERATION=* ]] || printf '%s\n' "${l#*=}" >"$S/staged-KEEP_RESET_GENERATION"
    done <<<"$body"
    ;;
  "secrets unset --stage "*" -a keep-staging")
    jq -c --arg n "$4" 'map(select((.name // .Name) != $n))' <<<"$(answer fly-secrets.json)" >"$S/fly-secrets.json.new"
    mv "$S/fly-secrets.json.new" "$S/fly-secrets.json"
    ;;
  "tokens create deploy -a keep-qc --expiry 8760h")
    fail_if fly-token
    answer fly-deploy-token "FlyV1 fm2_mockdeploytoken_0123456789abcdef"
    ;;
  *) echo "fly mock: unexpected: $*" >&2; exit 2 ;;
  esac
  ;;
gh)
  case "$*" in
  "auth status") ;;
  "api -X PUT repos/{owner}/{repo}/environments/qc --input -") take_stdin "$@"; echo '{}' ;;
  "api repos/{owner}/{repo}/environments/qc/deployment-branch-policies --jq "*) answer gh-policies "" ;;
  "api -X POST repos/{owner}/{repo}/environments/qc/deployment-branch-policies --input -")
    take_stdin "$@"
    printf '%s\n' "$(jq -r '"\(.type):\(.name)"' <<<"$body")" >>"$S/gh-policies"
    echo '{}'
    ;;
  "secret list --env qc --json name") answer gh-secrets.json ;;
  "api -H Accept: application/vnd.github.raw repos/{owner}/{repo}/contents/fly.qc.toml?ref=main")
    fail_if gh-contents
    answer gh-main-fly-qc-toml ""
    ;;
  "api -H Accept: application/vnd.github.raw repos/{owner}/{repo}/contents/fly.staging.toml?ref=main")
    fail_if gh-contents
    answer gh-main-fly-staging-toml ""
    ;;
  "secret list --json name") answer gh-repo-secrets.json ;;
  "secret delete KEEP_QC_TOKEN")
    jq -c 'map(select(.name != "KEEP_QC_TOKEN"))' <<<"$(answer gh-repo-secrets.json)" >"$S/gh-repo-secrets.json.new"
    mv "$S/gh-repo-secrets.json.new" "$S/gh-repo-secrets.json"
    ;;
  "workflow run deploy.yml --ref main -f env=staging")
    deploy_staging
    echo "https://github.com/o/r/actions/runs/4343"
    ;;
  "run list --workflow "*" -L 20 --json databaseId,status") answer "gh-runs-$4.json" ;;
  "run list --workflow deploy.yml --event workflow_dispatch -L 1 --json databaseId --jq "*)
    answer gh-latest-dispatch 0
    ;;
  "workflow run deploy.yml --ref main -f env=qc")
    # What the deploy does on Fly when there's no machine: one in
    # primary_region (iad), on an unattached keep_data there if any.
    vol=$(jq -r 'map(select(.region == "iad" and .attached_machine_id == null)) | .[0].id // "vol_made_by_deploy"' \
      <<<"$(answer fly-volumes.json)")
    jq -c --arg v "$vol" 'if length == 0 then [{id: "m_iad", region: "iad"}] else . end' \
      <<<"$(answer fly-machines.json)" >"$S/fly-machines.json.new"
    mv "$S/fly-machines.json.new" "$S/fly-machines.json"
    jq -c --arg v "$vol" 'map(if .id == $v then .attached_machine_id = "m_iad" else . end)' \
      <<<"$(answer fly-volumes.json)" >"$S/fly-volumes.json.new"
    mv "$S/fly-volumes.json.new" "$S/fly-volumes.json"
    if [[ -f $S/gh-dispatch-no-url ]]; then echo 4242 >"$S/gh-latest-dispatch"; else
      echo "https://github.com/o/r/actions/runs/4242"; fi
    ;;
  "run watch "*" --exit-status") fail_if gh-run-watch; echo "run $3 completed" ;;
  "secret set "*" --env qc")
    take_stdin "$@"
    printf '%s\n' "$3" | add_names gh-secrets.json
    ;;
  *) echo "gh mock: unexpected: $*" >&2; exit 2 ;;
  esac
  ;;
curl)
  fail_if curl
  # push-after: the human's push to main deploys after that many polls.
  if [[ -f $S/push-after ]]; then
    n=$(<"$S/push-after")
    if ((n <= 1)); then rm -f "$S/push-after"; deploy_staging; else echo $((n - 1)) >"$S/push-after"; fi
  fi
  for a in "$@"; do [[ $a != @- ]] || take_stdin "$@"; done
  answer curl-answer '{}'
  ;;
date)
  # +%s: 1000, then 1000 + $(<date-step) on every later call.
  n=$(answer date-calls 0)
  printf '%s\n' $((n + 1)) >"$S/date-calls"
  ((n == 0)) && echo 1000 || echo $((1000 + $(answer date-step 0)))
  ;;
*) echo "mock: unknown $name" >&2; exit 2 ;;
esac
