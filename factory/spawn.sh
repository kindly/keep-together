#!/usr/bin/env bash
# Start a factory worker in a new herdr tab. See factory/README.md.
# Usage: factory/spawn.sh <role> <name> <controller-session-name> [--worktree <branch>]
# Needs HERDR_ENV=1 and access to the herdr socket (run unsandboxed).
set -euo pipefail

role=${1:?role}; name=${2:?name}; controller=${3:?controller session name}
shift 3
branch=
if [[ ${1:-} == --worktree ]]; then branch=${2:?branch}; fi

[[ ${HERDR_ENV:-} == 1 ]] || { echo "not inside herdr" >&2; exit 1; }
[[ $name =~ ^[a-z][a-z0-9_-]{0,31}$ ]] || { echo "bad name: $name" >&2; exit 1; }

repo=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
role_file=$repo/factory/roles/$role.md
[[ -f $role_file ]] || { echo "no role file: $role_file" >&2; exit 1; }
[[ $role != controller ]] || { echo "the controller is started by the human, not spawned" >&2; exit 1; }

cwd=$repo
if [[ -n $branch ]]; then
  cwd=$(dirname "$repo")/keep-together-$name
  if [[ ! -d $cwd ]]; then
    git -C "$repo" worktree add -b "$branch" "$cwd" HEAD >&2
    (cd "$cwd" && pnpm install --frozen-lockfile >&2)
  fi
fi

tab=$(herdr tab create --workspace "$HERDR_WORKSPACE_ID" --cwd "$cwd" --label "$name" --no-focus)
pane=$(jq -r .result.root_pane.pane_id <<<"$tab")
herdr agent start "$name" --kind claude --pane "$pane" --timeout 60000 >/dev/null

herdr agent prompt "$name" "You are the factory worker '$name', role '$role'. Your controller is the Claude session named '$controller'. Read $repo/CLAUDE.md, $repo/factory/README.md and $role_file, then follow the worker protocol: SendMessage '$controller' with 'ready: $role $name $cwd' and wait for a task." --wait --timeout 180000 >/dev/null

jq -n --arg name "$name" --arg role "$role" --arg cwd "$cwd" \
  --arg tab "$(jq -r .result.tab.tab_id <<<"$tab")" --arg pane "$pane" \
  '{name:$name, role:$role, cwd:$cwd, tab:$tab, pane:$pane}'
