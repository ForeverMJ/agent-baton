# Shared memory

English · [中文](zh-CN/shared-memory.md) · [日本語](ja/shared-memory.md)

One memory for you, shared by every agent, in every folder. This page explains what goes into
it, how agents use it, and how to work with it yourself.

## What is remembered

The memory lives in `~/.config/baton/memory/` and has four layers:

| Layer | File | Content | Written by |
|---|---|---|---|
| Profile | `profile.md` | your preferences and facts about you | agents (`memory_remember`), or you |
| Topics | `topics/<name>.md` | for each thing you work on: current status, decisions, next steps, history | agents, or you |
| Journal | `journal/<date>.md` | one entry per conversation, in any agent | baton, automatically |
| Transcripts | the agents' own files | the full conversations | never copied; read on demand |

### Profile and topics: what agents decide to keep

Agents save one short sentence at a time, of one of five kinds:

| Kind | Goes to | Example |
|---|---|---|
| `preference` | profile | "Writes emails in polite Japanese, signed Zion" |
| `fact` | profile | "Is a graduate student, plans to apply for a PhD" |
| `status` | a topic | "PhD applications: three schools shortlisted, writing the SOP" |
| `decision` | a topic | "Only programs in the US and Canada" |
| `next` | a topic | "Send the SOP draft to my advisor by Friday" |

- A topic has **one current status**: saving a new one moves the old one to *History*.
- When a decision is reversed, the agent passes `replaces: m:<id>`; the old item is struck through
  and moved to *History*, so the change stays visible instead of being silently overwritten.
- Topic names are matched loosely ("PhD申请", "phd 申请" and "PhD-申请" are the same topic), so
  agents add to existing topics instead of creating duplicates.

Each item records its id, date and source agent in a hidden comment:

```markdown
## Preferences
- Writes emails in polite Japanese, signed Zion <!-- m:k3f9 2026-10-27 codex -->
```

### Journal: what every conversation leaves behind

Agents can forget to save things, so baton also keeps a journal it writes itself, copied from the
transcripts by fixed rules (no model involved):

```markdown
### 14:05 · codex · Compare PhD programs
- desktop chat · 12 turns · 10-26 14:05–15:20
- First: "Compare the PhD programs of A and B…"
- Last request: "Rank them in that order"
- Last reply: "Here is the ranking: 1. A …"
- Remembered: m:b7d1, m:d2a8
```

The journal records where the conversation took place, its first and last request (up to 200
characters each), the last reply (up to 400) and which memory items it saved. It never stores
tool output, command output or file contents, and secrets are redacted.

Not journaled:

- sessions started by programs (`codex exec`, `claude -p`, `opencode run`, apps embedding an
  agent); set `"includeHeadless": true` in the memory's `config.json` to include them;
- sessions in folders listed in `"exclude"`;
- sessions the agent never answered (a failed login, a quota error on the first prompt);
- conversations stored only in the cloud (Claude desktop app Chat tab, ChatGPT).

## How agents use it

**At the start of a session** the hook hands the agent a summary (`baton mem brief` shows it):

- your whole profile (up to 1,500 characters),
- up to 5 active topics updated in the last 14 days, with their status, latest decisions and next steps,
- up to 5 recent conversations from the last 3 days, in any agent (coding projects excluded),
- a few lines on when to save and look things up.

It is capped at about 3,000 characters and introduced as *data, not instructions*, because the
journal quotes conversations. Agents without hooks get the same summary by calling `memory_context`.

**During the session** agents use five MCP tools:

| Tool | What it does |
|---|---|
| `memory_context` | the start-of-session summary |
| `memory_search` | search profile, topics and journal; all words must match, Chinese and Japanese also match partially |
| `memory_read` | read a whole topic, or a past conversation; with `transcript: true`, its full user and assistant messages |
| `memory_remember` | save one item (kinds above) |
| `memory_forget` | delete an item, or drop a conversation from the journal for good |

The rules block in each agent's global instructions tells it to save when you state a preference,
a fact about yourself or a decision, when the status or next step of your work changes, or when
you say "remember"; and to search when you refer to earlier conversations or ask about your own
plans. Codex approves these tools automatically except `memory_forget`, which asks you first.

**Source labels.** Items and journal entries carry the agent that produced them (`claude`,
`codex`, `opencode`, `claude@wsl:Ubuntu` for an agent inside WSL), so you can always tell where a
memory came from.

## Working with it yourself

The files are plain Markdown. Open them, edit lines, delete lines. Bullets you add by hand get an
id the next time an agent writes to that file.

```bash
baton mem show                       # profile and topic list
baton mem show "PhD applications"    # one topic
baton mem search osaka trip          # search everything
baton mem add preference "Short answers, no small talk"
baton mem add decision "Fly instead of taking the train" --topic "Osaka trip" --replaces m:zxn8
baton mem forget m:zxn8              # delete one item
baton mem forget --session codex:019a   # drop a conversation from the journal, for good
baton mem sync --all                 # journal your whole history (not just the last 30 days)
```

## Limits

- The summary is given once, when a session starts. A session that is already running does not
  see what another agent saves afterwards, unless it searches.
- Saving relies on the agent following the rules; it can miss things. The journal always records
  the conversation, and *"remember: …"* makes sure.
- Conversations that exist only in the cloud are not journaled; those apps can still read and
  write the memory through the tools.
- The journal keeps excerpts. The full conversation is read from the agent's own files on demand,
  so it is gone if the agent deletes its history.

See also: [Reference](reference.md) for every option, [Windows + WSL](windows-wsl.md) for sharing
the memory with Linux distros.
