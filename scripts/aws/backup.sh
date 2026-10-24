#!/usr/bin/env bash
# Backup storage for one environment (plan migration-rust.sv, step F2).
# The human runs it; every command is echoed, and re-running is safe.
#
#   aws sso login --profile mgmt          # one login covers keep-* profiles
#   scripts/aws/backup.sh staging         # or: prod (at cutover)
#
# It makes, if missing:
#   - in keep-prod: the Litestream bucket keep-litestream-<account> (shared
#     by every env under its own prefix): versioned, SSE-S3, public access
#     blocked; old versions expire after 30 days. Staging's old per-deploy
#     prefixes are not expired by a rule (it would also hit the live one);
#     docs/ops.md has the prune command;
#   - in keep-backup: the snapshot bucket keep-snapshots-<account> with
#     Object Lock (governance mode, 2 days by default), SSE-S3, public
#     access blocked, lifecycle by tier prefix (hourly/ 2 days, daily/ 30
#     days, monthly/ 365 days; a noncurrent version goes a day later), and
#     a bucket policy that refuses any PUT from the app users without
#     `If-None-Match: *`: the app can add a snapshot, never replace one;
#   - per env, an IAM user in each account, limited to that env's prefix:
#     keep-litestream-<env> (Litestream needs delete, for its own retention)
#     and keep-snapshots-<env> (put, get, list; never delete);
#   - once, read-only drill users in both accounts (keep-drill-reader), for
#     .github/workflows/drill.yml, limited to staging's prefixes: whether a
#     GitHub runner may read prod's donor data is the human's decision
#     (review F2, M5), so it can't yet.
#
# New access keys are printed once, with the `fly secrets set` / `gh
# secret set` lines that use them. A user that already has a key gets no
# second one. To rotate, delete the old key in the console and re-run.
#
# Needs: profiles keep-prod and keep-backup (scripts/aws/bootstrap.sh
# creates keep-backup).
set -euo pipefail

ENV_NAME=${1:-}
[[ $ENV_NAME == staging || $ENV_NAME == prod ]] || { echo "usage: $0 staging|prod" >&2; exit 2; }
REGION=eu-west-2
FLY_APP=keep-$ENV_NAME

say() { printf '\n== %s\n' "$*"; }
run() { printf '+ %s\n' "$*" >&2; "$@"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

aws --version 2>&1 | grep -q '^aws-cli/2' || die "needs AWS CLI v2"
prod=(--profile keep-prod --region "$REGION")
backup=(--profile keep-backup --region "$REGION")
prod_account=$(aws sts get-caller-identity "${prod[@]}" --query Account --output text) ||
  die "no access to keep-prod: aws sso login --profile mgmt"
backup_account=$(aws sts get-caller-identity "${backup[@]}" --query Account --output text) ||
  die "no access to keep-backup: run scripts/aws/bootstrap.sh first"
LITESTREAM_BUCKET=keep-litestream-$prod_account
SNAPSHOT_BUCKET=keep-snapshots-$backup_account

bucket_exists() { aws s3api head-bucket --bucket "$1" "${@:2}" >/dev/null 2>&1; }

secure_bucket() { # bucket, profile args…
  local b=$1
  shift
  run aws s3api put-public-access-block --bucket "$b" "$@" --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  run aws s3api put-bucket-encryption --bucket "$b" "$@" --server-side-encryption-configuration \
    '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":true}]}'
  run aws s3api put-bucket-ownership-controls --bucket "$b" "$@" \
    --ownership-controls '{"Rules":[{"ObjectOwnership":"BucketOwnerEnforced"}]}'
}

say "Litestream bucket $LITESTREAM_BUCKET (keep-prod)"
bucket_exists "$LITESTREAM_BUCKET" "${prod[@]}" ||
  run aws s3api create-bucket --bucket "$LITESTREAM_BUCKET" "${prod[@]}" \
    --create-bucket-configuration LocationConstraint=$REGION >/dev/null
run aws s3api put-bucket-versioning --bucket "$LITESTREAM_BUCKET" "${prod[@]}" \
  --versioning-configuration Status=Enabled
secure_bucket "$LITESTREAM_BUCKET" "${prod[@]}"
run aws s3api put-bucket-lifecycle-configuration --bucket "$LITESTREAM_BUCKET" "${prod[@]}" \
  --lifecycle-configuration '{"Rules":[
    {"ID":"old-versions","Status":"Enabled","Filter":{"Prefix":""},
     "NoncurrentVersionExpiration":{"NoncurrentDays":30},
     "AbortIncompleteMultipartUpload":{"DaysAfterInitiation":7}}]}'

