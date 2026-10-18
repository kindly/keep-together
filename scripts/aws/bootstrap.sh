#!/usr/bin/env bash
# One-off AWS bootstrap for keep, run from the Organization's management
# account. It creates:
#   - OU `keep`, locked to eu-west-2 by the SCP in scp-region-eu-west-2.json
#     (global services such as IAM, Route 53 and billing are exempt);
#   - member accounts in that OU: `keep-prod` (marketing mail, the domain),
#     `keep-mail-tx` (transactional mail only, so a newsletter incident can
#     never pause sign-in links) and `keep-dev` (stays in the SES sandbox);
#   - AdministratorAccess on each for your Identity Center user, plus a
#     matching profile per account in ~/.aws/config;
#   - the platform domain, registered and hosted in keep-prod.
#
#   aws sso login --profile mgmt
#   ROOT_EMAIL=you@example.com scripts/aws/bootstrap.sh
#
# ROOT_EMAIL is only needed while an account is missing: the new accounts'
# root addresses are its plus-aliases (you+keep-prod@example.com). The
# domain registrant comes from contact.json.local (gitignored; copy
# contact.example.json). Every step checks first, so re-running is safe.
# It asks before the two that can't be undone: creating an account
# (closing one takes 90 days) and registering the domain (no refund).
# SES itself is set up by a later script (spike E1).
set -euo pipefail
cd "$(dirname "$0")"

export AWS_PROFILE=${MGMT_PROFILE:-mgmt}
REGION=eu-west-2
OU_NAME=keep
SCP_NAME=keep-region-eu-west-2-only
DOMAIN=${DOMAIN:-keep-together.org.uk}
CONFIG=${AWS_CONFIG_FILE:-$HOME/.aws/config}
ENVS=(prod mail-tx dev) # account keep-<env>, profile keep-<env>

