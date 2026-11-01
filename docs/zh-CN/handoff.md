# 任务交接

[English](../handoff.md) · 中文 · [日本語](../ja/handoff.md)

当 Codex 在任务进行到一半时触及用量上限，在同一个项目里打开 Claude Code（或 opencode），说一句「*继续*」即可。baton 会确保新的 agent 准确知道上一个 agent 停在了哪里。[共享记忆](shared-memory.md)关乎的是你本人，跨越所有文件夹；任务交接则不同，它关乎的是单个项目中正在进行的工作。

## 设置项目

```bash
cd your-project
baton init
```

这会创建 `.baton/`，并在 `AGENTS.md` 和 `CLAUDE.md` 中添加一小段内容，要求每个 agent 在开始时读取 `.baton/STATE.md`（以及更新时间更晚的 `.baton/RESUME.md`），并保持 `STATE.md` 为最新状态。请提交 `.baton/STATE.md`、`AGENTS.md` 和 `CLAUDE.md`。

| 文件 | 写入者 | 内容 | 纳入 git |
|---|---|---|---|
| `.baton/STATE.md` | 各 agent | 长期的项目状态：目标、已完成、下一步、决定、注意事项 | 是 |
| `.baton/RESUME.md` | baton | 上一个 agent 停下的确切位置 | 否 |
| `.baton/checkpoints/` | baton | 以往的交接记录，每个会话一个文件 | 否 |
| `AGENTS.md`、`CLAUDE.md` | `baton init` | 上述规则，位于一个带标记的块中 | 是 |

## 自动交接（借助 hook）

运行 `baton install` 之后，无需再做任何事：

- **每轮对话结束时**、上下文被压缩时以及会话结束时，agent 自己的会话会被保存为检查点，写入 `.baton/RESUME.md`。
- **会话开始时**，如果另一个 agent 最近在这个项目里工作过，就会为它的会话保存检查点，并把一份简短的交接说明放进新会话的上下文中。

所以整个流程是：Codex 额度用完了，你在该项目中打开 Claude Code，它已经知道 Codex 停在了哪里。hook 只在运行过 `baton init` 的项目中起作用，而且从不阻塞 agent，也不会导致 agent 出错；诊断信息写入 `.baton/hook.log`。

## 手动交接

```bash
baton                          # 为本项目中最近的会话保存检查点
baton list                     # 本项目中所有 agent 的会话
baton capture --from codex     # 指定一个 agent
baton capture --exclude claude # 忽略你要切换到的那个 agent
baton capture --session 019a   # 指定某个会话（id 前缀）
baton capture --stdout         # 打印出来，而不是写入 .baton/
baton resume                   # 打印 .baton/RESUME.md，用于粘贴给没有 hook 的 agent
```

## 检查点包含什么

所有内容都是从对话记录中复制而来的，因此下一个 agent 可以放心信赖：

- 最初的目标和最近的用户请求，
- 最后一份待办列表或计划，
- 助手的最后一条消息，
- 最近的工具调用（标记为 ✓ / ✗），以及最近的失败及其输出，
- 改动过的文件，
- 会话结束的原因：触及用量上限、本轮被中断、在命令执行中途停止……，
- 在能获知时，agent 的额度使用情况（Codex），
- `git status` 和 `git diff --stat`。

整个过程不调用任何模型：不花钱、可离线使用，也不会把你的代码发送到任何地方。如何解读检查点交由下一个 agent 决定。

<a id="several-clones-of-one-repository"></a>
## 同一仓库的多个克隆

会话是按文件夹匹配的。如果你保留了同一仓库的两个克隆（比如一个在 Windows 上、一个在 WSL 中，或者使用了 git worktree），请开启按仓库匹配：

```json
// .baton/config.json (commit it)
{ "match": "repo" }
```

或者按命令开启：`baton list --match repo`。克隆通过远程 URL 识别（`https://github.com/o/r.git` = `git@github.com:o/r`），没有远程时则通过根提交识别；只考虑最近 30 天内的会话。来自另一个克隆的检查点会带有 **⚠ Different clone** 警告，并注明它的路径和分支，因为它未提交的改动并不在你的工作区中。

关于另一个环境中的 agent（WSL ↔ Windows），请参阅 [Windows + WSL](windows-wsl.md)。
