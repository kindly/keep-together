#!/usr/bin/env bash
# SES sending domain for transactional mail (ADR 0021; docs/ops.md "Mail
# on staging", step 1). The human runs it; every command is echoed, and
# re-running is safe.
#
#   aws sso login --profile mgmt          # one login covers keep-* profiles
#   scripts/aws/ses.sh
#
# It makes, if missing:
#   - in keep-mail-tx: the SES identity auth.keep-together.org.uk with Easy
#     DKIM (RSA 2048) and the custom MAIL FROM bounce.auth.keep-together.org.uk;
#   - in keep-prod's Route 53 zone: the 3 DKIM CNAMEs, the MAIL FROM's MX
#     and SPF TXT, and DMARC (p=none) on _dmarc.auth.keep-together.org.uk.
#
# Records are only created, never replaced: one that exists with another
# value is reported and the script stops before changing anything. Then it
# prints the identity's status (DKIM takes minutes to an hour to verify).
#
# Not here: production access (a console form, docs/ops.md) and the
# sending user (step 3).
set -euo pipefail

REGION=eu-west-2
ZONE=keep-together.org.uk
DOMAIN=auth.$ZONE
MAIL_FROM=bounce.$DOMAIN

say() { printf '\n== %s\n' "$*"; }
run() { printf '+ %s\n' "$*" >&2; "$@"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

aws --version 2>&1 | grep -q '^aws-cli/2' || die "needs AWS CLI v2"
command -v jq >/dev/null || die "needs jq"
tx=(--profile keep-mail-tx --region "$REGION")
prod=(--profile keep-prod --region "$REGION")
aws sts get-caller-identity "${tx[@]}" >/dev/null || die "no access to keep-mail-tx: aws sso login --profile mgmt"
aws sts get-caller-identity "${prod[@]}" >/dev/null || die "no access to keep-prod: aws sso login --profile mgmt"

say "SES identity $DOMAIN (keep-mail-tx)"
if aws sesv2 get-email-identity "${tx[@]}" --email-identity "$DOMAIN" >/dev/null 2>&1; then
  echo "exists"
else
  run aws sesv2 create-email-identity "${tx[@]}" --email-identity "$DOMAIN" \
    --dkim-signing-attributes NextSigningKeyLength=RSA_2048_BIT >/dev/null
fi
identity=$(aws sesv2 get-email-identity "${tx[@]}" --email-identity "$DOMAIN")
if [[ $(jq -r '.MailFromAttributes.MailFromDomain // ""' <<<"$identity") != "$MAIL_FROM" ]]; then
  run aws sesv2 put-email-identity-mail-from-attributes "${tx[@]}" --email-identity "$DOMAIN" \
    --mail-from-domain "$MAIL_FROM" --behavior-on-mx-failure USE_DEFAULT_VALUE
fi

say "Route 53 records (keep-prod)"
zone_id=$(aws route53 list-hosted-zones-by-name "${prod[@]}" --dns-name "$ZONE." \
  --query "HostedZones[?Name=='$ZONE.' && Config.PrivateZone==\`false\`].Id | [0]" --output text)
[[ $zone_id == /hostedzone/* ]] || die "no public hosted zone $ZONE in keep-prod"
aws route53 list-hosted-zones-by-name "${prod[@]}" --dns-name "$DOMAIN." \
  --query "HostedZones[?Name=='$DOMAIN.'].Id" --output text | grep -q . &&
  die "$DOMAIN has its own hosted zone; this script writes to $ZONE only"

# name type value (TXT values with their quotes)
desired=()
for token in $(jq -r '.DkimAttributes.Tokens[]' <<<"$identity"); do
  desired+=("$token._domainkey.$DOMAIN|CNAME|$token.dkim.amazonses.com")
done
[[ ${#desired[@]} -eq 3 ]] || die "expected 3 DKIM tokens, got ${#desired[@]}"
desired+=(
  "$MAIL_FROM|MX|10 feedback-smtp.$REGION.amazonses.com"
  "$MAIL_FROM|TXT|\"v=spf1 include:amazonses.com ~all\""
  "_dmarc.$DOMAIN|TXT|\"v=DMARC1; p=none;\""
)

changes='[]'
conflict=
for d in "${desired[@]}"; do
  IFS='|' read -r name type value <<<"$d"
  current=$(aws route53 list-resource-record-sets "${prod[@]}" --hosted-zone-id "$zone_id" \
    --start-record-name "$name." --start-record-type "$type" --max-items 1 \
    --query "ResourceRecordSets[?Name=='$name.' && Type=='$type'].ResourceRecords[].Value" --output json)
  if [[ $(jq length <<<"$current") -eq 0 ]]; then
    echo "add    $type $name  $value"
    changes=$(jq --arg n "$name" --arg t "$type" --arg v "$value" \
      '. + [{Action: "CREATE", ResourceRecordSet: {Name: $n, Type: $t, TTL: 300, ResourceRecords: [{Value: $v}]}}]' <<<"$changes")
  elif jq -e --arg v "$value" '. == [$v]' <<<"$current" >/dev/null; then
    echo "ok     $type $name"
  else
    echo "DIFFERS $type $name: has $(jq -c . <<<"$current"), wants $value"
    conflict=1
  fi
done
[[ -z $conflict ]] || die "records above differ; change them by hand (or delete them) and re-run"

if [[ $(jq length <<<"$changes") -gt 0 ]]; then
  read -r -p "Create these $(jq length <<<"$changes") record(s) in $ZONE? [y/N] " answer
  [[ $answer == [yY] ]] || die "nothing changed"
  run aws route53 change-resource-record-sets "${prod[@]}" --hosted-zone-id "$zone_id" \
    --change-batch "$(jq -c '{Comment: "SES auth. domain (scripts/aws/ses.sh)", Changes: .}' <<<"$changes")" \
    --query ChangeInfo.Status --output text
fi

say "Status"
aws sesv2 get-email-identity "${tx[@]}" --email-identity "$DOMAIN" \
  --query '{verified: VerifiedForSendingStatus, dkim: DkimAttributes.Status, mailFrom: MailFromAttributes.MailFromDomainStatus}' \
  --output table
aws sesv2 get-account "${tx[@]}" --query '{productionAccess: ProductionAccessEnabled, sendQuota: SendQuota.Max24HourSend}' --output table
echo "Re-run to check again; DKIM usually verifies within the hour."
