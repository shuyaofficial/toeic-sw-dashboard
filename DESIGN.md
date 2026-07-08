# DESIGN.md — TOEIC Speaking 学習管理ダッシュボード

判断基準は一つ。**「スティーブ・ジョブズはこれで納得するか」**。
足し算ではなく引き算。1画面1フォーカス。余白・タイポ・動きで語る。装飾で語らない。

## 原則

1. **引き算** — 迷ったら削る。機能もUIも「無くて困るまで足さない」。
2. **1アクセント** — 色で意味を持たせるのは TOEICレッド1色＋状態色（緑/琥珀/赤）のみ。
3. **数字が主役** — 残りページ数・残り回数・残り問題数・締切/試験日までの日数を、大きく・美しく・tabular で。
4. **触って気持ちいい** — チェックは即・滑らか・確か（ばねイージング＋数値tween）。
5. **モバイル前提** — 学習はスマホ。max-width 680px 中央寄せ、指で押せる44px以上。
6. **静けさ** — 影は薄く、境界は繊細に。ダークモードは真っ黒(#000)を活かす。

## カラートークン（CSS変数）

```css
:root {
  color-scheme: light dark;
  --bg: #F5F5F7;
  --surface: #FFFFFF;
  --surface-2: #F4F4F7;
  --text: #1D1D1F;
  --text-2: #6E6E73;
  --text-3: #A1A1A6;
  --separator: rgba(0,0,0,0.08);
  --accent: #D6242D;         /* TOEICレッド（AZ-900のAzure青と区別） */
  --accent-soft: rgba(214,36,45,0.12);
  --success: #34C759;        /* 完了・前倒し */
  --warn:    #FF9F0A;        /* わずかに遅れ */
  --danger:  #FF3B30;        /* 遅れ */
  --ring-track: rgba(0,0,0,0.06);
  --shadow-card: 0 1px 2px rgba(0,0,0,.04), 0 10px 30px rgba(0,0,0,.06);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #000000;
    --surface: #1C1C1E;
    --surface-2: #2C2C2E;
    --text: #F5F5F7;
    --text-2: #AEAEB2;
    --text-3: #6E6E73;
    --separator: rgba(255,255,255,0.10);
    --accent: #E85960;       /* 同系色のまま明度を上げ、暗背景でコントラストを確保 */
    --accent-soft: rgba(232,89,96,0.18);
    --success: #30D158;
    --warn:    #FFD60A;
    --danger:  #FF453A;
    --ring-track: rgba(255,255,255,0.12);
    --shadow-card: none;     /* ダークは影の代わりに境界で分離 */
  }
}
```

`--accent` はコントラスト比を確認済み（light: `#D6242D` on white ≒ 5.06:1、dark: `#E85960` on black ≒
6.03:1 / on `#1C1C1E` ≒ 4.88:1。いずれも本文4.5:1以上）。`--danger` とは色相を約6°離し（357° vs 3°）、
彩度・明度も変えて視覚的に区別している。

状態色の使い分け（ペース判定）: `delta = done - 理想done`
- `delta >= 0` → **--success**（前倒し/オンtrack）
- `-必要日数分の0.5日相当 <= delta < 0` → **--warn**（わずかに遅れ）
- それ未満 → **--danger**（遅れ）

## タイポ

```css
--font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
        "Hiragino Sans", "Noto Sans JP", sans-serif;
```
数値は必ず `font-variant-numeric: tabular-nums;`。

| 用途 | size | weight | tracking |
|---|---|---|---|
| ヒーロー数字 | clamp(44px,12vw,64px) | 700 | -0.02em |
| 大リング中央数字 | 34px | 700 | -0.01em |
| セクション見出し | 22px | 700 | -0.01em |
| ヘッドライン | 17px | 600 | 0 |
| 本文 | 15px | 400 | 0 |
| キャプション | 13px | 400（--text-2） | 0 |
| マイクロ | 11px | 600（--text-3, 大文字トラッキング0.04em） | |

## スペーシング / 角丸 / 影

- スペース: 4 / 8 / 12 / 16 / 20 / 24 / 32 / 40（8基調）
- 角丸: sm 10 / md 14 / lg 20 / pill 999
- カード: `background:var(--surface); border-radius:20px; box-shadow:var(--shadow-card);`
  ダークは `border:1px solid var(--separator)` を併用
- ページ余白: 左右16–20px、上部にsafe-area対応 `env(safe-area-inset-*)`

## モーション

```css
--ease-out: cubic-bezier(.22,.61,.36,1);
--ease-spring: cubic-bezier(.34,1.56,.64,1);   /* チェック時のはね */
--dur-fast: 180ms; --dur: 280ms; --dur-slow: 460ms;
```
- リング: `stroke-dashoffset` を `--dur-slow var(--ease-out)`
- チェック: チェックマークをpath描画（stroke-dashoffset）＋ボックスを `scale(.9→1)` はね
- 数値: tween（requestAnimationFrame, ease-out, 約400ms）で increment/decrement
- `@media (prefers-reduced-motion: reduce)` で全アニメを実質無効化

## コンポーネント

### 進捗リング（SVG）
- 二重円: トラック(`--ring-track`)＋進捗(`--accent`)。`stroke-linecap:round`、`transform:rotate(-90deg)`
- 大(ヒーロー): 直径120–140、stroke 10–12、中央に「残数（タブごとに ページ/回/問）」＋下に「% 完了」
- 小(セクション見出し左): 直径28、stroke 4
- 完了(100%)時のみリングを `--success` に切替

### セグメントコントロール（① ゼミ / ② 模試 / ③ 演習）
- iOS風・3分割。`--surface-2` トラックに白（ダークは`--surface`）のピルが `transform:translateX` でスライド、
  `--dur var(--ease-out)`。ピル幅は `calc(33.333% - 2px)`、`translateX(0/100%/200%)` の3状態
- 選択中ラベルは weight 600、非選択は `--text-2`

### ゼミの項目行（①）
- 44px以上の行。左に丸チェックボックス、タイトル、右にページ数「◯p」（--text-3, tabular）
- 完了行: タイトルに取り消し線は付けない（品を保つ）。代わりにチェックを`--success`塗り＋行を少しだけ沈める（opacity .55）
- セクションカードは折りたたみ（既定=閉）。ヘッダに 小リング＋「name」＋ページ範囲＋「3/14」＋シェブロン

### 周回グリッド（② 模試 / ③ 演習）
- ②模試: 3行(模試1–3)×3列(1〜3周)。セル=角丸12のタップターゲット
  - 未了=枠線のみ / 完了=`--accent-soft`地＋チェック / スコア入力があれば中央に数値（0–200）
  - スコアは任意。セル右上の⋯で `0–200・10刻み` 入力（未入力可）。目標スコア以上は`--success`、未満は`--warn`
  - グリッド下に周ごと平均スコアのミニ折れ線＋**目標スコアのライン**（点線, --text-3, ラベル「目標 N」）
- ③演習: 5行(タイプ)×2列(1〜2周)。スコア入力なし、チェックのみ

### ヒーロー
- 上段: 「試験日まで N日」（専用スタイル）＋「①ゼミ〆切 N日」＋「②③演習〆切 N日」を横並びチップ。緊急度で色
- 中央: 現在タブの大リング＋大数字（残り or 完了、単位はタブごと）
- 下段: 「今日やるべき: ◯ページ / ◯回 / ◯問」＋前倒し/遅れバッジ

### 設定モーダル
- ヘッダ右上の歯車ボタンから開く。`role="dialog" aria-modal="true"`
- 項目: 試験日・①ゼミ〆切・②③演習〆切（`type="date"`）、目標スコア（`select`、0–200・10刻み）
- ボタン: 保存 / キャンセル / 既定に戻す（入力欄を初期値に戻す。反映には保存が必要）
- Esc・背景クリックで閉じる。開閉時にフォーカスを移動・復帰

## レイアウト
- 単一カラム、`max-width:680px`、中央。背景`--bg`。
- 上から: ヘッダ(アプリ名・小・歯車)→ヒーロー→セグメント(3分割)→タブ内容→フッタ(エクスポート/インポート/リセット, 控えめ)

## アクセシビリティ
- チェックは `role="checkbox" aria-checked`、キーボード操作可、`:focus-visible` に2px --accent リング
- コントラスト比 本文4.5:1以上。状態は色だけに依存せずアイコン/ラベル併記
- リング等の装飾SVGは `aria-hidden`、数値はテキストで別途提供
- 設定モーダルはフォーカストラップ相当（開閉時にフォーカス移動）、Escで閉じる
