#!/usr/bin/env bash
# Create keep-qc on Fly: QC's own app (plan gocardless-sandbox-qc.sv, step
# A1). The human runs it once; re-running is safe (each step checks first).
#
#   fly auth login && gh auth login
#   scripts/fly/qc.sh
#
# Makes the app in lhr and its 3 GB volume keep_data; generates auth's
# keys, the riverside sign-ins and KEEP_QC_TOKEN (never shown: nobody
# signs in to keep-qc, and the token goes to Fly and to the GitHub
# environment `qc` on stdin); asks for SENTRY_DSN (optional); creates the
# GitHub environment `qc`, which only main may deploy to, with its
# FLY_API_TOKEN (a keep-qc deploy token, piped, never shown); then runs
# scripts/fly/gocardless-secrets.sh qc if the QC sandbox account's partner
# app secrets are missing (KEEP_GOCARDLESS=sandbox won't boot without
# them). No Litestream or snapshot buckets: keep-qc is wiped on every
# deploy. No DNS or certificate: https://keep-qc.fly.dev is the origin.
#
# It does not set the environment's QC_URL: that switches on deploy.yml's
# deploy-qc job, so it comes last, after the first deploy (it prints the
# command). Re-run it any time: it also checks the app still has one
# machine and one volume.
set -euo pipefail
cd "$(dirname "$0")/../.."

APP=keep-qc
REGION=lhr
ORIGIN=https://$APP.fly.dev
ORG=${FLY_ORG:-personal}
ENVIRONMENT=qc

say() { printf '\n== %s\n' "$*"; }
run() { printf '+ %s\n' "$*" >&2; "$@"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
# NAME=value pairs into Fly through stdin, never argv (argv shows in the
# process list). --stage: applied by the next deploy. printf is a bash
# builtin: no process carries the values in its argv.
import_secrets() {
  printf '+ fly secrets import -a %s --stage <%d values on stdin>\n' "$APP" "$#" >&2
  printf '%s\n' "$@" | fly secrets import -a "$APP" --stage
}

command -v fly >/dev/null || die "needs flyctl: https://fly.io/docs/flyctl/install/"
command -v gh >/dev/null || die "needs the GitHub CLI (gh): https://cli.github.com"
command -v jq >/dev/null || die "needs jq"
fly auth whoami >/dev/null || die "not signed in: fly auth login"
gh auth status >/dev/null 2>&1 || die "not signed in to GitHub: gh auth login"

# Names from flyctl's and gh's JSON lists, whichever case the field has
# (it differs between commands and versions). An empty list is normal.
names() { jq -r '.[]? | (.Name // .name // empty)'; }

say "App $APP"
if fly apps list --json | names | grep -qx "$APP"; then
  echo "exists"
else
  run fly apps create "$APP" --org "$ORG"
fi

say "Volume keep_data ($REGION, 3 GB)"
vols=$(fly volumes list -a "$APP" --json | names | grep -cx keep_data || true)
case $vols in
0) run fly volumes create keep_data -a "$APP" --region "$REGION" --size 3 --yes ;;
1) echo "exists" ;;
*) die "$APP has $vols keep_data volumes; keep one (fly volumes list -a $APP) and destroy the rest" ;;
esac
machines=$(fly machines list -a "$APP" --json | jq 'length' 2>/dev/null || echo 0)
((machines <= 1)) ||
  die "$APP has $machines machines; it must have one (fly machines list -a $APP, then fly machine destroy)"

say "GitHub environment $ENVIRONMENT (deployments from main only)"
# PUT is idempotent: it creates the environment or keeps it, and leaves
# its secrets and variables alone. Branch policy: custom, then main.
printf '+ gh api -X PUT repos/{owner}/{repo}/environments/%s <branch policy on stdin>\n' "$ENVIRONMENT" >&2
printf '%s' '{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}' |
  gh api -X PUT "repos/{owner}/{repo}/environments/$ENVIRONMENT" --input - >/dev/null
policies=$(gh api "repos/{owner}/{repo}/environments/$ENVIRONMENT/deployment-branch-policies" \
  --jq '.branch_policies[]? | select((.type // "branch") == "branch") | .name')
others=$(grep -vx main <<<"$policies" | grep . || true)
[[ -z $others ]] ||
  die "the $ENVIRONMENT environment also lets these deploy: $(tr '\n' ' ' <<<"$others")(only main may: remove them in the repo's Settings › Environments › $ENVIRONMENT)"
if grep -qx main <<<"$policies"; then
  echo "main only: set"
else
  printf '+ gh api -X POST repos/{owner}/{repo}/environments/%s/deployment-branch-policies <{"name":"main"} on stdin>\n' "$ENVIRONMENT" >&2
  printf '%s' '{"name":"main","type":"branch"}' |
    gh api -X POST "repos/{owner}/{repo}/environments/$ENVIRONMENT/deployment-branch-policies" --input - >/dev/null
fi
gh_secrets=$(gh secret list --env "$ENVIRONMENT" --json name | names || true)

