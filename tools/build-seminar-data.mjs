#!/usr/bin/env node
/* ===========================================================================
   TOEIC Speaking 学習管理ダッシュボード — tools/build-seminar-data.mjs
   bookIndex.json から「①ゼミ」タブの sections 配列を生成する一回きりのスクリプト。
   出力は assets/data.js に手作業で貼り込む（自動書き込みはしない）。

   使い方:
     node tools/build-seminar-data.mjs <bookIndex.jsonのパス>

   出力:
     - stdout: sections 配列（JS表記、そのまま data.js に貼り込める形）
     - stderr: 項目数・ページ数合計のサマリ（検証用）

   重要な注意点（著作権 / データ設計）:
     - pages[].lesson だけで集計すると、別冊解答(p136–198)等に付与された
       元レッスン番号まで拾ってしまい「幽霊項目」が混入する。
       そのため章本体の実ページ範囲(RANGES)でフィルタする。
     - 出力はセクション名とページ数のみ。textJa/textEn/prompt/modelAnswer 等の
       本文フィールドには一切触れない（公開リポジトリに載るため著作権上の絶対条件）。
   =========================================================================== */

import fs from "node:fs";

const MAX_TITLE_LEN = 48;
const FALLBACK_SECTION_NAME = "本文・その他";

// 章本体のページ範囲。lesson フィールド単独では別冊解答等の再録ページを
// 誤って拾うため、実際のページ範囲で明示的にフィルタする。
const RANGES = [
  { id: "L01", lesson: 1, start: 11, end: 16 },
  { id: "L02", lesson: 2, start: 17, end: 27 },
  { id: "L03", lesson: 3, start: 28, end: 37 },
  { id: "L04", lesson: 4, start: 38, end: 47 },
  { id: "L05", lesson: 5, start: 48, end: 59 },
  { id: "L06", lesson: 6, start: 60, end: 69 },
  { id: "L07", lesson: 7, start: 70, end: 81 },
  { id: "L08", lesson: 8, start: 82, end: 93 },
  { id: "L09", lesson: 9, start: 94, end: 102 },
  { id: "L10", lesson: 10, start: 103, end: 113 },
  { id: "L11", lesson: 11, start: 114, end: 122 },
  { id: "LCK", lesson: 14, start: 199, end: 205 },
];

function truncateTitle(title) {
  if (title.length <= MAX_TITLE_LEN) return title;
  return title.slice(0, MAX_TITLE_LEN - 1) + "…";
}

function findChapterTitle(chapters, lesson) {
  const found = chapters.find((c) => c.lesson === lesson);
  return found ? found.title : null;
}

// 範囲内のページを section 文字列でグループ化（初出ページ順を保持）。
// section が null/空のページは「本文・その他」に集約する。
function buildItems(pages, start, end) {
  const order = [];
  const counts = new Map();
  pages
    .filter((p) => p.page >= start && p.page <= end)
    .forEach((p) => {
      const name = (p.section && String(p.section).trim()) || FALLBACK_SECTION_NAME;
      if (!counts.has(name)) {
        counts.set(name, 0);
        order.push(name);
      }
      counts.set(name, counts.get(name) + 1);
    });
  return order.map((name) => ({ t: truncateTitle(name), p: counts.get(name) }));
}

function jsString(v) {
  return JSON.stringify(v);
}

function formatItems(items) {
  return items
    .map((it) => `        { t: ${jsString(it.t)}, p: ${it.p} },`)
    .join("\n");
}

function formatSection(section) {
  return [
    `    {`,
    `      id: ${jsString(section.id)}, name: ${jsString(section.name)}, range: ${jsString(section.range)},`,
    `      items: [`,
    formatItems(section.items),
    `      ],`,
    `    },`,
  ].join("\n");
}

function main() {
  const bookIndexPath = process.argv[2];
  if (!bookIndexPath) {
    console.error("使い方: node tools/build-seminar-data.mjs <bookIndex.jsonのパス>");
    process.exit(1);
  }

  const raw = fs.readFileSync(bookIndexPath, "utf-8");
  const data = JSON.parse(raw);
  const chapters = Array.isArray(data.chapters) ? data.chapters : [];
  const pages = Array.isArray(data.pages) ? data.pages : [];

  const sections = RANGES.map((r) => {
    const chapterTitle = findChapterTitle(chapters, r.lesson);
    const name = chapterTitle || r.id;
    const items = buildItems(pages, r.start, r.end);
    return {
      id: r.id,
      name,
      range: `p${r.start}–${r.end}`,
      items,
    };
  });

  const totalItems = sections.reduce((n, s) => n + s.items.length, 0);
  const totalPages = sections.reduce(
    (n, s) => n + s.items.reduce((m, it) => m + it.p, 0),
    0
  );

  const body = sections.map(formatSection).join("\n");
  process.stdout.write(`[\n${body}\n]\n`);

  console.error(
    `[build-seminar-data] sections=${sections.length} items=${totalItems} pages=${totalPages}`
  );
  sections.forEach((s) => {
    const pageSum = s.items.reduce((m, it) => m + it.p, 0);
    console.error(`  ${s.id} ${s.range} items=${s.items.length} pages=${pageSum} name=${s.name}`);
  });
}

main();