say "Snapshot bucket $SNAPSHOT_BUCKET (keep-backup)"
if ! bucket_exists "$SNAPSHOT_BUCKET" "${backup[@]}"; then
  # Object Lock can only be turned on at creation.
  run aws s3api create-bucket --bucket "$SNAPSHOT_BUCKET" "${backup[@]}" \
    --create-bucket-configuration LocationConstraint=$REGION \
    --object-lock-enabled-for-bucket >/dev/null
fi
[[ $(aws s3api get-object-lock-configuration --bucket "$SNAPSHOT_BUCKET" "${backup[@]}" \
  --query ObjectLockConfiguration.ObjectLockEnabled --output text 2>/dev/null) == Enabled ]] ||
  die "$SNAPSHOT_BUCKET exists without Object Lock; it can't be added later"
# Governance, not compliance: the keep-backup admin can still remove a
# version (with bypass), nobody else can, and the app's key can't delete
# at all. 2 days = the hourly tier, the shortest one. Longer tiers are
# protected by the app having no delete, no retention change and no
# overwrite (the bucket policy below). With overwrites impossible, the
# only noncurrent versions are the lifecycle's own expiries, so they go
# after a day: retention stays at the plan's 48 h / 30 d / 12 months
# rather than doubling.
run aws s3api put-object-lock-configuration --bucket "$SNAPSHOT_BUCKET" "${backup[@]}" \
  --object-lock-configuration \
  '{"ObjectLockEnabled":"Enabled","Rule":{"DefaultRetention":{"Mode":"GOVERNANCE","Days":2}}}'
secure_bucket "$SNAPSHOT_BUCKET" "${backup[@]}"
run aws s3api put-bucket-lifecycle-configuration --bucket "$SNAPSHOT_BUCKET" "${backup[@]}" \
  --lifecycle-configuration '{"Rules":[
    {"ID":"hourly","Status":"Enabled","Filter":{"Prefix":"hourly/"},
     "Expiration":{"Days":2},"NoncurrentVersionExpiration":{"NoncurrentDays":1}},
    {"ID":"daily","Status":"Enabled","Filter":{"Prefix":"daily/"},
     "Expiration":{"Days":30},"NoncurrentVersionExpiration":{"NoncurrentDays":1}},
    {"ID":"monthly","Status":"Enabled","Filter":{"Prefix":"monthly/"},
     "Expiration":{"Days":365},"NoncurrentVersionExpiration":{"NoncurrentDays":1}},
    {"ID":"multipart","Status":"Enabled","Filter":{"Prefix":""},
     "AbortIncompleteMultipartUpload":{"DaysAfterInitiation":1}}]}'

# The app users may only create keys, never overwrite one: S3 evaluates
# `s3:if-none-match` in bucket policies (conditional writes, 2024), and the
# app sends `If-None-Match: *` on every PUT. Principal "*" with an ARN
# pattern, because a bucket policy can't name users that don't exist yet.
run aws s3api put-bucket-policy --bucket "$SNAPSHOT_BUCKET" "${backup[@]}" --policy "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [
    {\"Sid\": \"AppCreatesNeverOverwrites\", \"Effect\": \"Deny\", \"Principal\": \"*\",
     \"Action\": \"s3:PutObject\", \"Resource\": \"arn:aws:s3:::$SNAPSHOT_BUCKET/*\",
     \"Condition\": {\"StringLike\": {\"aws:PrincipalArn\": \"arn:aws:iam::$backup_account:user/keep-snapshots-*\"},
                    \"Null\": {\"s3:if-none-match\": \"true\"}}},
    {\"Sid\": \"AppNeverDeletes\", \"Effect\": \"Deny\", \"Principal\": \"*\",
     \"Action\": [\"s3:DeleteObject\", \"s3:DeleteObjectVersion\", \"s3:PutObjectRetention\",
                  \"s3:BypassGovernanceRetention\", \"s3:PutObjectLegalHold\"],
     \"Resource\": \"arn:aws:s3:::$SNAPSHOT_BUCKET/*\",
     \"Condition\": {\"StringLike\": {\"aws:PrincipalArn\": [
       \"arn:aws:iam::$backup_account:user/keep-snapshots-*\",
       \"arn:aws:iam::$backup_account:user/keep-drill-reader\"]}}}
  ]}"

