# Reference

English · [中文](zh-CN/reference.md) · [日本語](ja/reference.md)

## Commands

### Setup

| Command | What it does |
|---|---|
| `baton install [agent]` | connect agents: hooks always; MCP server and rules once the memory exists. `agent` is `claude`, `codex`, `opencode` or `claude-desktop` (default: all). `--project`: hooks for the current project only (`.claude/settings.local.json`, `.codex/hooks.json`, `.opencode/plugins/`) |
| `baton uninstall [agent]` | remove everything `install` added |

### Shared memory

| Command | What it does |
|---|---|
| `baton mem init` | create the memory and journal recent conversations. `--since 30d\|7d\|12h\|all\|<date>` (default 30d), `--lang en\|zh` |
| `baton mem init --join <dir>` | use an existing memory instead of creating one (records `memoryDir` in the machine config) |
| `baton mem share wsl:<distro>` | on Windows: connect a WSL distro's agents to this memory ([Windows + WSL](windows-wsl.md)) |
| `baton mem sync` | journal new and updated conversations now (hooks do this automatically). `--all`: rebuild from your whole history |
| `baton mem status` | location, number of items, topics and journaled conversations per agent, last sync |
| `baton mem brief` | print the summary agents get at session start |
| `baton mem search <words…>` | search profile, topics and journal. `--agent <name>`, `--since <time>`, `--limit <n>`, `--json` |
| `baton mem show [topic \| agent:session]` | profile and topic list; one topic; or one journal entry |
| `baton mem add <kind> <text…>` | save an item. `kind`: `preference`, `fact`, `status`, `decision`, `next`. `--topic <name>` (required for the last three), `--replaces m:<id>`, `--agent <name>` |
| `baton mem forget m:<id>` | delete one item |
| `baton mem forget --session <agent:id>` | remove a conversation from the journal and never record it again |

### Handoff

| Command | What it does |
|---|---|
| `baton init` | set up `.baton/` and the rules in `AGENTS.md` / `CLAUDE.md` (safe to re-run) |
| `baton` / `baton capture` | checkpoint the most recent session of this project into `.baton/RESUME.md` |
| `baton list` | sessions of all agents for this project. `--json` |
| `baton resume` | print `.baton/RESUME.md` |

Options for `capture` and `list`: `--from <agent>`, `--exclude <agent>`, `--session <id-prefix>`,
`--stdout`, `--root <dir>` (default: git root of the current folder), `--match path|repo`,
`--local` (ignore other environments).

### Environments

| Command | What it does |
|---|---|
| `baton env [list]` | environments baton reads besides this one |
| `baton env detect` | on Windows, add WSL distros that have agent data; inside WSL, add the Windows host |
| `baton env add wsl:<distro>` / `baton env add windows` | add one explicitly |
| `baton env remove <name>` | stop reading it |

### Internal

`baton mcp` (the MCP server agents start), `baton hook <agent>` (called by hooks),
`baton export` (called across environments).

## MCP tools

| Tool | Parameters | Notes |
|---|---|---|
| `memory_context` | – | start-of-session summary |
| `memory_search` | `query` (required), `agent`, `since` (`7d`, `12h`, a date), `limit` (1–50, default 10) | all words must match; Chinese and Japanese words also match on character pairs |
| `memory_read` | `topic` (or `"profile"`) **or** `session` (key or prefix), `transcript` (boolean) | transcripts only of journaled conversations, from any connected environment |
| `memory_remember` | `kind`, `text` (required), `topic`, `replaces` | returns the new id `m:xxxx` |
| `memory_forget` | `id` **or** `session` | marked destructive: clients ask before running it |

Read tools are annotated read-only and `memory_remember` non-destructive, so clients such as Codex
run them without asking.

## Configuration

### Memory: `~/.config/baton/memory/config.json`

```json
{
  "lang": "en",
  "exclude": ["C:/work/client-x"],
  "includeHeadless": false
}
```

| Key | Default | Meaning |
|---|---|---|
| `lang` | from your locale | language of headings in new memory files: `en` or `zh` |
| `exclude` | `[]` | conversations in these folders (and below) are never journaled |
| `includeHeadless` | `false` | also journal sessions started by programs (`codex exec`, `claude -p`, `opencode run`, …) |

### Machine: `~/.config/baton/config.json`

Written by `baton env` and `baton mem init --join`. Holds `environments` (other environments to
read) and `memoryDir` (where the memory is, when not the default).

### Project: `.baton/config.json`

```json
{ "match": "repo" }
```

`match`: `path` (default) or `repo`, see [Handoff](handoff.md#several-clones-of-one-repository).

### Environment variables

| Variable | Effect |
|---|---|
| `BATON_MEMORY_DIR` | memory location (overrides `memoryDir`). Hooks and MCP servers are started by the agents and may not see it: prefer `memoryDir` |
| `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_DATA_HOME`, `XDG_CONFIG_HOME` | the agents' own locations, honoured as the agents do |
| `BATON_OPENCODE_DB` | path of opencode's database |
| `BATON_HOME` | use another directory as home (for tests and sandboxes) |
| `BATON_DEBUG` | print stack traces on errors |

## Files baton writes

baton never writes the agents' transcripts or databases. It writes only these:

| Where | What | Removed by |
|---|---|---|
| `~/.config/baton/memory/` | `profile.md`, `topics/`, `journal/`, `config.json`, `state.json` (sync progress), `memory.log` (diagnostics: which client connected and which tool it called, never content), `.lock` | deleting the folder |
| `~/.config/baton/config.json` | other environments, `memoryDir` | `baton env remove`, or deleting it |
| `~/.claude/settings.json`, `~/.claude.json`, `~/.claude/CLAUDE.md` | baton's hooks, MCP entry, rules block | `baton uninstall` |
| `~/.codex/hooks.json`, `~/.codex/config.toml`, `~/.codex/AGENTS.md` | same for Codex | `baton uninstall` |
| `~/.config/opencode/plugins/baton.js`, `opencode.json`, `AGENTS.md` | same for opencode | `baton uninstall` |
| Claude desktop app's `claude_desktop_config.json` | MCP entry | `baton uninstall` |
| `*.baton-backup` next to each of these | the file as it was before baton's first change | delete by hand |
| `~/.local/share/baton/` (inside WSL only) | local copy of baton | `baton uninstall` |
| `<project>/.baton/`, and a block in `AGENTS.md` / `CLAUDE.md` | handoff, only where you ran `baton init` | deleting them |
