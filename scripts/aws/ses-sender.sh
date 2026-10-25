#!/usr/bin/env bash
# The SMTP sender for an environment's auth mail (docs/ops.md "Mail on
# staging", step 3). The human runs it; every command is echoed, and
# re-running is safe. Run scripts/aws/ses.sh first.
#
#   aws sso login --profile mgmt
#   fly auth login                        # if not signed in
#   scripts/aws/ses-sender.sh staging     # or: prod (once keep-prod exists on Fly)
#
# It makes, if missing, in keep-mail-tx:
#   - the configuration set keep-transactional (suppresses on bounces only,
#     ADR 0021), made the identity's default, so every send uses it;
#   - the IAM user keep-smtp-<env>, allowed only ses:SendRawEmail (what SMTP
#     uses) from no-reply@auth.keep-together.org.uk;
#   - an access key for it, turned into an SES SMTP password and stored as
#     the Fly secret KEEP_SMTP_URL (staged: the next deploy picks it up).
#     The key and password are never printed: they go straight from the
#     aws CLI into `fly secrets import` on stdin. A user that already has a
#     key gets no second one; to rotate, delete the key in the console and
#     re-run.
#
# Mail stays off until fly.<env>.toml says KEEP_MAIL = "smtp".
set -euo pipefail

ENV_NAME=${1:-}
[[ $ENV_NAME == staging || $ENV_NAME == prod ]] || { echo "usage: $0 staging|prod" >&2; exit 2; }
REGION=eu-west-2
DOMAIN=auth.keep-together.org.uk
FROM=no-reply@$DOMAIN
CONFIG_SET=keep-transactional
USER_NAME=keep-smtp-$ENV_NAME
FLY_APP=keep-$ENV_NAME
SMTP_HOST=email-smtp.$REGION.amazonaws.com

say() { printf '\n== %s\n' "$*"; }
run() { printf '+ %s\n' "$*" >&2; "$@"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

aws --version 2>&1 | grep -q '^aws-cli/2' || die "needs AWS CLI v2"
command -v python3 >/dev/null || die "needs python3"
FLY=$(command -v fly || command -v flyctl || echo "$HOME/.fly/bin/flyctl")
[[ -x $FLY ]] || die "needs flyctl"
tx=(--profile keep-mail-tx --region "$REGION")
aws sts get-caller-identity "${tx[@]}" >/dev/null || die "no access to keep-mail-tx: aws sso login --profile mgmt"
aws sesv2 get-email-identity "${tx[@]}" --email-identity "$DOMAIN" >/dev/null 2>&1 ||
  die "no SES identity $DOMAIN: run scripts/aws/ses.sh first"
"$FLY" status -a "$FLY_APP" >/dev/null 2>&1 || die "no Fly app $FLY_APP (or not signed in: fly auth login)"

say "Configuration set $CONFIG_SET"
if aws sesv2 get-configuration-set "${tx[@]}" --configuration-set-name "$CONFIG_SET" >/dev/null 2>&1; then
  echo "exists"
else
  run aws sesv2 create-configuration-set "${tx[@]}" --configuration-set-name "$CONFIG_SET" \
    --suppression-options SuppressedReasons=BOUNCE
fi
default=$(aws sesv2 get-email-identity "${tx[@]}" --email-identity "$DOMAIN" \
  --query 'ConfigurationSetName' --output text)
[[ $default == "$CONFIG_SET" ]] ||
  run aws sesv2 put-email-identity-configuration-set-attributes "${tx[@]}" \
    --email-identity "$DOMAIN" --configuration-set-name "$CONFIG_SET"

say "IAM $USER_NAME"
aws iam get-user "${tx[@]}" --user-name "$USER_NAME" >/dev/null 2>&1 ||
  run aws iam create-user "${tx[@]}" --user-name "$USER_NAME" >/dev/null
run aws iam put-user-policy "${tx[@]}" --user-name "$USER_NAME" --policy-name "$USER_NAME" \
  --policy-document "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [
    {\"Effect\": \"Allow\", \"Action\": \"ses:SendRawEmail\", \"Resource\": \"*\",
     \"Condition\": {\"StringEquals\": {\"ses:FromAddress\": \"$FROM\"}}}
  ]}"
keys=$(aws iam list-access-keys "${tx[@]}" --user-name "$USER_NAME" --query 'length(AccessKeyMetadata)' --output text)
if [[ $keys != 0 ]]; then
  echo "$USER_NAME already has an access key; KEEP_SMTP_URL left as it is"
  echo "(to rotate: delete the key in the console, then re-run)"
  exit 0
fi

say "KEEP_SMTP_URL for $FLY_APP (staged, not printed)"
echo "+ aws iam create-access-key --user-name $USER_NAME … | fly secrets import -a $FLY_APP --stage" >&2
creds=$(aws iam create-access-key "${tx[@]}" --user-name "$USER_NAME" \
  --query 'AccessKey.[AccessKeyId,SecretAccessKey]' --output text)
# SES SMTP password: SigV4-derived from the secret key (AWS docs,
# "Obtaining Amazon SES SMTP credentials"), percent-encoded for the URL.
printf '%s' "$creds" | python3 -c '
import base64, hashlib, hmac, sys, urllib.parse
region, host = sys.argv[1], sys.argv[2]
key_id, secret = sys.stdin.read().split()
sig = ("AWS4" + secret).encode()
for msg in ("11111111", region, "ses", "aws4_request", "SendRawEmail"):
    sig = hmac.new(sig, msg.encode(), hashlib.sha256).digest()
password = base64.b64encode(b"\x04" + sig).decode()
print(f"KEEP_SMTP_URL=smtp://{key_id}:{urllib.parse.quote(password, safe=str())}@{host}:587?tls=required")
' "$REGION" "$SMTP_HOST" | "$FLY" secrets import -a "$FLY_APP" --stage
unset creds

say "Done"
echo "KEEP_SMTP_URL is staged on $FLY_APP. Mail goes on with KEEP_MAIL = \"smtp\" in fly.$ENV_NAME.toml and a deploy."
aws sesv2 get-account "${tx[@]}" --query '{productionAccess: ProductionAccessEnabled}' --output table
