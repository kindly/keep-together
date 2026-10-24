#!/usr/bin/env bash
# One bench run: a fresh data dir, the api on KEEP_PORT (8800), optional
# machine load, the bench, then the api stopped. From the repo root:
#   scripts/perf-stall/run.sh <api-binary> <out-dir> [--load] [bench args…]
# --load runs `cargo build --release` of rs/ into <out-dir>/load-target
# (a cold target dir: real CPU and disk load) for the whole run.
set -euo pipefail
api=$1 out=$2
shift 2
load=0
if [[ ${1:-} == --load ]]; then
  load=1
  shift
fi
port=${KEEP_PORT:-8800}
mkdir -p "$out"
out=$(cd "$out" && pwd)
rm -rf "$out/data" "$out/bucket"
KEEP_DATA_DIR="$out/data" KEEP_DEV_AUTH=1 KEEP_QC_SEED=1 KEEP_PORT=$port \
  KEEP_SNAPSHOT_BUCKET="file://$out/bucket" "$api" >"$out/api.log" 2>&1 &
api_pid=$!
loader=
cleanup() {
  kill "$api_pid" 2>/dev/null || true
  if [[ -n $loader ]]; then kill -- -"$loader" 2>/dev/null || true; fi
}
trap cleanup EXIT
for _ in $(seq 50); do
  curl -sf "http://127.0.0.1:$port/healthz" >/dev/null && break
  sleep 0.1
done
if ((load)); then
  set -m
  (cd rs && cargo build --release --target-dir "$out/load-target" >"$out/load.log" 2>&1) &
  loader=$!
  set +m
fi
node scripts/perf-stall/bench.mjs --url "http://127.0.0.1:$port" --out "$out" "$@"
