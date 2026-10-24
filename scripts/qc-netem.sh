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
rtt=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("qc/rtt.json","utf8")).rttMs)')
# Each direction crosses lo once: half the round trip each way.
half=$(node -e "console.log($rtt / 2)")

run() { echo "+ $*"; "$@"; }

case $cmd in
  on)
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
