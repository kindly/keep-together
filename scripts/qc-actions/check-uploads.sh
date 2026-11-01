#!/usr/bin/env bash
# The second artifact check of .github/workflows/qc.yml: everything the
# job may upload (qc-results/, qc-report/ and the next qc-history link)
# checked for the secrets this step has, the job's GitHub token
# (CHECK_SECRETS=GH_TOKEN). The QC step already checked for
# KEEP_QC_TOKEN, the one secret only it has.
#
#   scripts/qc-actions/check-uploads.sh <history-dir>
#
# Output `check`: clean, or refused (or nothing, if this died): an upload
# runs only on clean. Paths that don't exist (QC never ran, no history
# built) are left out; with none at all there's nothing to upload.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
out=${GITHUB_OUTPUT:?GITHUB_OUTPUT is unset}
paths=()
for p in qc-results qc-report "${1:?usage: check-uploads.sh <history-dir>}"; do
  [ ! -e "$p" ] || paths+=("$p")
done
if [ ${#paths[@]} = 0 ]; then
  echo "check=clean" >>"$out"
  exit 0
fi
if node "$here/check-artifacts.mjs" "${paths[@]}"; then
  echo "check=clean" >>"$out"
  exit 0
fi
echo "check=refused" >>"$out"
exit 1
