# agent-baton

**One local memory for all your coding agents.**
Tell Codex something today, and Claude Code knows it tomorrow.

English · [中文](README.zh-CN.md) · [日本語](README.ja.md)

You probably use more than one AI agent: Claude Code, Codex, opencode, maybe in more than one
place (Windows and WSL). Each keeps its own history, so none of them knows what you told the
others: your preferences, the decision you made yesterday, the plan you were halfway through.
`agent-baton` (command: `baton`) gives them a shared memory that lives on your machine.

- **Shared memory.** Preferences, facts, decisions and the state of your ongoing work are saved
  by whichever agent you were talking to, and every agent can read them. Every conversation is
  also kept in a searchable journal, so an agent can look up what you discussed elsewhere.
- **Handoff.** When an agent runs out of quota mid-task, the next one picks up exactly where it
  stopped: goal, todo list, last commands, failures, changed files.
- **Local and private.** Plain Markdown files in your home directory. No cloud, no API key, no LLM
  calls of its own. Agents' own data is only ever read.

```
   Claude Code ─┐                                  ┌─ "What did I decide about the trip
   Codex ───────┼──▶  ~/.config/baton/memory/  ◀───┤    in Codex yesterday?"
   opencode ────┤     profile · topics · journal   └─ Claude Code answers, quoting Codex
   (also WSL) ──┘
```

## Quick start

Requires **Node.js 22.15 or newer**.

```bash
npm install -g https://github.com/ForeverMJ/agent-baton/releases/latest/download/agent-baton.tgz   # installs the `baton` command
baton mem init                                    # create the memory, journal the last 30 days
baton install                                     # connect Claude Code, Codex, opencode
```

Then:

1. **Restart** your agents so they load baton.
2. **Codex only:** open Codex, run `/hooks`, and trust the baton entries (Codex runs no hook you
   have not reviewed).
3. Talk to any agent as usual. Try telling one *"remember: I write emails in polite Japanese"*,
   then ask another *"how do I like my emails written?"*

Using WSL too? `baton mem share wsl:Ubuntu` connects that distro's agents to the same memory.
See [Getting started](docs/getting-started.md) for details and how to check that it works.

## How it works

| What | Where it comes from | How agents use it |
|---|---|---|
| **Profile**: your preferences and facts | saved by agents (or you) via `memory_remember` | in the summary each session starts with |
| **Topics**: status, decisions and next steps of things you work on | saved by agents | in the summary while active |
| **Journal**: one entry per conversation in any agent | copied from transcripts by rules, automatically | searched on demand (`memory_search`) |
| **Transcripts**: the full conversation | the agent's own files, never copied | read on demand (`memory_read`) |

`baton install` connects each agent in three ways: an **MCP server** (`baton mcp`) with five memory
tools, a short **rules block** in the agent's global instructions telling it when to save and look
things up, and **hooks** that journal sessions and hand the summary to new ones. Agents without
hooks (the Claude desktop app's Chat tab) use the same tools.

More: [Shared memory](docs/shared-memory.md) · [Handoff](docs/handoff.md)

## Supported agents

| Agent | Memory | Handoff | Notes |
|---|---|---|---|
| Claude Code (CLI, desktop app Code tab) | ✓ | ✓ | |
| Codex (CLI, desktop app) | ✓ | ✓ | trust the hooks once in `/hooks` |
| opencode | ✓ | ✓ | |
| Claude desktop app, Chat tab | ✓ tools only | – | its chats live in the cloud and are not journaled |
| Agents inside WSL | ✓ | ✓ | one memory with Windows, see [Windows + WSL](docs/windows-wsl.md) |

Tested on Windows 11 and Linux (WSL Ubuntu). macOS should work but is untested.
More agents are welcome: each one is a small adapter ([CONTRIBUTING](CONTRIBUTING.md)).

## Documentation

- [Getting started](docs/getting-started.md): install, connect agents, verify, uninstall
- [Shared memory](docs/shared-memory.md): what is remembered, how agents use it, editing it yourself
- [Handoff](docs/handoff.md): continuing a coding task in another agent
- [Windows + WSL](docs/windows-wsl.md): one memory across Windows and Linux distros
- [Reference](docs/reference.md): commands, configuration, MCP tools, every file baton writes
- [Privacy and troubleshooting](docs/faq.md)

## Privacy in short

- Everything stays on your machine. baton never calls a model or a network service.
- Agents' transcripts and databases are read, never written. baton writes only its own memory
  folder, a marked block in each agent's config and global instructions (backed up first), and,
  for handoff, `.baton/` in projects where you ran `baton init`.
- The journal never stores tool output or file contents, and secrets (API keys, tokens,
  passwords) are redacted before anything is written.
- `baton uninstall` removes everything it added to agent configs. The memory is plain Markdown
  you can read, edit or delete.

Details: [Privacy and troubleshooting](docs/faq.md).

## Roadmap

- On-demand memory: load only the profile at session start, and fetch topics and past conversations
  when your message refers to them ([design](docs/design/memory-design.zh-CN.md), section 4.3)
- More agents: Cursor, Gemini CLI, Cline, Aider
- Import exported cloud chats (Claude, ChatGPT) into the journal

## License

[MIT](LICENSE)
