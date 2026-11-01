# agent-baton

**让所有编程 agent 共用一份本地记忆**。今天告诉 Codex 的事，明天 Claude Code 也知道。

[English](README.md) · 中文 · [日本語](README.ja.md)

你很可能同时在用不止一个 AI agent：Claude Code、Codex、opencode，也许还分布在不同的环境里（Windows 和 WSL）。它们各自保存自己的历史，所以谁也不知道你跟别的 agent 说过什么：你的偏好、昨天做的决定、做到一半的计划。`agent-baton`（命令为 `baton`）为它们提供一份共享记忆，就存放在你自己的电脑上。

- **共享记忆。** 偏好、事实、决定以及手头工作的进展，由你当时在对话的那个 agent 保存，所有 agent 都能读取。每一次对话还会记入一份可搜索的日志（journal），agent 可以查到你在别处聊过的内容。
- **任务交接。** 某个 agent 在任务中途用完额度时，下一个 agent 能从它停下的地方精确接手：目标、待办列表、最近的命令、失败记录、改动过的文件。
- **本地、私密。** 记忆就是你主目录下的普通 Markdown 文件。不上云，不需要 API key，自身也不调用任何 LLM。各 agent 自己的数据只读不写。

```
   Claude Code ─┐                                  ┌─ 「我昨天在 Codex 里，
   Codex ───────┼──▶  ~/.config/baton/memory/  ◀───┤    旅行的事最后定了什么？」
   opencode ────┤     profile · topics · journal   └─ Claude Code 引用 Codex 的记录来回答
   (also WSL) ──┘
```

## 快速开始

需要 **Node.js 22.15 或更高版本**。

```bash
npm install -g https://github.com/ForeverMJ/agent-baton/releases/latest/download/agent-baton.tgz   # 安装 `baton` 命令
baton mem init                                    # 创建记忆，并把最近 30 天的对话记入日志
baton install                                     # 接入 Claude Code、Codex、opencode
```

然后：

1. **重启**各个 agent，让它们加载 baton。
2. **仅限 Codex：** 打开 Codex，运行 `/hooks`，信任 baton 的条目（Codex 不会运行未经你审核的 hook）。
3. 像平常一样和任意 agent 对话。试着对其中一个说「*记住：我写邮件用日语敬语。*」，再去问另一个「*我写邮件有什么习惯？*」

也在用 WSL？`baton mem share wsl:Ubuntu` 可以把该发行版里的 agent 接入同一份记忆。详细步骤以及如何确认一切正常，请参阅[快速上手](docs/zh-CN/getting-started.md)。

## 工作原理

| 内容 | 来源 | agent 如何使用 |
|---|---|---|
| **档案（Profile）**：你的偏好和关于你的事实 | 由 agent（或你自己）通过 `memory_remember` 保存 | 包含在每次会话开始时的摘要中 |
| **主题（Topics）**：你在做的各件事的现状、决定和下一步 | 由 agent 保存 | 处于活跃状态时包含在摘要中 |
| **日志（Journal）**：任意 agent 中的每次对话各一条记录 | 按规则从对话记录中自动摘录 | 按需搜索（`memory_search`） |
| **对话记录（Transcripts）**：完整的对话 | agent 自己的文件，从不复制 | 按需读取（`memory_read`） |

`baton install` 通过三种方式接入每个 agent：一个提供五个记忆工具的 **MCP server**（`baton mcp`）；写进 agent 全局指令里的一小段**规则**，告诉它何时保存、何时查询；以及负责把会话记入日志、并把摘要交给新会话的 **hook**。没有 hook 的 agent（Claude 桌面版的 Chat 标签页）使用同样的工具。

更多内容：[共享记忆](docs/zh-CN/shared-memory.md) · [任务交接](docs/zh-CN/handoff.md)

## 支持的 agent

| Agent | 记忆 | 交接 | 说明 |
|---|---|---|---|
| Claude Code（CLI、桌面版 Code 标签页） | ✓ | ✓ | |
| Codex（CLI、桌面版） | ✓ | ✓ | 需在 `/hooks` 中信任一次 hook |
| opencode | ✓ | ✓ | |
| Claude 桌面版 Chat 标签页 | ✓ 仅工具 | – | 其对话保存在云端，不会记入日志 |
| WSL 内的 agent | ✓ | ✓ | 与 Windows 共用一份记忆，见 [Windows + WSL](docs/zh-CN/windows-wsl.md) |

已在 Windows 11 和 Linux（WSL Ubuntu）上测试。macOS 应该也能用，但尚未测试。欢迎支持更多 agent：每个 agent 只需一个小小的适配器（[CONTRIBUTING](CONTRIBUTING.md)）。

## 文档

- [快速上手](docs/zh-CN/getting-started.md)：安装、接入 agent、验证、卸载
- [共享记忆](docs/zh-CN/shared-memory.md)：记住哪些内容、agent 如何使用、如何自己编辑
- [任务交接](docs/zh-CN/handoff.md)：在另一个 agent 中继续编程任务
- [Windows + WSL](docs/zh-CN/windows-wsl.md)：在 Windows 和各个 Linux 发行版之间共用一份记忆
- [参考](docs/zh-CN/reference.md)：命令、配置、MCP 工具，以及 baton 写入的每一个文件
- [隐私与排错](docs/zh-CN/faq.md)

## 隐私要点

- 所有数据都留在你的电脑上。baton 从不调用模型或任何网络服务。
- agent 的对话记录和数据库只读不写。baton 只写入它自己的记忆文件夹、每个 agent 配置和全局指令中带标记的一段内容（写入前先备份），以及用于任务交接、位于你运行过 `baton init` 的项目中的 `.baton/`。
- 日志从不保存工具输出或文件内容，机密信息（API key、token、密码）会在写入任何内容之前被脱敏。
- `baton uninstall` 会移除它在 agent 配置中添加的全部内容。记忆本身是普通 Markdown，你可以随意查看、编辑或删除。

详情：[隐私与排错](docs/zh-CN/faq.md)。

## 路线图

- 按需加载记忆：会话开始时只加载档案，当你的消息提到相关内容时再去获取主题和过往对话（[设计文档](docs/design/memory-design.zh-CN.md)，第 4.3 节）
- 支持更多 agent：Cursor、Gemini CLI、Cline、Aider
- 将导出的云端对话（Claude、ChatGPT）导入日志

## 许可证

[MIT](LICENSE)