# user, account (prod|backup), policy JSON: create the user if missing,
# set its inline policy, and keep a new access key (as new_keys[user@account])
# if it has none.
declare -A new_keys
iam_user() {
  local user=$1 profile=$2 policy=$3
  local -n args=$profile
  aws iam get-user --user-name "$user" "${args[@]}" >/dev/null 2>&1 ||
    run aws iam create-user --user-name "$user" "${args[@]}" >/dev/null
  run aws iam put-user-policy --user-name "$user" "${args[@]}" \
    --policy-name "$user" --policy-document "$policy"
  if [[ $(aws iam list-access-keys --user-name "$user" "${args[@]}" \
    --query 'length(AccessKeyMetadata)' --output text) == 0 ]]; then
    new_keys[$user@$profile]=$(run aws iam create-access-key --user-name "$user" "${args[@]}" \
      --query 'AccessKey.[AccessKeyId,SecretAccessKey]' --output text)
  else
    echo "$user already has an access key (not shown again)"
  fi
}

say "IAM keep-litestream-$ENV_NAME (keep-prod)"
iam_user "keep-litestream-$ENV_NAME" prod "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [
    {\"Effect\": \"Allow\", \"Action\": [\"s3:GetObject\", \"s3:PutObject\", \"s3:DeleteObject\"],
     \"Resource\": \"arn:aws:s3:::$LITESTREAM_BUCKET/$ENV_NAME/*\"},
    {\"Effect\": \"Allow\", \"Action\": \"s3:ListBucket\", \"Resource\": \"arn:aws:s3:::$LITESTREAM_BUCKET\",
     \"Condition\": {\"StringLike\": {\"s3:prefix\": [\"$ENV_NAME/*\", \"$ENV_NAME\"]}}},
    {\"Effect\": \"Allow\", \"Action\": \"s3:GetBucketLocation\", \"Resource\": \"arn:aws:s3:::$LITESTREAM_BUCKET\"}
  ]}"

say "IAM keep-snapshots-$ENV_NAME (keep-backup)"
iam_user "keep-snapshots-$ENV_NAME" backup "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [
    {\"Effect\": \"Allow\", \"Action\": [\"s3:GetObject\", \"s3:PutObject\"],
     \"Resource\": [\"arn:aws:s3:::$SNAPSHOT_BUCKET/hourly/$ENV_NAME/*\",
                    \"arn:aws:s3:::$SNAPSHOT_BUCKET/daily/$ENV_NAME/*\",
                    \"arn:aws:s3:::$SNAPSHOT_BUCKET/monthly/$ENV_NAME/*\"]},
    {\"Effect\": \"Allow\", \"Action\": \"s3:ListBucket\", \"Resource\": \"arn:aws:s3:::$SNAPSHOT_BUCKET\",
     \"Condition\": {\"StringLike\": {\"s3:prefix\": [\"hourly/$ENV_NAME/*\", \"daily/$ENV_NAME/*\", \"monthly/$ENV_NAME/*\",
                                                    \"hourly/$ENV_NAME\", \"daily/$ENV_NAME\", \"monthly/$ENV_NAME\"]}}},
    {\"Effect\": \"Deny\", \"Action\": [\"s3:DeleteObject\", \"s3:DeleteObjectVersion\",
                                     \"s3:BypassGovernanceRetention\", \"s3:PutObjectRetention\",
                                     \"s3:PutBucketLifecycleConfiguration\", \"s3:PutBucketPolicy\"],
     \"Resource\": [\"arn:aws:s3:::$SNAPSHOT_BUCKET\", \"arn:aws:s3:::$SNAPSHOT_BUCKET/*\"]}
  ]}"

say "IAM keep-drill-reader (read-only, staging only, both accounts)"
# Staging only until the human decides whether a GitHub runner may read
# prod (review F2, M5). The policy is re-put on every run, so re-running
# this script narrows a reader created by an earlier version.
iam_user keep-drill-reader prod "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [
    {\"Effect\": \"Allow\", \"Action\": \"s3:GetObject\", \"Resource\": \"arn:aws:s3:::$LITESTREAM_BUCKET/staging/*\"},
    {\"Effect\": \"Allow\", \"Action\": \"s3:ListBucket\", \"Resource\": \"arn:aws:s3:::$LITESTREAM_BUCKET\",
     \"Condition\": {\"StringLike\": {\"s3:prefix\": [\"staging/*\", \"staging\"]}}},
    {\"Effect\": \"Allow\", \"Action\": \"s3:GetBucketLocation\", \"Resource\": \"arn:aws:s3:::$LITESTREAM_BUCKET\"}
  ]}"
iam_user keep-drill-reader backup "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [
    {\"Effect\": \"Allow\", \"Action\": \"s3:GetObject\",
     \"Resource\": [\"arn:aws:s3:::$SNAPSHOT_BUCKET/hourly/staging/*\",
                    \"arn:aws:s3:::$SNAPSHOT_BUCKET/daily/staging/*\",
                    \"arn:aws:s3:::$SNAPSHOT_BUCKET/monthly/staging/*\"]},
    {\"Effect\": \"Allow\", \"Action\": \"s3:ListBucket\", \"Resource\": \"arn:aws:s3:::$SNAPSHOT_BUCKET\",
     \"Condition\": {\"StringLike\": {\"s3:prefix\": [\"hourly/staging/*\", \"daily/staging/*\", \"monthly/staging/*\",
                                                    \"hourly/staging\", \"daily/staging\", \"monthly/staging\"]}}},
    {\"Effect\": \"Allow\", \"Action\": \"s3:GetBucketLocation\", \"Resource\": \"arn:aws:s3:::$SNAPSHOT_BUCKET\"}
  ]}"

say "Done"
echo "Litestream bucket: $LITESTREAM_BUCKET   snapshot bucket: $SNAPSHOT_BUCKET"
key_of() { cut -f1 <<<"${new_keys[$1]}"; }
secret_of() { cut -f2 <<<"${new_keys[$1]}"; }
ls_user=keep-litestream-$ENV_NAME@prod
snap_user=keep-snapshots-$ENV_NAME@backup
echo
secrets=("LITESTREAM_BUCKET=$LITESTREAM_BUCKET" "KEEP_SNAPSHOT_BUCKET=$SNAPSHOT_BUCKET")
[[ -z ${new_keys[$ls_user]:-} ]] || secrets+=(
  "LITESTREAM_ACCESS_KEY_ID=$(key_of "$ls_user")" "LITESTREAM_SECRET_ACCESS_KEY=$(secret_of "$ls_user")")
[[ -z ${new_keys[$snap_user]:-} ]] || secrets+=(
  "KEEP_SNAPSHOT_ACCESS_KEY_ID=$(key_of "$snap_user")" "KEEP_SNAPSHOT_SECRET_ACCESS_KEY=$(secret_of "$snap_user")")
echo "Fly secrets for $FLY_APP (new keys are shown once; set them now):"
echo "  fly secrets set -a $FLY_APP --stage ${secrets[*]}"
for acct in prod backup; do
  user=keep-drill-reader@$acct
  [[ -n ${new_keys[$user]:-} ]] || continue
  [[ $acct == prod ]] && name=DRILL_LITESTREAM || name=DRILL_SNAPSHOT
  echo
  echo "GitHub secrets for .github/workflows/drill.yml (keep-$acct reader):"
  echo "  gh secret set ${name}_KEY_ID --body $(key_of "$user")"
  echo "  gh secret set ${name}_SECRET --body $(secret_of "$user")"
done
echo
echo "GitHub variables (drill.yml):"
echo "  gh variable set LITESTREAM_BUCKET --body $LITESTREAM_BUCKET"
echo "  gh variable set SNAPSHOT_BUCKET --body $SNAPSHOT_BUCKET"
