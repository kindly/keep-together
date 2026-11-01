#!/usr/bin/env bash
# Run a build or test command the way factory workers share this machine.
# Usage: factory/build.sh <command…>   e.g. factory/build.sh pnpm check
#
# - One at a time: a lock shared by every worktree. On 2026-11-01, three
#   builders linking tests at once filled RAM and swap, and systemd-oomd
#   killed every session on the machine.
# - Never the first two cores, and at the lowest priority, so the desktop
#   stays responsive however many builders are queued. cargo sizes its
#   jobs from the cores it is allowed (14 of 16 here).
set -euo pipefail
[ $# -gt 0 ] || { echo "usage: factory/build.sh <command…>" >&2; exit 2; }

# A fixed path: a sandboxed shell's TMPDIR differs from an unsandboxed
# one's, and both must queue on the same lock.
lock=/tmp/claude-1000/keep-cargo.lock
last=$(( $(nproc --all) - 1 ))
cores="2-${last}"
[ "$last" -ge 4 ] || cores="0-${last}" # a small machine keeps every core

exec flock "$lock" nice -n 19 taskset -c "$cores" "$@"