say() { printf '\n== %s\n' "$*"; }
run() { printf '+ %s\n' "$*" >&2; "$@"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
confirm() { local a; read -r -p "$1 [y/N] " a; [[ $a == [yY]* ]]; }

say "Preflight"
aws --version 2>&1 | grep -q '^aws-cli/2' || die "needs AWS CLI v2"
me=$(aws sts get-caller-identity --query Arn --output text) ||
  die "not signed in: aws sso login --profile $AWS_PROFILE"
account=$(aws sts get-caller-identity --query Account --output text)
[[ $account == "$(aws organizations describe-organization --query Organization.MasterAccountId --output text)" ]] ||
  die "profile $AWS_PROFILE is not the Organization's management account"
sso_user=${SSO_USER:-${me##*/}}
echo "signed in as $me (Identity Center user $sso_user)"

say "OU $OU_NAME"
root=$(aws organizations list-roots --query 'Roots[0].Id' --output text)
ou=$(aws organizations list-organizational-units-for-parent --parent-id "$root" \
  --query "OrganizationalUnits[?Name=='$OU_NAME'].Id" --output text)
[[ -n $ou ]] || ou=$(run aws organizations create-organizational-unit --parent-id "$root" \
  --name "$OU_NAME" --query OrganizationalUnit.Id --output text)
echo "$ou"

say "SCP $SCP_NAME"
# SCPs must be enabled on the root before any can be attached. Enabling
# attaches AWS's FullAWSAccess to everything, so nothing changes until our
# deny policy is attached (and SCPs never apply to the management account).
scp_status() {
  aws organizations list-roots \
    --query "Roots[0].PolicyTypes[?Type=='SERVICE_CONTROL_POLICY'].Status" --output text
}
if [[ $(scp_status) != ENABLED ]]; then
  [[ $(scp_status) == PENDING_ENABLE ]] ||
    run aws organizations enable-policy-type --root-id "$root" --policy-type SERVICE_CONTROL_POLICY >/dev/null
  until [[ $(scp_status) == ENABLED ]]; do echo "waiting for SCPs to enable…"; sleep 5; done
fi
pol=$(aws organizations list-policies --filter SERVICE_CONTROL_POLICY \
  --query "Policies[?Name=='$SCP_NAME'].Id" --output text)
if [[ -z $pol ]]; then
  pol=$(run aws organizations create-policy --type SERVICE_CONTROL_POLICY --name "$SCP_NAME" \
    --description "keep accounts: London only, global services exempt" \
    --content file://scp-region-eu-west-2.json --query Policy.PolicySummary.Id --output text)
else
  run aws organizations update-policy --policy-id "$pol" \
    --content file://scp-region-eu-west-2.json >/dev/null
fi
[[ -n $(aws organizations list-targets-for-policy --policy-id "$pol" \
  --query "Targets[?TargetId=='$ou'].TargetId" --output text) ]] ||
  run aws organizations attach-policy --policy-id "$pol" --target-id "$ou"
echo "$pol attached to $ou"

# Lets the management account change a member account's root email later
# (aws account start-primary-email-update).
[[ -n $(aws organizations list-aws-service-access-for-organization \
  --query "EnabledServicePrincipals[?ServicePrincipal=='account.amazonaws.com'].ServicePrincipal" --output text) ]] ||
  run aws organizations enable-aws-service-access --service-principal account.amazonaws.com

declare -A ids
for env in "${ENVS[@]}"; do
  name=keep-$env
  say "Account $name"
  id=$(aws organizations list-accounts \
    --query "Accounts[?Name=='$name' && Status=='ACTIVE'].Id" --output text)
  if [[ -z $id ]]; then
    [[ -n ${ROOT_EMAIL:-} ]] || die "ROOT_EMAIL is needed to create $name"
    email="${ROOT_EMAIL%@*}+$name@${ROOT_EMAIL#*@}"
    confirm "Create AWS account $name with root email $email? Closing it later takes 90 days." ||
      die "stopped before creating $name"
    req=$(run aws organizations create-account --email "$email" --account-name "$name" \
      --query CreateAccountStatus.Id --output text)
    while :; do
      read -r state id reason < <(aws organizations describe-create-account-status \
        --create-account-request-id "$req" \
        --query 'CreateAccountStatus.[State,AccountId,FailureReason]' --output text)
      [[ $state == IN_PROGRESS ]] || break
      sleep 10
    done
    [[ $state == SUCCEEDED ]] || die "creating $name failed: $reason"
  fi
  parent=$(aws organizations list-parents --child-id "$id" --query 'Parents[0].Id' --output text)
  [[ $parent == "$ou" ]] || run aws organizations move-account --account-id "$id" \
    --source-parent-id "$parent" --destination-parent-id "$ou"
  ids[$env]=$id
  echo "$id in $ou"
done

say "Identity Center: AdministratorAccess for $sso_user"
read -r instance store < <(aws sso-admin list-instances \
  --query 'Instances[0].[InstanceArn,IdentityStoreId]' --output text)
admin_ps=""
for arn in $(aws sso-admin list-permission-sets --instance-arn "$instance" \
  --query 'PermissionSets[]' --output text); do
  if [[ $(aws sso-admin describe-permission-set --instance-arn "$instance" \
    --permission-set-arn "$arn" --query PermissionSet.Name --output text) == AdministratorAccess ]]; then
    admin_ps=$arn
    break
  fi
done
[[ -n $admin_ps ]] || die "no AdministratorAccess permission set in Identity Center"
user_id=$(aws identitystore get-user-id --identity-store-id "$store" \
  --alternate-identifier "{\"UniqueAttribute\":{\"AttributePath\":\"userName\",\"AttributeValue\":\"$sso_user\"}}" \
  --query UserId --output text)
session=$(aws configure get sso_session) || die "profile $AWS_PROFILE has no sso_session"
for env in "${ENVS[@]}"; do
  [[ -n $(aws sso-admin list-account-assignments --instance-arn "$instance" \
    --account-id "${ids[$env]}" --permission-set-arn "$admin_ps" \
    --query "AccountAssignments[?PrincipalId=='$user_id'].PrincipalId" --output text) ]] ||
    run aws sso-admin create-account-assignment --instance-arn "$instance" \
      --target-id "${ids[$env]}" --target-type AWS_ACCOUNT --permission-set-arn "$admin_ps" \
      --principal-type USER --principal-id "$user_id" >/dev/null
  if ! grep -q "^\[profile keep-$env\]" "$CONFIG"; then
    printf '+ add [profile keep-%s] to %s\n' "$env" "$CONFIG" >&2
    printf '\n[profile keep-%s]\nsso_session = %s\nsso_account_id = %s\nsso_role_name = AdministratorAccess\nregion = %s\n' \
      "$env" "$session" "${ids[$env]}" "$REGION" >>"$CONFIG"
  fi
  echo "keep-$env ready"
done

say "Domain $DOMAIN (in keep-prod)"
r53d=(aws route53domains --region us-east-1 --profile keep-prod)
for _ in $(seq 30); do
  aws sts get-caller-identity --profile keep-prod >/dev/null 2>&1 && break
  echo "waiting for the keep-prod assignment to provision…"
  sleep 10
done
aws sts get-caller-identity --profile keep-prod >/dev/null || die "no access to keep-prod yet; re-run in a minute"
if "${r53d[@]}" get-domain-detail --domain-name "$DOMAIN" >/dev/null 2>&1; then
  echo "already registered in keep-prod"
else
  [[ -f contact.json.local ]] ||
    die "registrant details missing: cp scripts/aws/contact.example.json scripts/aws/contact.json.local and fill it in"
  avail=$("${r53d[@]}" check-domain-availability --domain-name "$DOMAIN" --query Availability --output text)
  [[ $avail == AVAILABLE ]] || die "$DOMAIN is $avail"
  tld=${DOMAIN#*.}
  price=$("${r53d[@]}" list-prices --tld "$tld" --query 'Prices[0].RegistrationPrice.Price' --output text)
  confirm "Register $DOMAIN in keep-prod for 1 year at \$$price (no refund; renews automatically)?" ||
    die "stopped before registering $DOMAIN"
  run "${r53d[@]}" register-domain --domain-name "$DOMAIN" --duration-in-years 1 --auto-renew \
    --registrant-contact file://contact.json.local \
    --admin-contact file://contact.json.local \
    --tech-contact file://contact.json.local \
    --privacy-protect-registrant-contact --privacy-protect-admin-contact --privacy-protect-tech-contact
  echo "registration submitted; check with: ${r53d[*]} list-operations"
fi

say "Done"
for env in "${ENVS[@]}"; do echo "profile keep-$env: account ${ids[$env]}"; done
echo "one 'aws sso login --profile $AWS_PROFILE' covers every profile"
