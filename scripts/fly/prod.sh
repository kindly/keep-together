#!/usr/bin/env bash
# Create keep-prod on Fly (plan migration-rust.sv, C2). The human runs it
# once; re-running is safe (each step checks first). Mirrors staging.sh,
# without staging's conveniences: no reset seed, no riverside sign-ins, no
# QC token. Real data lives here.
#
#   fly auth login
#   scripts/aws/backup.sh prod           # first: it prints the bucket secrets
#   scripts/aws/ses-sender.sh            # KEEP_SMTP_URL (docs/ops.md "Mail")
#   scripts/fly/prod.sh
#
# Makes the app in lhr, its 10 GB volume keep_data, generates auth's keys,
# asks for any secret still missing, adds the certificate for
# app.keep-together.org.uk and prints the Route 53 record to add, the
# GitHub variable that switches deploy.yml's prod path on, and the first
# deploy. Re-run it any time: it also checks the app still has one machine
# and one volume.
set -euo pipefail
cd "$(dirname "$0")/../.."

APP=keep-prod
REGION=lhr
HOST=${HOST:-app.keep-together.org.uk}
ORG=${FLY_ORG:-personal}

say() { printf '\n== %s\n' "$*"; }
run() { printf '+ %s\n' "$*" >&2; "$@"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
# NAME=value pairs into Fly through stdin, never argv (argv shows in the
# process list). --stage: applied by the next deploy.
import_secrets() {
  printf '+ fly secrets import -a %s --stage <%d values on stdin>\n' "$APP" "$#" >&2
  printf '%s\n' "$@" | fly secrets import -a "$APP" --stage
}

command -v fly >/dev/null || die "needs flyctl: https://fly.io/docs/flyctl/install/"
command -v jq >/dev/null || die "needs jq"
fly auth whoami >/dev/null || die "not signed in: fly auth login"

# Names from flyctl's JSON lists, whichever case the field has (it differs
# between commands and versions). An empty list is normal on a new app.
names() { jq -r '.[]? | (.Name // .name // empty)'; }

say "App $APP"
if fly apps list --json | names | grep -qx "$APP"; then
  echo "exists"
else
  run fly apps create "$APP" --org "$ORG"
fi

say "Volume keep_data ($REGION, 10 GB)"
# One machine, one volume: a second copy of the data would replicate to
# the same Litestream prefix as the first. `fly volumes extend` grows it (scripts/fly/volume-size.sh).
vols=$(fly volumes list -a "$APP" --json | names | grep -cx keep_data || true)
case $vols in
0) run fly volumes create keep_data -a "$APP" --region "$REGION" --size 10 --yes ;;
1) echo "exists" ;;
*) die "$APP has $vols keep_data volumes; keep one (fly volumes list -a $APP) and destroy the rest" ;;
esac
machines=$(fly machines list -a "$APP" --json | jq 'length' 2>/dev/null || echo 0)
((machines <= 1)) ||
  die "$APP has $machines machines; it must have one (fly machines list -a $APP, then fly machine destroy)"

say "Secrets"
have=$(fly secrets list -a "$APP" --json | names || true)
# Auth's keys (server/crates/api/src/auth/boot.rs): 32 random bytes each,
# made here once. Never replace KEEP_SETTINGS_KEY on a live app: enrolled
# authenticator apps are sealed under it.
generated=()
for s in KEEP_SETTINGS_KEY KEEP_AUTH_PEPPER; do
  grep -qx "$s" <<<"$have" || generated+=("$s=$(openssl rand -base64 32)")
done
((${#generated[@]} == 0)) || import_secrets "${generated[@]}"
missing=()
for s in LITESTREAM_BUCKET LITESTREAM_ACCESS_KEY_ID LITESTREAM_SECRET_ACCESS_KEY \
  KEEP_SNAPSHOT_BUCKET KEEP_SNAPSHOT_ACCESS_KEY_ID KEEP_SNAPSHOT_SECRET_ACCESS_KEY \
  KEEP_SMTP_URL SENTRY_DSN; do
  grep -qx "$s" <<<"$have" || missing+=("$s")
done
if ((${#missing[@]})); then
  echo "missing: ${missing[*]}"
  echo "(the bucket and key values come from scripts/aws/backup.sh prod; KEEP_SMTP_URL from"
  echo " scripts/aws/ses-sender.sh; SENTRY_DSN from the Sentry project's Client Keys page,"
  echo " EU region; empty skips it. KEEP_APP_ORIGIN, KEEP_CLIENT_IP_HEADER and KEEP_MAIL are"
  echo " in fly.prod.toml: docs/ops.md)"
  pairs=()
  for s in "${missing[@]}"; do
    read -r -s -p "$s: " v
    echo
    [[ -z $v ]] || pairs+=("$s=$v")
  done
  # --stage: applied by the next deploy, not by restarting a machine now.
  ((${#pairs[@]} == 0)) || import_secrets "${pairs[@]}"
else
  echo "all set"
fi
# KEEP_MAIL=smtp with no KEEP_SMTP_URL sends to Mailpit's default
# (localhost:1025): nothing would arrive. Say so before a deploy.
have=$(fly secrets list -a "$APP" --json | names || true)
grep -qx KEEP_SMTP_URL <<<"$have" ||
  echo "note: KEEP_SMTP_URL is still missing: no sign-in or invite mail will arrive until it is set"

say "Certificate for $HOST"
fly certs show "$HOST" -a "$APP" >/dev/null 2>&1 || run fly certs add "$HOST" -a "$APP"
echo
echo "Add this record in Route 53 (hosted zone keep-together.org.uk, account keep-prod):"
echo "  $HOST.  CNAME  300  $APP.fly.dev."
echo "e.g.:"
cat <<CMD
  zone=\$(aws route53 list-hosted-zones-by-name --profile keep-prod --dns-name keep-together.org.uk \\
    --query 'HostedZones[0].Id' --output text)
  aws route53 change-resource-record-sets --profile keep-prod --hosted-zone-id "\$zone" --change-batch \\
    '{"Changes":[{"Action":"UPSERT","ResourceRecordSet":{"Name":"$HOST","Type":"CNAME","TTL":300,"ResourceRecords":[{"Value":"$APP.fly.dev"}]}}]}'
CMD
echo "then: fly certs check $HOST -a $APP"

say "GitHub Actions (deploy.yml's prod path, health.yml)"
# Prod deploys only by hand (workflow_dispatch env=prod), and only once
# PROD_URL is set: deploy.yml refuses before that. The token goes in the
# GitHub environment `prod`, so staging's job can't use it.
echo "  fly tokens create deploy -a $APP --expiry 8760h | gh secret set FLY_API_TOKEN --env prod"
echo "  gh variable set PROD_URL --body https://$HOST"
echo
echo "First deploy: fly deploy -c fly.prod.toml --ha=false"
echo "  (or: gh workflow run deploy.yml -f env=prod, once PROD_URL is set)"
echo "(--ha=false always: without it flyctl's first deploy makes two machines and two volumes)"
