# Handoff

English · [中文](zh-CN/handoff.md) · [日本語](ja/handoff.md)

When Codex hits its usage limit halfway through a task, open Claude Code (or opencode) in the same
project and say *"continue"*. baton makes sure the new agent knows exactly where the old one
stopped. Unlike the [shared memory](shared-memory.md), which is about you and spans every folder,
handoff is about one project's work in progress.

## Set up a project

```bash
cd your-project
baton init
```

This creates `.baton/` and adds a short block to `AGENTS.md` and `CLAUDE.md` telling every agent
to read `.baton/STATE.md` (and `.baton/RESUME.md` when it is newer) at the start, and to keep
`STATE.md` up to date. Commit `.baton/STATE.md`, `AGENTS.md` and `CLAUDE.md`.

| File | Written by | Content | In git |
|---|---|---|---|
| `.baton/STATE.md` | the agents | long-lived project state: goal, done, next steps, decisions, gotchas | yes |
| `.baton/RESUME.md` | baton | exactly where the last agent stopped | no |
| `.baton/checkpoints/` | baton | earlier handoffs, one file per session | no |
| `AGENTS.md`, `CLAUDE.md` | `baton init` | the rules above, in a marked block | yes |

## Automatic (with hooks)

After `baton install`, nothing else is needed:

- **When a turn ends**, when context is compacted, and when a session ends, the agent's own
  session is checkpointed into `.baton/RESUME.md`.
- **When a session starts**, if another agent worked in this project more recently, its session
  is checkpointed and a short handoff note is put into the new session's context.

So the flow is: Codex runs out of quota, you open Claude Code in the project, and it already
knows where Codex stopped. Hooks act only in projects that ran `baton init`, and never block or
fail the agent; diagnostics go to `.baton/hook.log`.

## By hand

```bash
baton                          # checkpoint the most recent session in this project
baton list                     # sessions of all agents for this project
baton capture --from codex     # pick an agent
baton capture --exclude claude # ignore the agent you are switching to
baton capture --session 019a   # a specific session (id prefix)
baton capture --stdout         # print instead of writing .baton/
baton resume                   # print .baton/RESUME.md, to paste into an agent without hooks
```

## What a checkpoint contains

Everything is copied from the transcript, so the next agent can trust it:

- the original goal and the latest user requests,
- the last todo list or plan,
- the last assistant message,
- recent tool calls marked ✓ / ✗, and recent failures with their output,
- files changed,
- why the session ended: usage limit, interrupted turn, stopped mid-command…,
- the agent's quota usage when it is known (Codex),
- `git status` and `git diff --stat`.

No model is called: it costs nothing, works offline, and sends your code nowhere. Interpreting
the checkpoint is left to the next agent.

## Several clones of one repository

Sessions are matched by folder. If you keep two clones of a repository (say one on Windows and
one in WSL, or git worktrees), turn on repository matching:

```json
// .baton/config.json (commit it)
{ "match": "repo" }
```

or per command: `baton list --match repo`. Clones are recognised by remote URL
(`https://github.com/o/r.git` = `git@github.com:o/r`) or, without remotes, by root commit; only
sessions from the last 30 days are considered. A checkpoint from another clone carries a
**⚠ Different clone** warning with its path and branch, because its uncommitted changes are not in
your working tree.

For agents in another environment (WSL ↔ Windows), see [Windows + WSL](windows-wsl.md).
