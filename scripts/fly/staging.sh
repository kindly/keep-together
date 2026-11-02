#!/usr/bin/env bash
# Create keep-staging on Fly (plan migration-rust.sv, step F2). The human
# runs it once; re-running is safe (each step checks first).
#
#   fly auth login
#   scripts/aws/backup.sh staging        # first: it prints the bucket secrets
#   scripts/fly/staging.sh
#
# Makes the app in lhr, its 10 GB volume keep_data, asks for any secret
# still missing, generates the riverside sign-ins (printed once: note
# them) and a first KEEP_RESET_GENERATION if missing (fly.staging.toml's
# KEEP_RESET_ON=demand won't boot without one), adds the certificate for
# staging.keep-together.org.uk and prints the Route 53 record to add, and
# a deploy token for GitHub. No QC token: QC runs against keep-qc
# (scripts/fly/qc.sh), and /api/qc/* stays 404 on staging.
# The first deploy is `fly deploy -c fly.staging.toml --ha=false` (or a
# push to main). Re-run it any time: it also checks the app still has one
# machine and one volume.
set -euo pipefail
cd "$(dirname "$0")/../.."

APP=keep-staging
REGION=lhr
HOST=${HOST:-staging.keep-together.org.uk}
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

# Captured, then grepped: never `cmd | grep -q` under pipefail. grep -q
# quits at its match, the writer can die of SIGPIPE, and pipefail then
# reads a match as a miss (here: a second `apps create`).
say "App $APP"
apps=$(fly apps list --json) || die "fly apps list failed"
apps=$(names <<<"$apps") || die "could not read fly apps list's answer"
if grep -qx -- "$APP" <<<"$apps"; then
  echo "exists"
else
  run fly apps create "$APP" --org "$ORG"
fi

say "Volume keep_data ($REGION, 10 GB)"
# One machine, one volume: a second copy of the data would replicate to
# the same Litestream prefix as the first.
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
# Auth's keys (api/src/auth/boot.rs): 32 random bytes each, made here once.
# Never replace KEEP_SETTINGS_KEY on a live app: enrolled authenticator
# apps are sealed under it.
generated=()
for s in KEEP_SETTINGS_KEY KEEP_AUTH_PEPPER; do
  grep -qx "$s" <<<"$have" || generated+=("$s=$(openssl rand -base64 32)")
done
((${#generated[@]} == 0)) || import_secrets "${generated[@]}"
missing=()
for s in LITESTREAM_BUCKET LITESTREAM_ACCESS_KEY_ID LITESTREAM_SECRET_ACCESS_KEY \
  KEEP_SNAPSHOT_BUCKET KEEP_SNAPSHOT_ACCESS_KEY_ID KEEP_SNAPSHOT_SECRET_ACCESS_KEY SENTRY_DSN; do
  grep -qx "$s" <<<"$have" || missing+=("$s")
done
if ((${#missing[@]})); then
  echo "missing: ${missing[*]}"
  echo "(the bucket and key values come from scripts/aws/backup.sh staging; SENTRY_DSN"
  echo " from the Sentry project's Client Keys page, EU region; empty skips it."
  echo " KEEP_APP_ORIGIN, KEEP_CLIENT_IP_HEADER, KEEP_MAIL and KEEP_MAIL_ONLY_TO are in"
  echo " fly.staging.toml; KEEP_SMTP_URL comes from scripts/aws/ses-sender.sh: docs/ops.md)"
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

say "Generated secrets (riverside sign-ins, reset generation)"
# Made here, never typed: the riverside users' passwords and TOTP secrets
# (the reset seed reads them at every reset, so an authenticator keeps
# working). The riverside sign-ins are printed once (Fly can't show them
# again). Secrets reach fly on stdin, never argv (the import_secrets
# function and printf are bash builtins: no process carries them).
hex() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }
b32() { head -c 20 /dev/urandom | base32 | tr -d '=\n'; }
gen=()
for role in ADMIN STAFF VIEWER; do
  if ! grep -qx "KEEP_RIVERSIDE_${role}_PASSWORD" <<<"$have"; then
    pw=$(hex 24)
    gen+=("KEEP_RIVERSIDE_${role}_PASSWORD=$pw")
    echo "riverside ${role,,}@keep-together.example password: $pw"
  fi
  if ! grep -qx "KEEP_RIVERSIDE_${role}_TOTP" <<<"$have"; then
    totp=$(b32)
    gen+=("KEEP_RIVERSIDE_${role}_TOTP=$totp")
    echo "riverside ${role,,}@keep-together.example TOTP secret: $totp"
    echo "  otpauth://totp/keep-together:${role,,}%40keep-together.example?secret=$totp&issuer=keep-together"
  fi
done
# The first reset generation (not secret; a Fly secret only, never in the
# toml: docs/ops.md "Staging"). Only when missing: a new one on a live
# app would wipe it at the next deploy. scripts/fly/staging-reset.sh
# changes it after this.
grep -qx KEEP_RESET_GENERATION <<<"$have" ||
  gen+=("KEEP_RESET_GENERATION=$(date -u +%Y%m%dT%H%M%SZ)")
if ((${#gen[@]})); then
  import_secrets "${gen[@]}"
else
  echo "all set"
fi
grep -qx KEEP_QC_TOKEN <<<"$have" &&
  echo "warning: $APP still has KEEP_QC_TOKEN: scripts/fly/staging-kept.sh removes it" >&2

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
echo "First deploy: fly deploy -c fly.staging.toml --ha=false   (or push to main)"
echo "(--ha=false always: without it flyctl's first deploy makes two machines and two volumes)"
