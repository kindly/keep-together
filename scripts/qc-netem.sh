#!/usr/bin/env bash
# Delay the QC pool's api ports on loopback to the hosted round trip
# (qc/rtt.json), so `pnpm qc` times the app as a user on that link sees it
# (migration-rust F3; the netem recipe of factory/plans/rust-spike.sv).
# Only the api ports (8801…) are delayed: serve.mjs, Chromium and
# Playwright talk at loopback speed. Needs root: the human runs it, once
# per boot (netem lasts until removed or reboot).
#
#   sudo scripts/qc-netem.sh on [N]     # N pool instances, default 3
#   sudo scripts/qc-netem.sh off
#   scripts/qc-netem.sh show
set -euo pipefail
cd "$(dirname "$0")/.."

cmd=${1:-show}
n=${2:-3}
[[ $n =~ ^[1-9][0-9]?$ ]] || { echo "N must be 1-99, not '$n'" >&2; exit 2; }
# Runs as root: nothing read from the worktree is ever run as code. Node
# only reads the file (a fixed program), and what it prints must be a plain
# number before anything uses it.
rtt=$(node -e 'const r = JSON.parse(require("fs").readFileSync("qc/rtt.json", "utf8")).rttMs; if (typeof r !== "number" || !(r > 0 && r < 1000)) process.exit(1); console.log(r)') ||
  { echo "qc/rtt.json: rttMs must be a number of ms (0-1000)" >&2; exit 2; }
[[ $rtt =~ ^[0-9]+(\.[0-9]+)?$ ]] || { echo "bad rttMs: '$rtt'" >&2; exit 2; }
# Each direction crosses lo once: half the round trip each way.
half=$(awk -v r="$rtt" 'BEGIN { print r / 2 }')

run() { echo "+ $*"; "$@"; }

case $cmd in
  on)
    # Replacing a root qdisc on lo that isn't the default (ours from
    # before, or someone else's): say so rather than drop it silently.
    if tc qdisc show dev lo | grep -q 'qdisc .* root' &&
      ! tc qdisc show dev lo | grep -q 'qdisc noqueue 0: root'; then
      echo "warning: replacing lo's root qdisc: $(tc qdisc show dev lo | head -1)" >&2
    fi
    run tc qdisc del dev lo root 2>/dev/null || true
    run tc qdisc add dev lo root handle 1: prio
    run tc qdisc add dev lo parent 1:3 handle 30: netem delay "${half}ms"
    for i in $(seq 0 $((n - 1))); do
      port=$((8801 + i))
      run tc filter add dev lo parent 1:0 protocol ip u32 match ip dport "$port" 0xffff flowid 1:3
      run tc filter add dev lo parent 1:0 protocol ip u32 match ip sport "$port" 0xffff flowid 1:3
    done
    echo "netem: ${rtt} ms round trip on ports 8801..$((8800 + n))"
    ;;
  off)
    run tc qdisc del dev lo root
    ;;
  show)
    tc qdisc show dev lo
    tc filter show dev lo
    ;;
  *)
    echo "usage: $0 on [N] | off | show" >&2
    exit 2
    ;;
esac
