# 隐私与排错

[English](../faq.md) · 中文 · [日本語](../ja/faq.md)

## 隐私

**会有数据离开我的电脑吗？** 不会。baton 从不调用模型、API 或任何网络服务。记忆就是你主目录下的一个 Markdown 文件夹。

**baton 会读取什么？** 各 agent 的本地对话记录和会话数据库：Claude Code 的 `~/.claude/projects/`、Codex 的 `~/.codex/sessions/`、opencode 的 `opencode.db`。对于 opencode 的数据库，它只读取 session、message、part 和 todo 这几张表，从不读取保存凭据的表。

**它会修改我的 agent 数据吗？** 绝不会。它只写入[参考](reference.md#files-baton-writes)中列出的文件：它自己的记忆文件夹、每个 agent 配置和全局指令中带标记的一个条目或内容块（每个文件都会先备份），以及你运行过 `baton init` 的项目中的 `.baton/`。

**记忆里最终会有什么？**
- agent（或你自己）有意保存的条目：关于偏好、事实、决定和现状的简短句子。
- 每次对话一条日志记录：第一条和最后一条请求、最后一条回复，以及这次对话保存了哪些条目。从不包含工具输出、命令输出或文件内容。
- 看起来像 API key、token、JWT、私钥、`password=…` 赋值或 URL 中凭据的机密信息，会在写入任何内容之前被替换为 `[REDACTED]`。这只是尽力而为：对于以不寻常形式输入的机密信息，不要依赖它。

**agent 能通过它读取我的完整对话吗？** 可以，但需要主动请求：`memory_read` 加上 `transcript: true`，会返回某次已记入日志的对话中的用户和助手消息（不含工具输出）。一个 agent 正是这样接着你在另一个 agent 中开始的工作继续下去的。如果不想让某次对话被读取，可以用 `baton mem forget --session <agent:id>` 将其移除；如果要排除整个文件夹，把它加入 `exclude`。

**记忆会作为指令交给 agent 吗？** 不会。摘要被标明为笔记而非指令，因为日志中引用了对话内容，否则它可能会夹带 agent 读到的网页或文件中被注入的文本。

**如何移除所有内容？** 运行 `baton uninstall`，然后删除 `~/.config/baton/`。

<a id="troubleshooting"></a>
## 排错

**Codex 在会话开始时拿不到摘要。** Codex 只运行你信任过的 hook：运行 `codex`，输入 `/hooks`，信任 baton 的条目。信任与 hook 的确切内容绑定，所以当 `baton install` 报告 `codex hooks updated` 之后，需要重新信任一次。在此之前，Codex 仍然可以使用记忆工具。

**agent 似乎不知道有记忆这回事。** 重启它：agent 在启动时加载 MCP server 和全局指令。桌面应用需要完全退出（通过托盘图标），仅关闭窗口是不够的。然后确认 agent 能看到 baton：`claude mcp list`、`codex mcp list`、`opencode mcp list` 都应显示 baton 已连接。

**agent 没有保存我告诉它的内容。** 是否保存由 agent 决定，难免会有遗漏。说一句「*记住：……*」可以确保被保存。无论如何，这次对话仍会记在日志里。

**agent 真的用到记忆了吗？** 查看 `~/.config/baton/memory/memory.log` 的末尾。每次工具调用都会记录为 `mcp: <client> (<agent>) called <tool>: ok`，不含具体内容。

**Claude 桌面版的 Chat 标签页无法使用 baton。** 运行 `baton install claude-desktop`，完全退出应用后重新启动，然后在它第一次询问时允许使用 baton 工具。

**找不到很久以前的对话。** `baton mem init` 只会把最近 30 天的对话记入日志。运行 `baton mem sync --all` 可以记录全部历史。

**缺少 Codex 的对话。** Codex 会压缩较早的会话，读取它们需要 Node.js 22.15 或更高版本。

**日志中缺少某次对话。** 它可能是由程序发起的（除非设置了 `includeHeadless`，否则会被跳过），可能位于被排除的文件夹中，也可能从未得到过任何回复。`baton mem sync` 会立即把所有新对话记入日志。

**WSL 内的 hook 很慢。** 在 Windows 上再次运行 `baton mem share wsl:<distro>`，它会刷新发行版内 baton 的本地副本。从 `/mnt/c` 加载 baton 会很慢。

**错误输出。** hook 从不导致 agent 出错：问题会记录到 `~/.config/baton/memory/memory.log`（记忆）和 `<project>/.baton/hook.log`（任务交接）中。设置 `BATON_DEBUG=1` 可以在命令行中获得堆栈跟踪。

还是解决不了？请提交 issue，并附上你的操作系统、Node.js 版本、各 agent 的版本以及相关的日志行。
