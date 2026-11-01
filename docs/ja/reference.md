# リファレンス

[English](../reference.md) · [中文](../zh-CN/reference.md) · 日本語

## コマンド

### セットアップ

| コマンド | 説明 |
|---|---|
| `baton install [agent]` | エージェントを接続する。フックは常に、MCP サーバーとルールはメモリが作成済みの場合に追加。`agent` は `claude`、`codex`、`opencode`、`claude-desktop` のいずれか（既定：すべて）。`--project`：現在のプロジェクトだけにフックを追加（`.claude/settings.local.json`、`.codex/hooks.json`、`.opencode/plugins/`） |
| `baton uninstall [agent]` | `install` が追加したものをすべて削除する |

### 共有メモリ

| コマンド | 説明 |
|---|---|
| `baton mem init` | メモリを作成し、最近の会話をジャーナルに記録する。`--since 30d\|7d\|12h\|all\|<date>`（既定 30d）、`--lang en\|zh` |
| `baton mem init --join <dir>` | 新しく作成せず、既存のメモリを使う（マシン設定に `memoryDir` を記録） |
| `baton mem share wsl:<distro>` | Windows 上で実行：WSL ディストリビューションのエージェントをこのメモリに接続する（[Windows + WSL](windows-wsl.md)） |
| `baton mem sync` | 新規・更新された会話を今すぐジャーナルに記録する（フックが自動で行う）。`--all`：全履歴から再構築 |
| `baton mem status` | 場所、項目数、トピック数、エージェントごとのジャーナル記録済み会話数、最終同期 |
| `baton mem brief` | セッション開始時にエージェントが受け取るサマリーを表示する |
| `baton mem search <words…>` | プロフィール、トピック、ジャーナルを検索する。`--agent <name>`、`--since <time>`、`--limit <n>`、`--json` |
| `baton mem show [topic \| agent:session]` | プロフィールとトピック一覧、1 つのトピック、または 1 件のジャーナルエントリを表示する |
| `baton mem add <kind> <text…>` | 項目を保存する。`kind`：`preference`、`fact`、`status`、`decision`、`next`。`--topic <name>`（後ろの 3 つでは必須）、`--replaces m:<id>`、`--agent <name>` |
| `baton mem forget m:<id>` | 項目を 1 つ削除する |
| `baton mem forget --session <agent:id>` | 会話をジャーナルから削除し、以後も記録しない |

### 引き継ぎ

| コマンド | 説明 |
|---|---|
| `baton init` | `.baton/` と、`AGENTS.md` / `CLAUDE.md` 内のルールを準備する（再実行しても安全） |
| `baton` / `baton capture` | このプロジェクトの最新セッションを `.baton/RESUME.md` にチェックポイントとして書き出す |
| `baton list` | このプロジェクトに関する全エージェントのセッション。`--json` |
| `baton resume` | `.baton/RESUME.md` を表示する |

`capture` と `list` のオプション：`--from <agent>`、`--exclude <agent>`、`--session <id-prefix>`、
`--stdout`、`--root <dir>`（既定：現在のフォルダーの git ルート）、`--match path|repo`、
`--local`（ほかの環境を無視）。

### 環境

| コマンド | 説明 |
|---|---|
| `baton env [list]` | この環境以外に baton が読み取る環境 |
| `baton env detect` | Windows 上ではエージェントのデータがある WSL ディストリビューションを、WSL 内では Windows ホストを追加する |
| `baton env add wsl:<distro>` / `baton env add windows` | 明示的に 1 つ追加する |
| `baton env remove <name>` | 読み取りをやめる |

### 内部用

`baton mcp`（エージェントが起動する MCP サーバー）、`baton hook <agent>`（フックから呼び出される）、
`baton export`（環境をまたいで呼び出される）。

## MCP ツール

