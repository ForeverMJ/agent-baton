# Project State

<!-- Shared, long-lived memory for every coding agent working on this repo.
     Keep it short and current; rewrite sections rather than appending forever. -->

## Goal
`agent-baton` (command `baton`): local tooling so several coding agents (Claude Code, Codex, opencode, more
later) work as one. Two parts:
- **Shared memory** (`src/memory/`): one per-person memory in `~/.config/baton/memory/` (profile, topics,
  journal), served to agents over MCP (`baton mcp`), with hooks and global rules installed by `baton install`.
- **Handoff** (`src/core/`, `src/hooks/`): checkpoint where an agent stopped into `.baton/RESUME.md`, shared
  project state in `.baton/STATE.md`.
Design notes (Chinese): `docs/design/`. User docs: `docs/` (en, zh-CN, ja).

## Current status
0.6.0, first public release. Windows and Linux (WSL) tested; macOS untested.

## Next steps
- On-demand memory (design 4.3, "P5"): profile only at session start; a per-message hook (Claude Code / Codex
  `UserPromptSubmit`, opencode `chat.message`) fetches topics and journal entries when the message refers to
  the past; `inject` config (`full` / `profile` / `off`); journal records every request.
- More adapters: Cursor, Gemini CLI, Cline, Aider.
- Import exported cloud chats (Claude, ChatGPT) into the journal.
- Linux build of Codex inside WSL is untested with the memory hooks.

## Decisions (and why)
- TypeScript on Node >= 22.5, zero runtime dependencies: users already have Node; built-in `node:sqlite`
  (opencode) and zstd (compressed Codex sessions, Node >= 22.15).
- No LLM calls anywhere: the agent that ran out of quota cannot be called, recorded facts must be exact, and
  the reading agent is an LLM anyway.
- Memory = A + B: agents save preferences/decisions themselves (MCP `memory_remember`, prompted by rules);
  a rule-based journal guarantees every conversation is on record even when they don't.
- Memory store is `~/.config/baton/memory/`, never `~/.baton/` (hooks would treat $HOME as a baton project).
- Sessions started by programs ("headless") are not journaled by default: they would bury real conversations.
- Windows + WSL: one store, each environment journals its own sessions (labelled `@wsl:<distro>`); transcripts
  cross environments through `baton export`; WSL installs use a local copy of baton (loading from /mnt/c ~0.35 s).

## Gotchas
- opencode.db also contains credential tables: open read-only, query only session/message/part/todo.
- Claude Code project dir names are a lossy encoding of cwd: use as prefilter only, confirm with `cwd` inside.
- Codex writes reviewer (`guardian_review`) and subagent threads with the same cwd: skip them.
- Codex compresses finished rollouts in place (`rollout-*.jsonl.zst`); a listed `.jsonl` may have become
  `.jsonl.zst` by load time (`currentLocator`). Thread titles live in `session_index.jsonl`.
- Headless detection: Codex `originator` (`codex_exec`, third-party apps), Claude `entrypoint` (`sdk-*`),
  opencode `session.permission` denying `question`. Launching claude.exe from inside a Claude desktop
  session inherits `CLAUDE_CODE_ENTRYPOINT=claude-desktop`.
- Claude hooks use exec form (command + args); Codex runs hook commands through PowerShell on Windows
  (`commandWindows` with `&`), rejects plain stdout starting with "[" (emit `hookSpecificOutput` JSON), and
  only runs hooks the user trusted in `/hooks` (hash-based: re-trust after changes).
- Codex blocks MCP tools needing approval in `codex exec`; tool annotations (read-only / non-destructive,
  `openWorldHint: false`) make it auto-approve them.
- MCP client names seen: `claude-code`, `claude-ai` (Claude app Chat), `local-agent-mode-*` (Claude app
  agent mode), `codex-mcp-client`, `opencode`.
- Claude desktop app (Microsoft Store build) keeps its config in `%LOCALAPPDATA%\Claude-Data\claude_<id>\`.
  Under BATON_HOME never derive paths from the real AppData (tests would write the real config).
- opencode: a plugin that fails to load makes `opencode run` hang; `opencode run` exits right after
  session.idle (spawn the send side detached); read-only SQLite opens can fail with "disk I/O error" while
  opencode checkpoints its WAL (retried).
- WSL: SQLite cannot open opencode.db over `\\wsl.localhost`; Windows git refuses repos in WSL; `wsl --exec`
  has a bare PATH (probe node via a login shell); `wsl -l` prints UTF-16 unless WSL_UTF8=1.
- Windows file locking: creating the lock with "wx" can fail with EPERM while the previous holder deletes it,
  rename can hit EPERM/EBUSY while a reader has the file open: both retried.
- Tests run inside WSL would label sessions `wsl:<distro>`: `src/test/helpers.ts` sets BATON_ENV_NAME="".
- Git Bash on Windows mangles `/mnt/...` and `\\server\...` arguments: use MSYS_NO_PATHCONV=1.
