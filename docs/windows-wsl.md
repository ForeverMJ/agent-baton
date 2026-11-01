# Windows + WSL

English · [中文](zh-CN/windows-wsl.md) · [日本語](ja/windows-wsl.md)

Many people run some agents on Windows and others inside a WSL distro. baton connects both: one
shared memory, and handoff across the boundary.

## Shared memory across Windows and WSL

Set up the memory on Windows first (`baton mem init`, `baton install`), then:

```bash
baton mem share wsl:Ubuntu
```

Run this on Windows. It needs Node.js 22.5 or newer **inside** the distro. It:

1. registers the distro with baton on Windows (`baton env add wsl:Ubuntu`), so Windows agents can
   read transcripts of conversations held in WSL;
2. inside the distro, registers the Windows host (`baton env add windows`) for the opposite
   direction;
3. inside the distro, joins the Windows memory (`baton mem init --join /mnt/c/Users/<you>/.config/baton/memory`)
   instead of creating a second one;
4. inside the distro, runs `baton install` for its Claude Code, Codex and opencode.

Then restart the agents running in the distro, and trust the hooks in its Codex (`/hooks`).

How it fits together:

```
Windows                                         WSL distro
 ~/.config/baton/memory/  ◀──── /mnt/c/… ────── baton (local copy in ~/.local/share/baton)
 journals Windows conversations                 journals its own conversations, as claude@wsl:Ubuntu
 reads WSL transcripts via wsl.exe ───────────▶ reads Windows transcripts via node.exe
```

- **One memory.** The distro reads and writes the Windows memory through `/mnt/c`. Writes from
  both sides are serialised by the same lock file.
- **Each side journals its own conversations.** Entries from the distro are labelled
  `claude@wsl:Ubuntu`, `opencode@wsl:Ubuntu`, and so are items saved there.
- **Local copy.** Loading baton from `/mnt/c` takes about 0.35 s per call because of the file
  bridge, so inside WSL `baton install` copies itself to `~/.local/share/baton` and the hooks use
  the copy (about 0.2 s per session start). Run `baton mem share` again after updating baton to
  refresh the copy.
- The location of the memory is recorded as `memoryDir` in the distro's
  `~/.config/baton/config.json`. You can do the same by hand inside a distro with
  `baton mem init --join <dir>`.

## Handoff across Windows and WSL

To let handoff see sessions on the other side as well:

```bash
baton env detect          # on Windows: finds WSL distros with agent data; inside WSL: adds the Windows host
baton env add wsl:Ubuntu  # or add one explicitly
baton env list
baton env remove wsl:Ubuntu
```

From then on `baton list`, `baton capture` and the hooks also consider the other environment's
sessions (shown as `codex@wsl:Ubuntu`). Use `--local` to ignore other environments for one command.
`baton mem share` registers the distro this way too, so after it, handoff in projects where you
ran `baton init` also looks into WSL at session start (a little slower).

baton does not read the other side's files directly: SQLite cannot open a database across the
WSL file bridge, Windows git refuses repositories inside WSL, and paths differ. Instead it runs
the same `cli.js` inside the other environment, which reads its agents natively and returns the
session as JSON. Paths are translated (`C:\dev\p` ↔ `/mnt/c/dev/p`,
`\\wsl.localhost\Ubuntu\home\u\p` ↔ `/home/u/p`).

Without Node.js in the other environment, `env add` falls back to **direct mode**: baton reads
the other side's files across the boundary.

| Direct mode | Claude Code | Codex | opencode |
|---|---|---|---|
| Windows reading a WSL distro | ✓ | ✓ | ✗ (SQLite cannot open its database over the bridge) |
| WSL reading Windows | ✓ | ✓ | ✓ |

Shared memory needs Node.js in the distro; direct mode is for handoff only.

## Notes

- **Repositories cloned on both sides** count as separate projects unless you turn on repository
  matching ([Handoff](handoff.md#several-clones-of-one-repository)).
- **`wsl --exec` does not load your shell profile**, so `env add` probes for Node through a login
  shell and stores its absolute path. Re-run `baton env add` if you move Node in the distro.
- **Testing from Git Bash** on Windows: Git Bash rewrites `/mnt/...` arguments. Prefix commands
  with `MSYS_NO_PATHCONV=1`, or use PowerShell.
