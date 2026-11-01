# 参考

[English](../reference.md) · 中文 · [日本語](../ja/reference.md)

## 命令

### 安装与接入

| 命令 | 作用 |
|---|---|
| `baton install [agent]` | 接入 agent：总会安装 hook；记忆创建之后，还会添加 MCP server 和规则。`agent` 可以是 `claude`、`codex`、`opencode` 或 `claude-desktop`（默认：全部）。`--project`：只为当前项目安装 hook（`.claude/settings.local.json`、`.codex/hooks.json`、`.opencode/plugins/`） |
| `baton uninstall [agent]` | 移除 `install` 添加的所有内容 |

### 共享记忆

| 命令 | 作用 |
|---|---|
| `baton mem init` | 创建记忆，并把近期对话记入日志。`--since 30d\|7d\|12h\|all\|<date>`（默认 30d），`--lang en\|zh` |
| `baton mem init --join <dir>` | 使用一份已有的记忆，而不是新建（会在本机配置中记录 `memoryDir`） |
| `baton mem share wsl:<distro>` | 在 Windows 上：把某个 WSL 发行版中的 agent 接入这份记忆（[Windows + WSL](windows-wsl.md)） |
| `baton mem sync` | 立即把新增和有更新的对话记入日志（hook 会自动执行这一操作）。`--all`：根据你的全部历史重建 |
| `baton mem status` | 位置、条目数、主题数、各 agent 已记入日志的对话数，以及上次同步时间 |
| `baton mem brief` | 打印 agent 在会话开始时收到的摘要 |
| `baton mem search <words…>` | 搜索档案、主题和日志。`--agent <name>`、`--since <time>`、`--limit <n>`、`--json` |
| `baton mem show [topic \| agent:session]` | 档案和主题列表；某个主题；或某条日志记录 |
| `baton mem add <kind> <text…>` | 保存一个条目。`kind`：`preference`、`fact`、`status`、`decision`、`next`。`--topic <name>`（后三种必填）、`--replaces m:<id>`、`--agent <name>` |
| `baton mem forget m:<id>` | 删除一个条目 |
| `baton mem forget --session <agent:id>` | 从日志中移除一次对话，并且以后不再记录它 |

### 任务交接

| 命令 | 作用 |
|---|---|
| `baton init` | 设置 `.baton/` 以及 `AGENTS.md` / `CLAUDE.md` 中的规则（可以安全地重复运行） |
| `baton` / `baton capture` | 为本项目最近的会话保存检查点，写入 `.baton/RESUME.md` |
| `baton list` | 本项目中所有 agent 的会话。`--json` |
| `baton resume` | 打印 `.baton/RESUME.md` |

`capture` 和 `list` 的选项：`--from <agent>`、`--exclude <agent>`、`--session <id-prefix>`、`--stdout`、`--root <dir>`（默认：当前文件夹所在的 git 根目录）、`--match path|repo`、`--local`（忽略其他环境）。

### 环境

| 命令 | 作用 |
|---|---|
| `baton env [list]` | 除当前环境外，baton 还会读取的环境 |
| `baton env detect` | 在 Windows 上，添加含有 agent 数据的 WSL 发行版；在 WSL 内，添加 Windows 主机 |
| `baton env add wsl:<distro>` / `baton env add windows` | 显式添加一个环境 |
| `baton env remove <name>` | 不再读取该环境 |

### 内部命令

`baton mcp`（agent 启动的 MCP server）、`baton hook <agent>`（由 hook 调用）、`baton export`（跨环境调用时使用）。

## MCP 工具

