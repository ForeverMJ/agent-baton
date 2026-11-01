# Changelog

## 0.6.0 (2026-11-01): first public release

### Shared memory
- One memory for all agents, in `~/.config/baton/memory/`: profile, topics, and a journal with one
  entry per conversation in any agent, all plain Markdown.
- MCP server (`baton mcp`) with `memory_context`, `memory_search`, `memory_read`,
  `memory_remember`, `memory_forget`.
- `baton install` connects Claude Code, Codex, opencode and the Claude desktop app's Chat tab: MCP
  server, rules in global instructions, hooks that journal sessions and hand new ones a summary.
- Sessions started by programs are skipped; secrets are redacted; tool output is never stored.
- Windows + WSL: `baton mem share wsl:<distro>` shares one memory; transcripts readable across.
- `baton mem` commands to inspect, search, edit and forget.

### Handoff
- Checkpoints of where an agent stopped (`.baton/RESUME.md`), shared project state
  (`.baton/STATE.md`), automatic capture with hooks.
- Windows ↔ WSL handoff, repository matching across clones.

### Agents
- Claude Code, Codex (including compressed sessions and thread titles), opencode.
