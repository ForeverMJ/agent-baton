# Getting started

English · [中文](zh-CN/getting-started.md) · [日本語](ja/getting-started.md)

This guide takes you from nothing to agents that share one memory, and shows how to check that
it works.

## 1. Requirements

- **Node.js 22.15 or newer.** 22.5 works too, but cannot read Codex's older sessions, which Codex
  stores compressed. Check with `node --version`.
- At least one of: Claude Code, Codex, opencode. baton finds their data in the default locations
  (and honours `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_DATA_HOME`).

## 2. Install

```bash
npm install -g https://github.com/ForeverMJ/agent-baton/releases/latest/download/agent-baton.tgz
baton --version
```

npm downloads the prebuilt package of the latest release and puts the `baton` command on your
PATH. Install it
**globally** like this rather than running it through `npx`: the agents' hooks and MCP settings
point at the installed files, and `npx` caches are temporary.

<details>
<summary>From source instead</summary>

```bash
git clone https://github.com/ForeverMJ/agent-baton.git
cd agent-baton
npm install
npm run build
npm link             # puts `baton` on your PATH
```
</details>

## 3. Create the memory

```bash
baton mem init
```

This creates `~/.config/baton/memory/` (on Windows `C:\Users\<you>\.config\baton\memory\`) and
journals your conversations from the last 30 days. Options:

- `--since all` journals your whole history, `--since 7d` only the last week.
- `--lang zh` or `--lang en` sets the language of headings in the memory files (default: from your
  system locale).

Sessions started by programs rather than by you (`codex exec`, `claude -p`, `opencode run`, apps
embedding an agent) are skipped, so automated runs do not bury your real conversations.

## 4. Connect your agents

```bash
baton install
```

For each agent it finds, baton adds three things, each backed up once to `*.baton-backup` before
the first change:

| | MCP server (memory tools) | Rules (when to save and look up) | Hooks |
|---|---|---|---|
| Claude Code | `~/.claude.json` | `~/.claude/CLAUDE.md` | `~/.claude/settings.json` |
| Codex | `~/.codex/config.toml` | `~/.codex/AGENTS.md` | `~/.codex/hooks.json` |
| opencode | `~/.config/opencode/opencode.json` | `~/.config/opencode/AGENTS.md` | `~/.config/opencode/plugins/baton.js` |
| Claude desktop app (Chat tab) | `claude_desktop_config.json` | – | – |

Only baton's own entry or marked block is written; your other settings are kept. To connect one
agent only: `baton install claude` (or `codex`, `opencode`, `claude-desktop`).

Then:

1. **Restart the agents** that are running, including the desktop apps (quit from the tray icon),
   so they load the MCP server and rules.
2. **Codex:** run `codex`, type `/hooks`, check that the baton entries run
   `… cli.js hook codex`, and trust them. Codex does not run hooks you have not reviewed. Until
   then, Codex still uses the memory tools; only the automatic summary at session start is missing.
3. **Claude desktop app, Chat tab:** the first time it uses a baton tool, allow it.

## 5. Check that it works

```bash
baton mem status     # where the memory is, how many conversations are journaled
baton mem brief      # the summary an agent receives when a session starts
```

Then try it across agents:

1. In Codex: *"Remember: I write emails in polite Japanese and sign them Zion."*
   Codex calls `memory_remember` and tells you what it saved.
2. Run `baton mem show`: the preference is in your profile, marked with `codex` as its source.
3. In a **new** Claude Code session: *"How do I like my emails written?"* It already has the
   answer in its session summary.
4. Still in Claude Code: *"What did I talk about in Codex recently?"* It searches the journal.

If something does not happen as described, see [Troubleshooting](faq.md#troubleshooting).

## 6. Day to day

- Just talk to your agents. They save what matters and look things up when you refer to the past.
- To make sure something is kept: say *"remember: …"*.
- To continue in another agent: *"continue what I discussed in Codex about the trip"*.
- To see or edit the memory: `baton mem show`, or open the Markdown files directly.
- To forget something: ask the agent, or `baton mem forget m:<id>`.

## 7. Uninstall

```bash
baton uninstall                 # removes hooks, MCP entries and rules blocks from every agent
npm uninstall -g agent-baton
```

The memory folder is left alone; delete `~/.config/baton/memory/` if you no longer want it. The
`*.baton-backup` files hold your configs as they were before the first install.

Next: [Shared memory](shared-memory.md) explains what is remembered and how agents use it.