| 工具 | 参数 | 说明 |
|---|---|---|
| `memory_context` | – | 会话开始时的摘要 |
| `memory_search` | `query`（必填）、`agent`、`since`（`7d`、`12h`、某个日期）、`limit`（1–50，默认 10） | 所有词都必须匹配；中文和日文词语还会按字对（相邻两个字）匹配 |
| `memory_read` | `topic`（或 `"profile"`）**或** `session`（键或前缀）、`transcript`（布尔值） | 只能读取已记入日志的对话的完整记录，可来自任一已连接的环境 |
| `memory_remember` | `kind`、`text`（必填）、`topic`、`replaces` | 返回新条目的 id `m:xxxx` |
| `memory_forget` | `id` **或** `session` | 标记为破坏性操作：客户端在运行前会先询问 |

读取类工具被标注为只读，`memory_remember` 被标注为非破坏性，因此 Codex 等客户端会直接运行它们，无需询问。

## 配置

### 记忆：`~/.config/baton/memory/config.json`

```json
{
  "lang": "en",
  "exclude": ["C:/work/client-x"],
  "includeHeadless": false
}
```

| 键 | 默认值 | 含义 |
|---|---|---|
| `lang` | 取决于你的区域设置 | 新建记忆文件中标题的语言：`en` 或 `zh` |
| `exclude` | `[]` | 位于这些文件夹（及其子文件夹）中的对话永远不会记入日志 |
| `includeHeadless` | `false` | 也把由程序发起的会话记入日志（`codex exec`、`claude -p`、`opencode run` 等） |

### 本机：`~/.config/baton/config.json`

由 `baton env` 和 `baton mem init --join` 写入。包含 `environments`（要读取的其他环境）和 `memoryDir`（记忆所在位置，不在默认位置时使用）。

### 项目：`.baton/config.json`

```json
{ "match": "repo" }
```

`match`：`path`（默认）或 `repo`，参见[任务交接](handoff.md#several-clones-of-one-repository)。

### 环境变量

| 变量 | 作用 |
|---|---|
| `BATON_MEMORY_DIR` | 记忆位置（优先于 `memoryDir`）。hook 和 MCP server 由 agent 启动，可能看不到这个变量：建议使用 `memoryDir` |
| `CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`XDG_DATA_HOME`、`XDG_CONFIG_HOME` | 各 agent 自身的位置，遵循方式与 agent 本身一致 |
| `BATON_OPENCODE_DB` | opencode 数据库的路径 |
| `BATON_HOME` | 使用另一个目录作为主目录（用于测试和沙盒） |
| `BATON_DEBUG` | 出错时打印堆栈跟踪 |

<a id="files-baton-writes"></a>
## baton 写入的文件

baton 从不写入 agent 的对话记录或数据库。它只写入以下这些文件：

| 位置 | 内容 | 如何移除 |
|---|---|---|
| `~/.config/baton/memory/` | `profile.md`、`topics/`、`journal/`、`config.json`、`state.json`（同步进度）、`memory.log`（诊断信息：哪个客户端连接了、调用了哪个工具，从不记录内容）、`.lock` | 删除该文件夹 |
| `~/.config/baton/config.json` | 其他环境、`memoryDir` | `baton env remove`，或直接删除该文件 |
| `~/.claude/settings.json`、`~/.claude.json`、`~/.claude/CLAUDE.md` | baton 的 hook、MCP 条目、规则块 | `baton uninstall` |
| `~/.codex/hooks.json`、`~/.codex/config.toml`、`~/.codex/AGENTS.md` | Codex 的同类内容 | `baton uninstall` |
| `~/.config/opencode/plugins/baton.js`、`opencode.json`、`AGENTS.md` | opencode 的同类内容 | `baton uninstall` |
| Claude 桌面版的 `claude_desktop_config.json` | MCP 条目 | `baton uninstall` |
| 上述每个文件旁边的 `*.baton-backup` | baton 第一次修改之前的原始文件 | 手动删除 |
| `~/.local/share/baton/`（仅限 WSL 内） | baton 的本地副本 | `baton uninstall` |
| `<project>/.baton/`，以及 `AGENTS.md` / `CLAUDE.md` 中的一个块 | 任务交接，仅限你运行过 `baton init` 的项目 | 删除它们 |
