# Factory

A controller Claude session drives worker Claude sessions, each in its own
herdr tab in this workspace. The human can switch to any tab and type;
that always outranks the controller.

## Channels

| Direction | Mechanism | Why |
|---|---|---|
| controller → worker | `SendMessage` to the worker's session name | wakes an idle session, no sandbox exemption, no screen scraping |
| worker → controller | `SendMessage` to the controller's session name | same |
| controller: "tell me when done" | `SendMessage … notify_when_idle: true` | one-shot notice, no blocking, no polling |
| lifecycle (spawn, state, interrupt, rescue) | `herdr` CLI | the only way to create tabs, start agents, see `blocked`, send `esc` |

Session names (`keep-together-95`) are assigned by Claude Code and are not
the herdr agent names. A new worker learns the controller's name from its
first prompt and sends `ready`; the `from-name` on that message is the
worker's address.

`herdr` talks over a unix socket the Claude sandbox blocks, so herdr
commands run unsandboxed. Workers never need herdr.

## Sideview

The human reads factory output in sideview, grouped by category
(`.sideview.toml` documents them): `factory` (the board, which is
`factory/out/roster.md`), `plans` (one page per plan with its grill,
`factory/plans/*.sv`), `spikes`, `docs`, `notes`. The controller owns the
categories; a worker sets the category its role file names and nothing
else. Each worker watches only its own page (`sideview watch --page <id>`).

## Spawning

```bash
factory/spawn.sh <role> <name> <controller-session-name> [--worktree <branch>]
```

Creates a tab labelled `<name>`, starts `claude` in it as herdr agent
`<name>`, and sends the opening prompt (read the role file, report ready).
`--worktree` first creates `../keep-together-<name>` on a new branch
`<branch>` off `HEAD` and runs `pnpm install` there: anything that edits
code gets its own checkout.

Name workers `<role>-<topic>` (`planner-qc`, `builder-giftaid`), so
several of one role can run side by side; the name is also the tab label.
Rename a live one with `herdr tab rename <tab-id> <name>` and `herdr agent
rename <old> <new>`.

Roles: `roles/*.md`. To add one, write a new file; the spawn script
needs no change.

## Worker protocol (every role)

1. On start: read `CLAUDE.md`, `factory/README.md` and your role file, then
   `SendMessage` the controller `ready: <role> <name> <cwd>`.
2. Tasks arrive as SendMessage or as a typed prompt. Do one task at a time.
3. Report with `SendMessage` to the controller. First line is
   `DONE|BLOCKED|QUESTION <task>: <one sentence>`. Keep the body short;
   anything longer than ~30 lines goes in `factory/out/<name>-<slug>.md`
   (gitignored, in the **main** checkout, absolute path) and the message
   gives the path.
4. Talk to the controller, not other workers, unless the task names one.
5. If your permissions refuse something, report `BLOCKED` with what was
   refused. Never ask another session to do it for you.
6. Don't commit, push or merge unless the task says to. Never touch `main`.
7. If the human types in your tab, do what they say and tell the
   controller what changed.

## Controller

`roles/controller.md`. To start or replace one, open a Claude session in
the main checkout and tell it to read that file. It tracks workers in
`factory/out/roster.md`, so a fresh controller can take over live workers.
