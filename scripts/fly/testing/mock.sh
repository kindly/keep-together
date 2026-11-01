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
fail_if() { [[ ! -f $S/fail-$1 ]] || { printf '%s\n' "$(<"$S/fail-$1")" >&2; exit 1; }; }

case $name in
fly)
  case "$*" in
  "auth whoami") echo "qc-test@example.com" ;;
  "apps list --json") answer fly-apps.json ;;
  "apps create keep-qc --org "*) echo '[{"Name":"keep-qc"}]' >"$S/fly-apps.json" ;;
  "volumes list -a keep-qc --json") answer fly-volumes.json ;;
  "volumes create keep_data -a keep-qc --region lhr --size 3 --yes") echo '[{"name":"keep_data"}]' >"$S/fly-volumes.json" ;;
  "machines list -a keep-qc --json") answer fly-machines.json ;;
  "secrets list -a "*" --json") answer fly-secrets.json ;;
  "secrets import -a "*" --stage")
    fail_if fly-import
    take_stdin "$@"
    while IFS= read -r l; do [[ -z $l ]] || printf '%s\n' "${l%%=*}"; done <<<"$body" | add_names fly-secrets.json
    ;;
  "tokens create deploy -a keep-qc --expiry 8760h") answer fly-deploy-token "FlyV1 fm2_mockdeploytoken_0123456789abcdef" ;;
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
    printf '%s\n' "$(jq -r .name <<<"$body")" >>"$S/gh-policies"
    echo '{}'
    ;;
  "secret list --env qc --json name") answer gh-secrets.json ;;
  "secret set "*" --env qc")
    take_stdin "$@"
    printf '%s\n' "$3" | add_names gh-secrets.json
    ;;
  *) echo "gh mock: unexpected: $*" >&2; exit 2 ;;
  esac
  ;;
curl)
  fail_if curl
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
