# Privacy and troubleshooting

English · [中文](zh-CN/faq.md) · [日本語](ja/faq.md)

## Privacy

**Does anything leave my machine?** No. baton never calls a model, an API or any network
service. The memory is a folder of Markdown files in your home directory.

**What does baton read?** The agents' local transcripts and session databases: Claude Code's
`~/.claude/projects/`, Codex's `~/.codex/sessions/`, opencode's `opencode.db`. From opencode's
database it reads only the session, message, part and todo tables, never the tables that hold
credentials.

**Does it change my agents' data?** Never. It writes only the files listed in
[Reference](reference.md#files-baton-writes): its own memory folder, one marked entry or block in
each agent's configuration and global instructions (each file backed up first), and `.baton/` in
projects where you ran `baton init`.

**What ends up in the memory?**
- Items that agents (or you) save on purpose: short sentences about preferences, facts, decisions
  and status.
- A journal entry per conversation: its first and last request, its last reply, and which items
  it saved. Never tool output, command output or file contents.
- Secrets that look like API keys, tokens, JWTs, private keys, `password=…` assignments or
  credentials in URLs are replaced with `[REDACTED]` before anything is written. This is
  best-effort: do not rely on it for secrets typed in unusual forms.

**Can agents read my full conversations through it?** Yes, on request: `memory_read` with
`transcript: true` returns the user and assistant messages of a journaled conversation (not tool
output). That is how one agent continues what you started in another. To keep a conversation out,
remove it with `baton mem forget --session <agent:id>`; to keep a whole folder out, add it to
`exclude`.

**Is the memory shown to agents as instructions?** No. The summary is introduced as notes, not
instructions, because the journal quotes conversations, and it could otherwise carry injected
text from a web page or file an agent read.

**How do I remove everything?** `baton uninstall`, then delete `~/.config/baton/`.

## Troubleshooting

**Codex does not get the summary at session start.** Codex runs only hooks you have trusted:
run `codex`, type `/hooks`, trust the baton entries. Trust is tied to the hook's exact content,
so trust again after `baton install` reports `codex hooks updated`. Until then Codex can still
use the memory tools.

**An agent does not seem to know about the memory.** Restart it: agents load MCP servers and
global instructions when they start. Desktop apps need a full quit (tray icon), not just closing
the window. Then check that the agent sees baton: `claude mcp list`, `codex mcp list`,
`opencode mcp list` should each show baton connected.

**The agent did not save what I told it.** Saving is up to the agent; it can miss things. Say
*"remember: …"* to make sure. The conversation is still in the journal either way.

**Did the agent actually use the memory?** Look at the end of `~/.config/baton/memory/memory.log`.
Each tool call is logged as `mcp: <client> (<agent>) called <tool>: ok`, without content.

**The Claude desktop app's Chat tab cannot use baton.** Run `baton install claude-desktop`,
quit the app completely and start it again, then allow the baton tools when it first asks.

**My conversations from long ago are not found.** `baton mem init` journals the last 30 days.
Run `baton mem sync --all` for the whole history.

**Codex conversations are missing.** Codex compresses older sessions; reading them needs Node.js
22.15 or newer.

**A conversation is missing from the journal.** It may have been started by a program (skipped
unless `includeHeadless`), be in an excluded folder, or have had no reply at all. `baton mem sync`
journals anything new right away.

**Hooks inside WSL are slow.** Run `baton mem share wsl:<distro>` again from Windows; it refreshes
baton's local copy inside the distro. Loading baton from `/mnt/c` is slow.

**Error output.** Hooks never fail the agent: problems are logged to
`~/.config/baton/memory/memory.log` (memory) and `<project>/.baton/hook.log` (handoff). Set
`BATON_DEBUG=1` to get stack traces from the command line.

Still stuck? Open an issue with your OS, Node.js version, agent versions and the relevant log lines.