| ツール | パラメーター | 備考 |
|---|---|---|
| `memory_context` | – | セッション開始時のサマリー |
| `memory_search` | `query`（必須）、`agent`、`since`（`7d`、`12h`、日付）、`limit`（1–50、既定 10） | すべての語が一致する必要がある。中国語と日本語の語は 2 文字単位（文字ペア）でも一致する |
| `memory_read` | `topic`（または `"profile"`）**または** `session`（キーまたはその先頭部分）、`transcript`（boolean） | トランスクリプトはジャーナルに記録された会話のものだけ。接続済みのどの環境のものでも可 |
| `memory_remember` | `kind`、`text`（必須）、`topic`、`replaces` | 新しい ID `m:xxxx` を返す |
| `memory_forget` | `id` **または** `session` | 破壊的操作として注釈付け：クライアントは実行前に確認する |

読み取り系のツールには read-only、`memory_remember` には non-destructive の注釈が付いているため、Codex などの
クライアントは確認なしでこれらを実行します。

## 設定

### メモリ：`~/.config/baton/memory/config.json`

```json
{
  "lang": "en",
  "exclude": ["C:/work/client-x"],
  "includeHeadless": false
}
```

| キー | 既定値 | 意味 |
|---|---|---|
| `lang` | ロケールから決定 | 新しいメモリファイルの見出しの言語：`en` または `zh` |
| `exclude` | `[]` | これらのフォルダー（およびその配下）での会話はジャーナルに記録しない |
| `includeHeadless` | `false` | プログラムが開始したセッション（`codex exec`、`claude -p`、`opencode run` など）もジャーナルに記録する |

### マシン：`~/.config/baton/config.json`

`baton env` と `baton mem init --join` が書き込みます。`environments`（読み取るほかの環境）と、`memoryDir`
（既定以外の場所にある場合のメモリの場所）を保持します。

### プロジェクト：`.baton/config.json`

```json
{ "match": "repo" }
```

`match`：`path`（既定）または `repo`。[引き継ぎ](handoff.md#several-clones-of-one-repository) を参照してください。

### 環境変数

| 変数 | 効果 |
|---|---|
| `BATON_MEMORY_DIR` | メモリの場所（`memoryDir` より優先）。フックと MCP サーバーはエージェントが起動するため、この変数が見えない場合がある。`memoryDir` の使用を推奨 |
| `CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`XDG_DATA_HOME`、`XDG_CONFIG_HOME` | エージェント自身のデータの場所。エージェントと同じように解釈する |
| `BATON_OPENCODE_DB` | opencode のデータベースのパス |
| `BATON_HOME` | 別のディレクトリをホームとして使う（テストやサンドボックス用） |
| `BATON_DEBUG` | エラー時にスタックトレースを表示する |

<a id="files-baton-writes"></a>
## baton が書き込むファイル

baton がエージェントのトランスクリプトやデータベースに書き込むことはありません。書き込むのは次のものだけです。

| 場所 | 内容 | 削除方法 |
|---|---|---|
| `~/.config/baton/memory/` | `profile.md`、`topics/`、`journal/`、`config.json`、`state.json`（同期の進捗）、`memory.log`（診断情報：どのクライアントが接続し、どのツールを呼び出したか。内容は記録しない）、`.lock` | フォルダーを削除 |
| `~/.config/baton/config.json` | ほかの環境、`memoryDir` | `baton env remove`、またはファイルを削除 |
| `~/.claude/settings.json`、`~/.claude.json`、`~/.claude/CLAUDE.md` | baton のフック、MCP エントリ、ルールブロック | `baton uninstall` |
| `~/.codex/hooks.json`、`~/.codex/config.toml`、`~/.codex/AGENTS.md` | Codex 用の同様のもの | `baton uninstall` |
| `~/.config/opencode/plugins/baton.js`、`opencode.json`、`AGENTS.md` | opencode 用の同様のもの | `baton uninstall` |
| Claude デスクトップアプリの `claude_desktop_config.json` | MCP エントリ | `baton uninstall` |
| 上記の各ファイルの隣にある `*.baton-backup` | baton が最初に変更する前の状態のファイル | 手動で削除 |
| `~/.local/share/baton/`（WSL 内のみ） | baton のローカルコピー | `baton uninstall` |
| `<project>/.baton/`、および `AGENTS.md` / `CLAUDE.md` 内のブロック | 引き継ぎ用。`baton init` を実行した場所のみ | それらを削除 |
