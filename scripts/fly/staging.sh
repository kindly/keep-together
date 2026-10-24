#!/usr/bin/env bash
# Create keep-staging on Fly (plan migration-rust.sv, step F2). The human
# runs it once; re-running is safe (each step checks first).
#
#   fly auth login
#   scripts/aws/backup.sh staging        # first: it prints the bucket secrets
#   scripts/fly/staging.sh
#
# Makes the app in lhr, its 1 GB volume keep_data, asks for any secret
# still missing, adds the certificate for staging.keep-together.org.uk and
# prints the Route 53 record to add, and a deploy token for GitHub.
# The first deploy is `fly deploy -c fly.staging.toml` (or a push to main).
set -euo pipefail
cd "$(dirname "$0")/../.."

APP=keep-staging
REGION=lhr
HOST=${HOST:-staging.keep-together.org.uk}
ORG=${FLY_ORG:-personal}

say() { printf '\n== %s\n' "$*"; }
run() { printf '+ %s\n' "$*" >&2; "$@"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

command -v fly >/dev/null || die "needs flyctl: https://fly.io/docs/flyctl/install/"
fly auth whoami >/dev/null || die "not signed in: fly auth login"

say "App $APP"
if fly apps list --json | grep -q "\"Name\": *\"$APP\""; then
  echo "exists"
else
  run fly apps create "$APP" --org "$ORG"
fi

say "Volume keep_data ($REGION, 1 GB)"
if fly volumes list -a "$APP" --json | grep -q '"Name": *"keep_data"'; then
  echo "exists"
else
  run fly volumes create keep_data -a "$APP" --region "$REGION" --size 1 --yes
fi

say "Secrets"
have=$(fly secrets list -a "$APP" --json | grep -o '"Name": *"[A-Z_]*"' | grep -o '[A-Z_]*"$' | tr -d '"')
missing=()
for s in LITESTREAM_BUCKET LITESTREAM_ACCESS_KEY_ID LITESTREAM_SECRET_ACCESS_KEY \
  KEEP_SNAPSHOT_BUCKET KEEP_SNAPSHOT_ACCESS_KEY_ID KEEP_SNAPSHOT_SECRET_ACCESS_KEY SENTRY_DSN; do
  grep -qx "$s" <<<"$have" || missing+=("$s")
done
if ((${#missing[@]})); then
  echo "missing: ${missing[*]}"
  echo "(the bucket and key values come from scripts/aws/backup.sh staging; SENTRY_DSN"
  echo " from the Sentry project's Client Keys page, EU region; empty skips it)"
  pairs=()
  for s in "${missing[@]}"; do
    read -r -s -p "$s: " v
    echo
    [[ -z $v ]] || pairs+=("$s=$v")
  done
  # --stage: applied by the next deploy, not by restarting a machine now.
  ((${#pairs[@]} == 0)) || { printf '+ fly secrets set -a %s --stage <%d values>\n' "$APP" "${#pairs[@]}" >&2
    fly secrets set -a "$APP" --stage "${pairs[@]}"; }
else
  echo "all set"
fi

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

say "Deploy token for GitHub Actions (deploy.yml)"
echo "  fly tokens create deploy -a $APP --expiry 8760h | gh secret set FLY_API_TOKEN"
echo "  gh variable set STAGING_URL --body https://$HOST"
echo
echo "First deploy: fly deploy -c fly.staging.toml   (or push to main)"