say "Secrets"
have=$(fly secrets list -a "$APP" --json | names || true)
hex() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }
b32() { head -c 20 /dev/urandom | base32 | tr -d '=\n'; }
# Generated here, never typed and never printed:
# - auth's keys (api/src/auth/boot.rs), 32 random bytes each. A new
#   KEEP_SETTINGS_KEY would void enrolled authenticators; on keep-qc
#   nobody enrols, but it is still made only once.
# - the riverside sign-ins the reset seed reads: nobody signs in to
#   keep-qc (`fly ssh console -a keep-qc -C 'printenv …'` if ever needed).
# - KEEP_QC_TOKEN: /api/qc/*. It must match on Fly and in the GitHub
#   environment, so when either lacks it a new one goes to both.
gen=()
for s in KEEP_SETTINGS_KEY KEEP_AUTH_PEPPER; do
  grep -qx "$s" <<<"$have" || gen+=("$s=$(openssl rand -base64 32)")
done
for role in ADMIN STAFF VIEWER; do
  grep -qx "KEEP_RIVERSIDE_${role}_PASSWORD" <<<"$have" ||
    gen+=("KEEP_RIVERSIDE_${role}_PASSWORD=$(hex 24)")
  grep -qx "KEEP_RIVERSIDE_${role}_TOTP" <<<"$have" ||
    gen+=("KEEP_RIVERSIDE_${role}_TOTP=$(b32)")
done
qc_token=
if ! grep -qx KEEP_QC_TOKEN <<<"$have" || ! grep -qx KEEP_QC_TOKEN <<<"$gh_secrets"; then
  qc_token=$(hex 32)
  gen+=("KEEP_QC_TOKEN=$qc_token")
fi
if ((${#gen[@]})); then
  import_secrets "${gen[@]}"
  echo "generated: ${#gen[@]} (not shown)"
else
  echo "generated ones: all set"
fi
gen=()
if [[ -n $qc_token ]]; then
  printf '+ gh secret set KEEP_QC_TOKEN --env %s <stdin>\n' "$ENVIRONMENT" >&2
  printf '%s' "$qc_token" | gh secret set KEEP_QC_TOKEN --env "$ENVIRONMENT"
  echo "KEEP_QC_TOKEN set on $APP and in the GitHub environment $ENVIRONMENT"
fi
qc_token=
if ! grep -qx SENTRY_DSN <<<"$have"; then
  echo "SENTRY_DSN is optional (the Sentry project's Client Keys page, EU region); empty skips it."
  IFS= read -r -s -p "SENTRY_DSN (not shown): " dsn || dsn=
  echo
  if [[ -n $dsn ]]; then
    [[ $dsn =~ ^[[:graph:]]+$ ]] || die "SENTRY_DSN has spaces or control characters (nothing was set)"
    import_secrets "SENTRY_DSN=$dsn"
  fi
  dsn=
fi

say "Deploy token for the $ENVIRONMENT environment (FLY_API_TOKEN)"
if grep -qx FLY_API_TOKEN <<<"$gh_secrets"; then
  echo "set (to replace it: fly tokens create deploy -a $APP --expiry 8760h | gh secret set FLY_API_TOKEN --env $ENVIRONMENT)"
else
  # Piped from flyctl to gh: never on screen, never in argv.
  printf '+ fly tokens create deploy -a %s --expiry 8760h | gh secret set FLY_API_TOKEN --env %s\n' "$APP" "$ENVIRONMENT" >&2
  fly tokens create deploy -a "$APP" --expiry 8760h | gh secret set FLY_API_TOKEN --env "$ENVIRONMENT"
fi

say "GoCardless partner app secrets (the QC sandbox account's)"
gc_missing=()
for s in KEEP_GOCARDLESS_CLIENT_ID KEEP_GOCARDLESS_CLIENT_SECRET KEEP_GOCARDLESS_WEBHOOK_SECRET; do
  grep -qx "$s" <<<"$have" || gc_missing+=("$s")
done
if ((${#gc_missing[@]} == 0)); then
  echo "all set"
elif [[ -t 0 ]]; then
  echo "missing: ${gc_missing[*]}"
  echo "(from the partner app made in the QC sandbox account: redirect $ORIGIN/api/gocardless/callback,"
  echo " webhook $ORIGIN/api/gocardless/webhook)"
  run scripts/fly/gocardless-secrets.sh qc
else
  echo "missing: ${gc_missing[*]}: run scripts/fly/gocardless-secrets.sh qc in a terminal"
fi

say "Next"
cat <<NEXT
1. If you haven't yet: in the QC sandbox account (its own login, e.g. a +qc
   address), make a partner app with redirect $ORIGIN/api/gocardless/callback
   and webhook $ORIGIN/api/gocardless/webhook, then
   scripts/fly/gocardless-secrets.sh qc
2. First deploy: fly deploy -c fly.qc.toml --ha=false
   (--ha=false always: without it flyctl's first deploy makes two machines)
3. Switch on deploy.yml's deploy-qc job:
   gh variable set QC_URL --env $ENVIRONMENT --body $ORIGIN
4. Then scripts/fly/gocardless-qc-token.sh (log in as the QC account).
NEXT
