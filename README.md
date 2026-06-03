# Gantt for Obsidian

A ClickUp/Wrike-style Gantt for Obsidian. **One Markdown file = one task**; a configured folder is shown and edited as a **Wrike-style "table + timeline" Gantt**.

ClickUp / Wrike のようなタスク管理 UI を Obsidian で実現するプラグインです。**1 ファイル = 1 タスク**とし、指定フォルダ配下を **Wrike 風の「表＋タイムライン」ガント**で表示・編集します。

## Usage / 使い方

**English**

1. In **Settings → Gantt**, set the **target folder** (e.g. `Projects/Cleanup`).
2. Open the view from the **bar-chart ribbon icon** on the left, or the command **"Open Gantt"**.
3. Direct subfolders become **groups**, and the `.md` files inside them become **tasks**.
4. **Drag a bar / resize its edges** to write the new dates back to that file's `start`/`end` frontmatter.
5. Click a task to slide in a **detail panel** (dates, status, assignee, body) from the right.

The UI follows Obsidian's display language: Japanese when Obsidian is set to Japanese, English otherwise.

**日本語**

1. 設定 → Gantt で **対象フォルダ**を指定（例: `Projects/お掃除`）。
2. 左端リボンの **棒グラフアイコン**、またはコマンド「Gantt を開く」でビューを開く。
3. 直下のサブフォルダが**グループ**、その中の `.md` が**タスク**になります。
4. バーを**ドラッグ／端をリサイズ**すると、そのファイルのフロントマター `start`/`end` に書き戻します。
5. タスクをクリックすると、右から**詳細パネル**（日付・状態・担当・本文）がスライドインします。

UI 表示は Obsidian の表示言語に追従します（日本語なら日本語、それ以外は英語）。

## Task frontmatter / タスクの書き方

Each task is a single Markdown file. The schedule lives in frontmatter; the description is the body.

各タスクは 1 つの Markdown ファイル。スケジュールはフロントマター、説明は本文に書きます。

```markdown
---
start: 2026-02-04
end: 2026-02-07
status: in-progress
assignee: kato
after:
  - "[[Sweeping]]"     # predecessor (dependency arrow) / 先行タスク（依存＝矢印）
---

# Wiping
The body is the task description (shown in the detail panel). / 本文がタスクの説明（詳細パネルに表示）。
```

| Frontmatter / フロントマター | Meaning / 意味 |
|------------------------------|----------------|
| `start` / `end` | Start / end date `YYYY-MM-DD` (bar position and length). 開始 / 終了日（バーの位置と長さ） |
| `status` | Status ID (defined in settings, reflected in bar color). ステータス ID（設定で定義、バー色に反映） |
| `assignee` | Assignee (label shown next to the bar). 担当者（バー脇にラベル表示） |
| `after` | Array of wikilinks to predecessors (dependency arrows; violations turn red). 先行タスクへの wikilink 配列（依存＝矢印、違反は赤） |
| `progress` | Progress 0–100 (fill inside the bar). 進捗 0–100（バー内の塗り） |
| `milestone` | `true` for a diamond (zero duration). `true` で菱形（期間ゼロ） |

The task name is the file name (without extension); the group is the parent subfolder name. Frontmatter key names can be changed in settings.

タスク名はファイル名（拡張子なし）。グループは直上のサブフォルダ名。フロントマターのキー名は設定で変更できます。

Sample data for a quick try lives in `examples/お掃除プロジェクト/` (point the target folder at it).

`examples/お掃除プロジェクト/` に動作確認用のサンプルがあります（対象フォルダにそれを指定）。

## Dependencies / 依存関係

Drag from a bar's round handle to another bar to create a dependency. The connected ends decide the type: **FS** (finish→start), **SS** (start→start), **FF** (finish→finish). Click a dependency line to remove it (undo with **Ctrl+Z**, or the undo button).

バーの丸ハンドルから別のバーへドラッグすると依存を作成します。つないだ端で種類が決まります：**FS**（終了→開始）・**SS**（開始→開始）・**FF**（終了→終了）。依存線をクリックで切断（**Ctrl+Z** または取り消しボタンで戻せます）。

## Development / 開発

```bash
npm install      # install deps / 依存をインストール
npm run dev      # watch build / 監視ビルド
npm run build    # type-check + production build / 型チェック＋本番ビルド
```

Copy `main.js` / `manifest.json` / `styles.css` into `<vault>/.obsidian/plugins/task-gantt/` to enable it.

`main.js` / `manifest.json` / `styles.css` を `<vault>/.obsidian/plugins/task-gantt/` にコピーして有効化。

## Design / 設計

See [`docs/adr/`](./docs/adr/) for the rationale behind design decisions (latest direction: ADR-0004) and [`CONTEXT.md`](./CONTEXT.md) for terminology.

設計判断の経緯は [`docs/adr/`](./docs/adr/)（最新方針は ADR-0004）、用語は [`CONTEXT.md`](./CONTEXT.md) を参照。

### Limitations / 既知の制限

Auto-scheduling (critical path), sub-day time granularity, cross-folder aggregation, board/table views, and a task-creation UI are not yet implemented.

自動スケジューリング（クリティカルパス）・時刻粒度・複数フォルダ横断・ボード/テーブルビュー・タスク新規作成 UI は未実装。

## License / ライセンス

MIT — see [`LICENSE`](./LICENSE). / MIT ライセンス（[`LICENSE`](./LICENSE) を参照）。
