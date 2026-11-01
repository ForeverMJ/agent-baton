# 共享记忆

[English](../shared-memory.md) · 中文 · [日本語](../ja/shared-memory.md)

一份属于你的记忆，在所有 agent、所有文件夹之间共享。本页介绍其中保存了什么、agent 如何使用它，以及你自己如何操作它。

## 记住哪些内容

记忆存放在 `~/.config/baton/memory/`，分为四层：

| 层 | 文件 | 内容 | 写入者 |
|---|---|---|---|
| 档案（Profile） | `profile.md` | 你的偏好和关于你的事实 | agent（`memory_remember`）或你自己 |
| 主题（Topics） | `topics/<name>.md` | 你在做的每件事：当前现状、决定、下一步、历史 | agent 或你自己 |
| 日志（Journal） | `journal/<date>.md` | 任意 agent 中的每次对话各一条记录 | baton 自动写入 |
| 对话记录（Transcripts） | agent 自己的文件 | 完整的对话 | 从不复制，按需读取 |

### 档案与主题：agent 决定保留的内容

agent 每次保存一句简短的话，分为五种类型：

| 类型 | 存入 | 示例 |
|---|---|---|
| `preference` | 档案 | 「写邮件用日语敬语，署名 Zion」 |
| `fact` | 档案 | 「在读研究生，打算申请博士」 |
| `status` | 某个主题 | 「申请博士：已初选三所学校，正在写 SOP」 |
| `decision` | 某个主题 | 「只申请美国和加拿大的项目」 |
| `next` | 某个主题 | 「周五前把 SOP 初稿发给导师」 |

- 一个主题只有**一个当前现状**：保存新的现状时，旧的会移到 *History*（历史）中。
- 推翻某个决定时，agent 会传入 `replaces: m:<id>`；旧条目会被加上删除线并移到 *History*，这样变更过程始终可见，而不是被悄悄覆盖。
- 主题名采用宽松匹配（「PhD申请」「phd 申请」和「PhD-申请」视为同一个主题），因此 agent 会往已有主题里追加内容，而不是新建重复的主题。

每个条目都会在一段隐藏注释中记录它的 id、日期和来源 agent：

```markdown
## Preferences
- Writes emails in polite Japanese, signed Zion <!-- m:k3f9 2026-10-27 codex -->
```

### 日志：每次对话留下的记录

agent 可能会忘记保存，所以 baton 还会自己写一份日志，按固定规则从对话记录中摘录（不涉及任何模型）：

```markdown
### 14:05 · codex · Compare PhD programs
- desktop chat · 12 turns · 10-26 14:05–15:20
- First: "Compare the PhD programs of A and B…"
- Last request: "Rank them in that order"
- Last reply: "Here is the ranking: 1. A …"
- Remembered: m:b7d1, m:d2a8
```

日志记录对话发生的位置、第一条和最后一条请求（各最多 200 个字符）、最后一条回复（最多 400 个字符），以及这次对话保存了哪些记忆条目。它从不保存工具输出、命令输出或文件内容，机密信息会被脱敏。

不会记入日志的情况：

- 由程序发起的会话（`codex exec`、`claude -p`、`opencode run`、内嵌 agent 的应用）；如需包含它们，可在记忆的 `config.json` 中设置 `"includeHeadless": true`；
- 位于 `"exclude"` 所列文件夹中的会话；
- agent 从未回复过的会话（登录失败、第一条提示就遇到额度错误）；
- 只保存在云端的对话（Claude 桌面版 Chat 标签页、ChatGPT）。

## agent 如何使用记忆

**会话开始时**，hook 会把一份摘要交给 agent（`baton mem brief` 可以查看）：

- 你的完整档案（最多 1,500 个字符），
- 最近 14 天内更新过的活跃主题，最多 5 个，包括它们的现状、最新决定和下一步，
- 最近 3 天内任意 agent 中的近期对话，最多 5 条（编程项目除外），
- 几行关于何时保存、何时查询的说明。

摘要上限约为 3,000 个字符，并且会被标明为*数据，而非指令*，因为日志中引用了对话内容。没有 hook 的 agent 可以调用 `memory_context` 获取同样的摘要。

**会话进行中**，agent 使用五个 MCP 工具：

| 工具 | 作用 |
|---|---|
| `memory_context` | 会话开始时的摘要 |
| `memory_search` | 搜索档案、主题和日志；所有词都必须匹配，中文和日文还支持部分匹配 |
| `memory_read` | 读取整个主题或某次过往对话；传入 `transcript: true` 时，返回该对话完整的用户和助手消息 |
| `memory_remember` | 保存一个条目（类型见上文） |
| `memory_forget` | 删除一个条目，或将某次对话从日志中永久移除 |

每个 agent 全局指令中的规则块会告诉它：当你说出某个偏好、关于自己的事实或某个决定时，当你工作的现状或下一步发生变化时，或者当你说「记住」时，就进行保存；当你提到之前的对话、或询问自己的计划时，就进行搜索。Codex 会自动批准这些工具，只有 `memory_forget` 会先征求你的同意。

**来源标签。** 条目和日志记录都会带上产生它们的 agent（`claude`、`codex`、`opencode`，WSL 内的 agent 则为 `claude@wsl:Ubuntu`），因此你总能知道一条记忆来自哪里。

## 自己动手管理

这些文件都是普通 Markdown。你可以打开它们、编辑某一行、删除某一行。你手动添加的列表项，会在下次有 agent 写入该文件时获得一个 id。

```bash
baton mem show                       # 档案和主题列表
baton mem show "PhD applications"    # 查看一个主题
baton mem search osaka trip          # 搜索全部内容
baton mem add preference "Short answers, no small talk"
baton mem add decision "Fly instead of taking the train" --topic "Osaka trip" --replaces m:zxn8
baton mem forget m:zxn8              # 删除一个条目
baton mem forget --session codex:019a   # 将一次对话从日志中永久移除
baton mem sync --all                 # 把全部历史记入日志（而不仅是最近 30 天）
```

## 局限

- 摘要只在会话开始时给出一次。已经在运行的会话看不到其他 agent 之后保存的内容，除非它主动搜索。
- 保存依赖于 agent 遵守规则，难免会有遗漏。日志总会记录对话，而说一句「*记住：……*」可以确保被保存。
- 只存在于云端的对话不会记入日志；不过这些应用仍然可以通过工具读写记忆。
- 日志只保存摘录。完整对话是按需从 agent 自己的文件中读取的，所以如果 agent 删除了自己的历史，完整对话也就没有了。

另请参阅：[参考](reference.md)了解所有选项，[Windows + WSL](windows-wsl.md)了解如何与 Linux 发行版共享记忆。
