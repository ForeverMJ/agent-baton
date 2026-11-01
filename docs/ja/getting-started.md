# はじめに

[English](../getting-started.md) · [中文](../zh-CN/getting-started.md) · 日本語

このガイドでは、何もない状態から、エージェントたちがひとつのメモリを共有する状態までを順に説明し、
正しく動いているかを確認する方法も紹介します。

## 1. 必要なもの

- **Node.js 22.15 以降。** 22.5 でも動きますが、Codex が圧縮して保存している古いセッションを読めません。
  `node --version` で確認してください。
- Claude Code、Codex、opencode のうち少なくともひとつ。baton はそれぞれのデータを既定の場所から見つけます
  （`CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`XDG_DATA_HOME` にも従います）。

## 2. インストール

```bash
npm install -g https://github.com/ForeverMJ/agent-baton/releases/latest/download/agent-baton.tgz
baton --version
```

npm が最新リリースのビルド済みパッケージをダウンロードし、`baton` コマンドを PATH に追加します。`npx` 経由で実行するのではなく、
このように**グローバルに**インストールしてください。エージェントのフックや MCP 設定はインストールされたファイルを
参照しますが、`npx` のキャッシュは一時的なものだからです。

<details>
<summary>ソースからインストールする場合</summary>

```bash
git clone https://github.com/ForeverMJ/agent-baton.git
cd agent-baton
npm install
npm run build
npm link             # `baton` を PATH に追加
```
</details>

## 3. メモリを作成する

```bash
baton mem init
```

`~/.config/baton/memory/`（Windows では `C:\Users\<you>\.config\baton\memory\`）を作成し、過去 30 日分の会話を
ジャーナルに記録します。オプションは次のとおりです。

- `--since all` で全履歴を、`--since 7d` で直近 1 週間分だけを記録します。
- `--lang zh` または `--lang en` で、メモリファイル内の見出しの言語を指定します（既定値はシステムのロケールから決まります）。

あなた自身ではなくプログラムが開始したセッション（`codex exec`、`claude -p`、`opencode run`、エージェントを組み込んだ
アプリなど）はスキップされるので、自動実行のセッションに本当の会話が埋もれることはありません。

## 4. エージェントを接続する

```bash
baton install
```

baton は見つけたエージェントごとに次の 3 つを追加します。いずれも最初の変更の前に一度だけ `*.baton-backup` へ
バックアップされます。

| | MCP サーバー（メモリツール） | ルール（いつ保存し、いつ調べるか） | フック |
|---|---|---|---|
| Claude Code | `~/.claude.json` | `~/.claude/CLAUDE.md` | `~/.claude/settings.json` |
| Codex | `~/.codex/config.toml` | `~/.codex/AGENTS.md` | `~/.codex/hooks.json` |
| opencode | `~/.config/opencode/opencode.json` | `~/.config/opencode/AGENTS.md` | `~/.config/opencode/plugins/baton.js` |
| Claude デスクトップアプリ（Chat タブ） | `claude_desktop_config.json` | – | – |

書き込まれるのは baton 自身のエントリまたはマーク付きブロックだけで、ほかの設定はそのまま残ります。
特定のエージェントだけを接続するには `baton install claude`（または `codex`、`opencode`、`claude-desktop`）を実行します。

続いて次の手順を行います。

1. 起動中のエージェントを**再起動**します。デスクトップアプリも含みます（トレイアイコンから終了してください）。
   これで MCP サーバーとルールが読み込まれます。
2. **Codex：** `codex` を起動して `/hooks` と入力し、baton のエントリが `… cli.js hook codex` を実行するものであることを
   確認したうえで信頼（trust）します。Codex はあなたが確認していないフックを実行しません。信頼するまでの間も Codex は
   メモリツールを使えます。足りないのはセッション開始時の自動サマリーだけです。
3. **Claude デスクトップアプリの Chat タブ：** baton のツールを初めて使うときに許可してください。

## 5. 動作を確認する

```bash
baton mem status     # メモリの場所と、ジャーナルに記録された会話の数
baton mem brief      # セッション開始時にエージェントが受け取るサマリー
```

次に、エージェントをまたいで試してみましょう。

1. Codex で *「覚えておいて：メールは丁寧な日本語（敬語）で書き、署名は Zion。」* と伝えます。
   Codex が `memory_remember` を呼び出し、何を保存したかを教えてくれます。
2. `baton mem show` を実行します。この好みがプロフィールに入っていて、出どころとして `codex` が記されています。
3. **新しい** Claude Code のセッションで *「私のメールの書き方の好みは？」* と聞きます。セッションのサマリーに
   すでに答えが入っています。
4. そのまま Claude Code で *「最近 Codex で何の話をしたっけ？」* と聞きます。ジャーナルを検索してくれます。

説明どおりにならない場合は [トラブルシューティング](faq.md#troubleshooting) を参照してください。

## 6. 日々の使い方

- 普段どおりエージェントと会話するだけです。大事なことは保存し、過去の話に触れれば調べてくれます。
- 確実に残したいときは *「覚えておいて：…」* と言います。
- 別のエージェントで続けたいときは *「Codex で話してた旅行の件の続きをやって」* と頼みます。
- メモリを確認・編集するには `baton mem show` を使うか、Markdown ファイルを直接開きます。
- 何かを忘れさせたいときは、エージェントに頼むか `baton mem forget m:<id>` を実行します。

## 7. アンインストール

```bash
baton uninstall                 # すべてのエージェントからフック、MCP エントリ、ルールブロックを削除
npm uninstall -g agent-baton
```

メモリフォルダーはそのまま残ります。不要であれば `~/.config/baton/memory/` を削除してください。
`*.baton-backup` ファイルには、初回インストール前の設定がそのまま保存されています。

次へ：[共有メモリ](shared-memory.md) では、何が記憶され、エージェントがそれをどう使うかを説明します。
