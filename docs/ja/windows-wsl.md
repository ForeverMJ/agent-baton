# Windows + WSL

[English](../windows-wsl.md) · [中文](../zh-CN/windows-wsl.md) · 日本語

一部のエージェントを Windows で、ほかのエージェントを WSL ディストリビューション内で動かしている方は多いでしょう。
baton は両者をつなぎます。共有メモリはひとつで、引き継ぎも境界をまたいで行えます。

## Windows と WSL でメモリを共有する

まず Windows 側でメモリを準備し（`baton mem init`、`baton install`）、次のコマンドを実行します。

```bash
baton mem share wsl:Ubuntu
```

これは Windows 上で実行します。ディストリビューションの**内部**に Node.js 22.5 以降が必要です。このコマンドは次のことを行います。

1. Windows 側の baton にディストリビューションを登録します（`baton env add wsl:Ubuntu`）。これにより、Windows の
   エージェントが WSL 内で行われた会話のトランスクリプトを読めるようになります。
2. ディストリビューション内で、逆方向のために Windows ホストを登録します（`baton env add windows`）。
3. ディストリビューション内で、2 つ目のメモリを作るのではなく、Windows のメモリに参加します
   （`baton mem init --join /mnt/c/Users/<you>/.config/baton/memory`）。
4. ディストリビューション内で、その Claude Code、Codex、opencode に対して `baton install` を実行します。

その後、ディストリビューション内で動いているエージェントを再起動し、そこの Codex でフックを信頼（trust）してください（`/hooks`）。

全体の構成は次のとおりです。

```
Windows                                         WSL distro
 ~/.config/baton/memory/  ◀──── /mnt/c/… ────── baton (local copy in ~/.local/share/baton)
 journals Windows conversations                 journals its own conversations, as claude@wsl:Ubuntu
 reads WSL transcripts via wsl.exe ───────────▶ reads Windows transcripts via node.exe
```

- **メモリはひとつ。** ディストリビューションは `/mnt/c` を通じて Windows のメモリを読み書きします。両側からの書き込みは
  同じロックファイルによって順番に処理されます。
- **会話はそれぞれの側が自分でジャーナルに記録します。** ディストリビューションからのエントリには
  `claude@wsl:Ubuntu`、`opencode@wsl:Ubuntu` のようなラベルが付き、そこで保存された項目も同様です。
- **ローカルコピー。** `/mnt/c` から baton を読み込むと、ファイルブリッジの影響で 1 回の呼び出しに約 0.35 秒かかります。
  そのため WSL 内では `baton install` が自身を `~/.local/share/baton` にコピーし、フックはそのコピーを使います
  （セッション開始 1 回あたり約 0.2 秒）。baton を更新したら、`baton mem share` を再度実行してコピーを更新してください。
- メモリの場所は、ディストリビューションの `~/.config/baton/config.json` に `memoryDir` として記録されます。
  ディストリビューション内で `baton mem init --join <dir>` を実行すれば、同じことを手動で行えます。

## Windows と WSL をまたいだ引き継ぎ

引き継ぎで反対側のセッションも参照できるようにするには、次のようにします。

```bash
baton env detect          # Windows 上: エージェントのデータがある WSL ディストリビューションを検出; WSL 内: Windows ホストを追加
baton env add wsl:Ubuntu  # または明示的に追加
baton env list
baton env remove wsl:Ubuntu
```

以降は `baton list`、`baton capture`、フックが、もう一方の環境のセッション（`codex@wsl:Ubuntu` のように表示）も
対象にします。1 回のコマンドだけほかの環境を無視するには `--local` を使います。
`baton mem share` もこの方法でディストリビューションを登録するので、実行後は `baton init` を実行したプロジェクトでの
引き継ぎも、セッション開始時に WSL を参照するようになります（少し遅くなります）。

baton は反対側のファイルを直接は読みません。SQLite は WSL のファイルブリッジ越しにデータベースを開けず、Windows の git は
WSL 内のリポジトリを拒否し、パスも異なるためです。代わりに、同じ `cli.js` をもう一方の環境内で実行し、そちらの
エージェントのデータをネイティブに読ませて、セッションを JSON で返させます。パスは変換されます
（`C:\dev\p` ↔ `/mnt/c/dev/p`、`\\wsl.localhost\Ubuntu\home\u\p` ↔ `/home/u/p`）。

もう一方の環境に Node.js がない場合、`env add` は**ダイレクトモード**にフォールバックします。このモードでは、
baton が境界越しに反対側のファイルを読みます。

| ダイレクトモード | Claude Code | Codex | opencode |
|---|---|---|---|
| Windows から WSL ディストリビューションを読む | ✓ | ✓ | ✗（SQLite がブリッジ越しにデータベースを開けない） |
| WSL から Windows を読む | ✓ | ✓ | ✓ |

共有メモリにはディストリビューション内の Node.js が必要です。ダイレクトモードは引き継ぎ専用です。

## 補足

- **両側でクローンしたリポジトリ**は、リポジトリ単位の照合を有効にしない限り、別々のプロジェクトとして扱われます
  （[引き継ぎ](handoff.md#several-clones-of-one-repository)）。
- **`wsl --exec` はシェルのプロファイルを読み込みません。** そのため `env add` はログインシェル経由で Node を探し、
  その絶対パスを保存します。ディストリビューション内で Node を移動した場合は、`baton env add` を再実行してください。
- **Windows の Git Bash からテストする場合：** Git Bash は `/mnt/...` という引数を書き換えてしまいます。コマンドの前に
  `MSYS_NO_PATHCONV=1` を付けるか、PowerShell を使ってください。
