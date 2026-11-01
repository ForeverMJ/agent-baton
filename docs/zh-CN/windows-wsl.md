# Windows + WSL

[English](../windows-wsl.md) · 中文 · [日本語](../ja/windows-wsl.md)

很多人一部分 agent 跑在 Windows 上，另一部分跑在某个 WSL 发行版里。baton 能把两边连起来：共用一份记忆，并且可以跨越两边进行任务交接。

## 在 Windows 和 WSL 之间共享记忆

先在 Windows 上设置好记忆（`baton mem init`、`baton install`），然后运行：

```bash
baton mem share wsl:Ubuntu
```

请在 Windows 上运行这条命令。它要求发行版**内部**装有 Node.js 22.5 或更高版本。它会：

1. 在 Windows 端向 baton 注册该发行版（`baton env add wsl:Ubuntu`），使 Windows 上的 agent 能够读取在 WSL 中进行的对话的记录；
2. 在发行版内部注册 Windows 主机（`baton env add windows`），以支持反方向的读取；
3. 在发行版内部加入 Windows 上的记忆（`baton mem init --join /mnt/c/Users/<you>/.config/baton/memory`），而不是再创建第二份；
4. 在发行版内部，为其中的 Claude Code、Codex 和 opencode 运行 `baton install`。

之后重启在发行版中运行的 agent，并在该发行版的 Codex 中信任 hook（`/hooks`）。

整体结构如下：

```
Windows                                         WSL distro
 ~/.config/baton/memory/  ◀──── /mnt/c/… ────── baton (local copy in ~/.local/share/baton)
 journals Windows conversations                 journals its own conversations, as claude@wsl:Ubuntu
 reads WSL transcripts via wsl.exe ───────────▶ reads Windows transcripts via node.exe
```

- **一份记忆。** 发行版通过 `/mnt/c` 读写 Windows 上的记忆。两边的写入由同一个锁文件串行化。
- **各自记录自己的对话。** 来自发行版的日志记录会标记为 `claude@wsl:Ubuntu`、`opencode@wsl:Ubuntu`，在那里保存的条目也一样。
- **本地副本。** 由于文件桥接的开销，从 `/mnt/c` 加载 baton 每次调用约需 0.35 秒，所以在 WSL 内部，`baton install` 会把自身复制到 `~/.local/share/baton`，hook 使用这份副本（每次会话启动约 0.2 秒）。更新 baton 之后，请再次运行 `baton mem share` 来刷新副本。
- 记忆的位置以 `memoryDir` 的形式记录在发行版的 `~/.config/baton/config.json` 中。你也可以在发行版内部用 `baton mem init --join <dir>` 手动完成同样的设置。

## 在 Windows 和 WSL 之间交接任务

要让任务交接也能看到另一侧的会话：

```bash
baton env detect          # 在 Windows 上：查找含有 agent 数据的 WSL 发行版；在 WSL 内：添加 Windows 主机
baton env add wsl:Ubuntu  # 或者显式添加一个
baton env list
baton env remove wsl:Ubuntu
```

此后，`baton list`、`baton capture` 和 hook 也会把另一环境中的会话纳入考虑（显示为 `codex@wsl:Ubuntu`）。如果某条命令想忽略其他环境，可以加上 `--local`。`baton mem share` 同样会以这种方式注册发行版，所以执行它之后，在运行过 `baton init` 的项目中，任务交接在会话开始时也会去查看 WSL（会稍慢一些）。

baton 不会直接读取另一侧的文件：SQLite 无法跨 WSL 文件桥接打开数据库，Windows 上的 git 拒绝处理 WSL 内部的仓库，而且两边的路径也不同。baton 的做法是在另一个环境中运行同一个 `cli.js`，由它以原生方式读取该环境中的 agent 数据，并以 JSON 形式返回会话。路径会自动转换（`C:\dev\p` ↔ `/mnt/c/dev/p`，`\\wsl.localhost\Ubuntu\home\u\p` ↔ `/home/u/p`）。

如果另一个环境中没有 Node.js，`env add` 会退回到**直接模式**：baton 跨越边界直接读取另一侧的文件。

| 直接模式 | Claude Code | Codex | opencode |
|---|---|---|---|
| Windows 读取 WSL 发行版 | ✓ | ✓ | ✗（SQLite 无法通过桥接打开它的数据库） |
| WSL 读取 Windows | ✓ | ✓ | ✓ |

共享记忆要求发行版中装有 Node.js；直接模式仅用于任务交接。

## 注意事项

- **在两边分别克隆的仓库**会被视为不同的项目，除非你开启按仓库匹配（[任务交接](handoff.md#several-clones-of-one-repository)）。
- **`wsl --exec` 不会加载你的 shell 配置文件**，所以 `env add` 会通过登录 shell 探测 Node，并保存它的绝对路径。如果你在发行版中移动了 Node 的位置，请重新运行 `baton env add`。
- **在 Windows 上用 Git Bash 测试时**：Git Bash 会改写 `/mnt/...` 形式的参数。请在命令前加上 `MSYS_NO_PATHCONV=1`，或者改用 PowerShell。
