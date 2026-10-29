# One environment's /healthz body → its problems, joined by "; " (empty:
# none). Run by .github/workflows/health.yml as
#   jq -r --argjson max <litestream max lag s> --arg env <env> -f health-problems.jq
# and tested by scripts/ops/health-problems.test.mjs.
#
# The data volume: a problem once under 20% of it is free, and an URGENT
# one under 10% (uploads are refused at the disk reserve, `507`, and the
# org files share the volume). Missing fields (an older server) are no
# problem.

def gb: (. / 1e8 | floor) / 10;
def disk:
  if (.diskTotalBytes // 0) > 0 and .diskFreeBytes != null then
    (.diskFreeBytes / .diskTotalBytes) as $free
    | "disk \((1 - $free) * 100 | floor)% full on \($env): \(.diskFreeBytes | gb) GB free of \(.diskTotalBytes | gb) GB" as $what
    | if $free < 0.10 then "URGENT: \($what); grow the volume now (docs/ops.md, Disk)"
      elif $free < 0.20 then "\($what) (docs/ops.md, Disk)"
      else empty end
  else empty end;

[ (if .ok != true then "ok is \(.ok)" else empty end),
  disk,
  (.backup // {} | (
    (if .snapshots == "on" and ((.snapshotAgeSeconds // 1e9) > 7200)
     then "last snapshot \(.snapshotAgeSeconds // "never") s ago" else empty end),
    (if (.snapshotErrorCount // 0) > 0
     then "\(.snapshotErrorCount) file(s) failed the last snapshot run" else empty end),
    (if .litestream == "error" then "litestream not ok (see the log)" else empty end),
    (if .restore != null and (.restore.fallback or (.restore.missingOrgs // 0) > 0)
     then "restored from \(.restore.source) at \(.restore.at) (fallback: \(.restore.fallback), missing orgs: \(.restore.missingOrgs)); check, then delete /data/.restored"
     else empty end),
    (if .litestream == "ok" and ((.litestreamLagSeconds // 0) > $max)
     then "litestream lag \(.litestreamLagSeconds) s" else empty end),
    (if $env == "prod" and .snapshots != "on" then "snapshots off" else empty end),
    (if $env == "prod" and .litestream == "off" then "litestream off" else empty end)
  ))
] | join("; ")
