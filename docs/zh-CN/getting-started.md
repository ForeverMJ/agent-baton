# 快速上手

[English](../getting-started.md) · 中文 · [日本語](../ja/getting-started.md)

本指南带你从零开始，让多个 agent 共用一份记忆，并说明如何确认它确实在工作。

## 1. 环境要求

- **Node.js 22.15 或更高版本。** 22.5 也能用，但无法读取 Codex 较早的会话，因为 Codex 会把它们压缩存储。可以用 `node --version` 查看版本。
- 至少装有以下之一：Claude Code、Codex、opencode。baton 会在默认位置查找它们的数据（也会遵循 `CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`XDG_DATA_HOME`）。

## 2. 安装

```bash
npm install -g https://github.com/ForeverMJ/agent-baton/releases/latest/download/agent-baton.tgz
baton --version
```

npm 会下载最新版本预先构建好的安装包，并把 `baton` 命令加入你的 PATH。请像这样**全局**安装，而不是通过 `npx` 运行：agent 的 hook 和 MCP 设置会指向安装后的文件，而 `npx` 的缓存是临时的。

<details>
<summary>改为从源码安装</summary>

```bash
git clone https://github.com/ForeverMJ/agent-baton.git
cd agent-baton
npm install
npm run build
npm link             # 把 `baton` 加入 PATH
```
</details>

## 3. 创建记忆

```bash
baton mem init
```

这会创建 `~/.config/baton/memory/`（Windows 上为 `C:\Users\<you>\.config\baton\memory\`），并把你最近 30 天的对话记入日志。可用选项：

- `--since all` 记录你的全部历史，`--since 7d` 只记录最近一周。
- `--lang zh` 或 `--lang en` 设置记忆文件中标题的语言（默认根据系统区域设置决定）。

由程序而非你本人发起的会话（`codex exec`、`claude -p`、`opencode run`、内嵌 agent 的应用）会被跳过，以免自动化运行把你真正的对话淹没。

## 4. 接入你的 agent

```bash
baton install
```

对于找到的每个 agent，baton 会添加三样东西，每个文件在第一次修改前都会备份一次到 `*.baton-backup`：

| | MCP server（记忆工具） | 规则（何时保存、何时查询） | Hook |
|---|---|---|---|
| Claude Code | `~/.claude.json` | `~/.claude/CLAUDE.md` | `~/.claude/settings.json` |
| Codex | `~/.codex/config.toml` | `~/.codex/AGENTS.md` | `~/.codex/hooks.json` |
| opencode | `~/.config/opencode/opencode.json` | `~/.config/opencode/AGENTS.md` | `~/.config/opencode/plugins/baton.js` |
| Claude 桌面版（Chat 标签页） | `claude_desktop_config.json` | – | – |

baton 只写入它自己的条目或带标记的内容块，你的其他设置都会保留。如果只想接入某一个 agent：`baton install claude`（或 `codex`、`opencode`、`claude-desktop`）。

然后：

1. **重启**正在运行的 agent，包括桌面应用（从托盘图标退出），让它们加载 MCP server 和规则。
2. **Codex：** 运行 `codex`，输入 `/hooks`，确认 baton 的条目运行的是 `… cli.js hook codex`，然后信任它们。Codex 不会运行未经你审核的 hook。在此之前，Codex 仍然可以使用记忆工具，只是缺少会话开始时的自动摘要。
3. **Claude 桌面版 Chat 标签页：** 第一次使用 baton 工具时，允许它即可。

## 5. 确认它在工作

```bash
baton mem status     # 记忆所在位置、已记入日志的对话数量
baton mem brief      # agent 在会话开始时收到的摘要
```

然后跨 agent 试一试：

1. 在 Codex 中说：「*记住：我写邮件用日语敬语，署名 Zion。*」Codex 会调用 `memory_remember`，并告诉你它保存了什么。
2. 运行 `baton mem show`：这条偏好已经出现在你的档案里，来源标记为 `codex`。
3. 在一个**新的** Claude Code 会话中问：「*我写邮件有什么习惯？*」它的会话摘要里已经有答案了。
4. 继续在 Claude Code 中问：「*我最近在 Codex 里聊了些什么？*」它会去搜索日志。

如果实际情况与上面描述的不符，请参阅[排错](faq.md#troubleshooting)。

## 6. 日常使用

- 正常和 agent 对话就好。它们会保存重要的内容，并在你提到过去的事情时去查询。
- 想确保某件事被记住：说「*记住：……*」。
- 想在另一个 agent 中接着聊：「*继续我在 Codex 里聊的旅行的事*」。
- 想查看或编辑记忆：`baton mem show`，或者直接打开 Markdown 文件。
- 想让它忘掉某件事：直接告诉 agent，或者运行 `baton mem forget m:<id>`。

## 7. 卸载

```bash
baton uninstall                 # 从所有 agent 中移除 hook、MCP 条目和规则块
npm uninstall -g agent-baton
```

记忆文件夹不会被动到；如果不再需要，请自行删除 `~/.config/baton/memory/`。`*.baton-backup` 文件保存着你第一次安装之前的配置。

下一篇：[共享记忆](shared-memory.md)介绍会记住哪些内容，以及 agent 如何使用它们。
