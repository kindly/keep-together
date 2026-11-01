#!/usr/bin/env bash
# Mint the QC sandbox account's GoCardless token and stage it on keep-qc
# (plan gocardless-sandbox-qc.sv, step G1; the human runs it once, H2).
# The api's QC surface connects each run's qc- org with it, through the
# same code as the OAuth callback.
#
#   fly auth login
#   scripts/fly/gocardless-qc-token.sh
#
# 1. Type keep-qc's partner app client id and secret (the app made in the
#    QC sandbox account; not shown).
# 2. Open the printed link, log in AS THE QC ACCOUNT and approve. keep-qc
#    doesn't know this link's `state`, so its callback says the link has
#    expired, without using the code.
# 3. Paste the address it landed on (or just the code) within 5 minutes.
#
# The token is never printed, never in argv, never in a file: the
# exchange's form goes to curl on stdin, its answer stays in a variable,
# and the two secrets reach flyctl on stdin. Only the organisation id
# (OR…) is printed. Reconnecting disables the account's previous token,
# so running it again replaces the one on keep-qc.
set -euo pipefail

APP=keep-qc
ORIGIN=https://keep-qc.fly.dev
REDIRECT=$ORIGIN/api/gocardless/callback
CONNECT=https://connect-sandbox.gocardless.com
WINDOW=300 # GoCardless's codes last 5 minutes

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
# Form-encode stdin (a value never goes in jq's argv).
uri() { jq -sRr @uri; }

command -v fly >/dev/null || die "needs flyctl: https://fly.io/docs/flyctl/install/"
command -v jq >/dev/null || die "needs jq"
command -v curl >/dev/null || die "needs curl"
[ -t 0 ] || die "run it in a terminal: the secrets are typed, not piped"
printf '+ fly auth whoami\n' >&2
fly auth whoami >/dev/null || die "not signed in: fly auth login"

echo "keep-qc's GoCardless partner app (made in the QC sandbox account):"
IFS= read -rs -p "client id (not shown): " client_id
echo
IFS= read -rs -p "client secret (not shown): " client_secret
echo
[[ $client_id =~ ^[[:graph:]]+$ ]] || die "the client id is empty or has spaces"
[[ $client_secret =~ ^[[:graph:]]+$ ]] || die "the client secret is empty or has spaces"

state=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')
started=$(date +%s)
url="$CONNECT/oauth/authorize?response_type=code"
url+="&client_id=$(printf '%s' "$client_id" | uri)"
url+="&scope=read_write"
url+="&redirect_uri=$(printf '%s' "$REDIRECT" | uri)"
url+="&initial_view=login"
url+="&state=$state"
cat <<MSG

Open this, log in AS THE QC SANDBOX ACCOUNT, and approve:

  $url

keep-qc will say the link has expired: that's expected (it never sees
the code). Paste the address it landed on, or just the code.
MSG
IFS= read -rs -p "address or code (not shown): " pasted
echo
pasted=${pasted//[[:space:]]/}
[[ -n $pasted ]] || die "nothing pasted"

# One query parameter from the pasted address, without a process.
param() {
  local q=${pasted#*\?} pair
  q=${q%%#*}
  while [[ -n $q ]]; do
    pair=${q%%&*}
    [[ $pair == "$1="* ]] && { printf '%s' "${pair#*=}"; return; }
    [[ $q == *'&'* ]] && q=${q#*&} || q=
  done
}
if [[ $pasted == *[?]* ]]; then
  err=$(param error)
  [[ -z $err ]] || die "GoCardless answered $err (nothing was set)"
  got_state=$(param state)
  [[ $got_state == "$state" ]] ||
    die "that address is for a different link (its state isn't this run's): open the link printed above"
  code=$(param code)
else
  code=$pasted
fi
[[ $code =~ ^[A-Za-z0-9_-]+$ ]] || die "no code in what was pasted"
(($(date +%s) - started <= WINDOW)) || die "more than 5 minutes passed and the code has expired: run it again"

# The form, encoded here and sent on stdin (curl reads @- itself).
form="grant_type=authorization_code"
form+="&code=$code"
form+="&redirect_uri=$(printf '%s' "$REDIRECT" | uri)"
form+="&client_id=$(printf '%s' "$client_id" | uri)"
form+="&client_secret=$(printf '%s' "$client_secret" | uri)"
unset client_secret
printf '+ curl -sS -X POST %s/oauth/access_token --data-binary @- <the form on stdin>\n' "$CONNECT" >&2
answer=$(printf '%s' "$form" |
  curl -sS --max-time 30 -X POST "$CONNECT/oauth/access_token" \
    -H 'Accept: application/json' \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    --data-binary @-) || die "couldn't reach GoCardless (nothing was set)"
unset form

token=$(printf '%s' "$answer" | jq -r '.access_token // empty' 2>/dev/null || true)
org=$(printf '%s' "$answer" | jq -r '.organisation_id // empty' 2>/dev/null || true)
if [[ -z $token ]]; then
  # Only GoCardless's error code: never the rest of the answer.
  e=$(printf '%s' "$answer" | jq -r '(.error | if type == "object" then .type // .message else . end) // "no token in the answer"' 2>/dev/null || echo "an answer that isn't JSON")
  unset answer
  [[ $e =~ ^[[:alnum:]_\ .-]{1,80}$ ]] || e="an unreadable error"
  die "the exchange failed: $e (nothing was set)"
fi
unset answer
[[ $token =~ ^[[:graph:]]+$ ]] || die "the token GoCardless sent is malformed (nothing was set)"
[[ $org =~ ^OR[A-Z0-9]+$ ]] || die "no organisation id in the answer (nothing was set)"

printf '+ fly secrets import -a %s --stage <KEEP_QC_GOCARDLESS_TOKEN, KEEP_QC_GOCARDLESS_ORGANISATION on stdin>\n' "$APP" >&2
printf 'KEEP_QC_GOCARDLESS_TOKEN=%s\nKEEP_QC_GOCARDLESS_ORGANISATION=%s\n' "$token" "$org" |
  fly secrets import -a "$APP" --stage
unset token

echo "QC sandbox account: $org"
echo "staged on $APP: the next deploy applies them (fly deploy -c fly.qc.toml --ha=false, or a push to main)."
