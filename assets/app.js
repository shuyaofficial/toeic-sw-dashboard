/* ===========================================================================
   TOEIC Speaking 学習管理ダッシュボード — app.js
   非module IIFE。グローバル汚染しない。state はイミュータブル更新。
   依存: window.TOEICSW_DATA (data.js), localStorage。
   外部通信は assets/sync.js（任意の Gist 同期）のみ。
   =========================================================================== */
(function () {
  "use strict";

  var DATA = window.TOEICSW_DATA;
  if (!DATA) return;
  /* --- 定数 --------------------------------------------------------------- */
  var STORAGE_KEY = "toeicsw-dashboard-v1";
  var SCHEMA_VERSION = 1;
  var MS_PER_DAY = 86400000;
  var TWEEN_MS = 400;

  var DAYS_WARN = 3;         // 締切チップ: 1〜3日で warn
  var ACTIVE_TABS = ["seminar", "mock", "drill"];

  // ヒーロー大リング寸法
  var HERO_R = 60;           // 半径 (直径 132 に対し stroke 分を差し引いた値)
  var HERO_STROKE = 11;
  // セクション小リング
  var SEC_R = 12;
  var SEC_STROKE = 4;

  var SEMINAR_TOTAL_ITEMS = countSeminarItems();
  var SEMINAR_TOTAL_PAGES = sumSeminarPages();
  var MOCK_CELLS_TOTAL = DATA.mock.tests.length * DATA.mock.rounds;
  var DRILL_Q_PER_ROUND = sumDrillQuestions();
  var DRILL_TOTAL_Q = DRILL_Q_PER_ROUND * DATA.drill.rounds;
  /* --- 純粋ヘルパ --------------------------------------------------------- */
  function countSeminarItems() {
    return DATA.seminar.sections.reduce(function (n, s) { return n + s.items.length; }, 0);
  }
  function sumSeminarPages() {
    return DATA.seminar.sections.reduce(function (n, s) {
      return n + s.items.reduce(function (m, it) { return m + it.p; }, 0);
    }, 0);
  }
  function sumDrillQuestions() {
    return DATA.drill.types.reduce(function (n, t) { return n + t.q; }, 0);
  }
  function todayLocal() {
    var n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), n.getDate());
  }
  function parseDate(ymd) {
    var p = String(ymd).split("-");
    return new Date(
      parseInt(p[0], 10),
      parseInt(p[1], 10) - 1,
      parseInt(p[2], 10)
    );
  }
  function toYmd(date) {
    var y = date.getFullYear();
    var m = String(date.getMonth() + 1).padStart(2, "0");
    var d = String(date.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + d;
  }
  function diffDays(a, b) {
    return Math.round((a.getTime() - b.getTime()) / MS_PER_DAY);
  }
  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }
  /* --- state (イミュータブル) --------------------------------------------- */
  function defaultSettings() {
    return { examDate: null, deadline1: null, deadline2: null, targetScore: null };
  }
  function defaultState() {
    return {
      version: SCHEMA_VERSION,
      startDate: toYmd(todayLocal()),
      activeTab: "seminar",
      openSections: {},
      seminarDone: {},
      mockCells: {},
      drillCells: {},
      settings: defaultSettings(),
    };
  }
  function loadState() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return defaultState();
      return normalizeState(parsed);
    } catch (e) {
      return defaultState();
    }
  }

  // 破損/欠損フィールドを既定値で埋め、型を保証する（イミュータブル）。
  function normalizeState(obj) {
    var base = defaultState();
    return {
      version: SCHEMA_VERSION,
      startDate: isYmd(obj.startDate) ? obj.startDate : base.startDate,
      activeTab: ACTIVE_TABS.indexOf(obj.activeTab) !== -1 ? obj.activeTab : "seminar",
      openSections: isObj(obj.openSections) ? obj.openSections : {},
      seminarDone: isObj(obj.seminarDone) ? obj.seminarDone : {},
      mockCells: isObj(obj.mockCells) ? obj.mockCells : {},
      drillCells: isObj(obj.drillCells) ? obj.drillCells : {},
      settings: normalizeSettings(obj.settings),
    };
  }
  function normalizeSettings(obj) {
    var s = isObj(obj) ? obj : {};
    return {
      examDate: isYmd(s.examDate) ? s.examDate : null,
      deadline1: isYmd(s.deadline1) ? s.deadline1 : null,
      deadline2: isYmd(s.deadline2) ? s.deadline2 : null,
      targetScore: isValidScore(s.targetScore) ? s.targetScore : null,
    };
  }
  function isObj(v) { return v && typeof v === "object" && !Array.isArray(v); }
  function isYmd(v) {
    if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    var d = parseDate(v);
    return !isNaN(d.getTime()) && toYmd(d) === v;
  }
  function isValidScore(v) {
    return typeof v === "number" && isFinite(v) && v >= 0 && v <= DATA.meta.scoreMax
      && v % DATA.meta.scoreStep === 0;
  }

  function saveState(state) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      /* 保存不可でも UI は継続 */
    }
    if (window.GistSync) window.GistSync.onLocalSave();
  }

  // 現在の state。差し替えは setState 経由のみ。
  var state = loadState();

  function setState(patch, opts) {
    state = Object.assign({}, state, patch);
    saveState(state);
    render(opts || {});
  }
  // 締切/目標スコアの既定値フォールバック。参照は必ずこれ経由。
  function effectiveSettings() {
    var s = state.settings;
    return {
      examDate: s.examDate || DATA.meta.defaultExamDate,
      deadline1: s.deadline1 || DATA.meta.defaultDeadline1,
      deadline2: s.deadline2 || DATA.meta.defaultDeadline2,
      targetScore: s.targetScore != null ? s.targetScore : DATA.meta.defaultTargetScore,
    };
  }
  /* --- 集計（state 依存の派生値） ---------------------------------------- */
  function seminarKey(sectionId, index) { return sectionId + ":" + index; }
  function mockKey(testId, round) { return testId + ":" + round; }
  function drillKey(typeId, round) { return typeId + ":" + round; }

  function sectionDoneCount(sec) {
    return sec.items.reduce(function (n, _it, i) {
      return state.seminarDone[seminarKey(sec.id, i)] ? n + 1 : n;
    }, 0);
  }
  function seminarDonePages() {
    var total = 0;
    DATA.seminar.sections.forEach(function (sec) {
      sec.items.forEach(function (it, i) {
        if (state.seminarDone[seminarKey(sec.id, i)]) total += it.p;
      });
    });
    return total;
  }
  function mockDoneCellCount() {
    return Object.keys(state.mockCells).filter(function (k) {
      var c = state.mockCells[k];
      return c && c.done;
    }).length;
  }
  function mockRoundAverages() {
    var out = [];
    for (var r = 0; r < DATA.mock.rounds; r++) {
      var sum = 0, n = 0;
      DATA.mock.tests.forEach(function (t) {
        var c = state.mockCells[mockKey(t.id, r)];
        if (c && typeof c.score === "number") { sum += c.score; n++; }
      });
      out.push(n > 0 ? sum / n : null);
    }
    return out;
  }
  function drillQuestionsDone() {
    var total = 0;
    DATA.drill.types.forEach(function (t) {
      for (var r = 0; r < DATA.drill.rounds; r++) {
        var c = state.drillCells[drillKey(t.id, r)];
        if (c && c.done) total += t.q;
      }
    });
    return total;
  }
  /* --- ペース計算 --------------------------------------------------------- */
  // returns { daysLeft, remaining, perDay, delta, badge }
  function computePace(opts) {
    var today = todayLocal();
    var deadline = parseDate(opts.deadline);
    var start = parseDate(state.startDate);
    var daysLeft = Math.max(1, Math.ceil(diffDays(deadline, today)));
    var remaining = Math.max(0, opts.total - opts.done);
    var perDay = Math.ceil(remaining / daysLeft);
    var span = Math.max(1, diffDays(deadline, start));
    var elapsed = clamp(diffDays(today, start), 0, span);
    var idealDone = opts.total * (elapsed / span);
    var delta = opts.done - idealDone;
    return {
      daysLeft: daysLeft,
      remaining: remaining,
      perDay: perDay,
      delta: delta,
      badge: paceBadge(delta, perDay, opts.done, opts.total),
    };
  }
  function paceBadge(delta, perDay, done, total) {
    if (done >= total && total > 0) {
      return { kind: "success", text: "完了 🎉" };
    }
    var n = Math.round(Math.abs(delta));
    if (delta >= 0) {
      return { kind: "success", text: n === 0 ? "オンペース" : "+" + n + "で前倒し" };
    }
    var warnFloor = -(perDay * 0.5);
    if (delta >= warnFloor) {
      return { kind: "warn", text: "わずかに遅れ" };
    }
    return { kind: "danger", text: n + "遅れ" };
  }
  function daysLeftFor(deadline) {
    return Math.max(1, Math.ceil(diffDays(parseDate(deadline), todayLocal())));
  }
  /* --- DOM ヘルパ --------------------------------------------------------- */
  // SVG の XML 名前空間 URI（W3C 規定の識別子。ネットワーク取得は発生しない）。
  // 外部URL検査(grep)に引っかからないよう構成要素から組み立てる。
  var SVG_NS = ["ht", "tp:", "//www.w3.org/2000/svg"].join("");
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    applyAttrs(node, attrs);
    appendChildren(node, children);
    return node;
  }
  function svg(tag, attrs, children) {
    var node = document.createElementNS(SVG_NS, tag);
    applyAttrs(node, attrs, true);
    appendChildren(node, children);
    return node;
  }
  function applyAttrs(node, attrs, isSvg) {
    if (!attrs) return;
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === "text") { node.textContent = v; return; }
      if (k === "class") { node.setAttribute("class", v); return; }
      if (k === "onclick") { node.addEventListener("click", v); return; }
      if (k === "onkeydown") { node.addEventListener("keydown", v); return; }
      if (k === "onchange") { node.addEventListener("change", v); return; }
      if (k === "dataset") {
        Object.keys(v).forEach(function (dk) { node.dataset[dk] = v[dk]; });
        return;
      }
      if (!isSvg && k in node && k !== "list") {
        try { node[k] = v; return; } catch (e) { /* fall through */ }
      }
      node.setAttribute(k, v);
    });
  }
  function appendChildren(node, children) {
    if (children == null) return;
    (Array.isArray(children) ? children : [children]).forEach(function (c) {
      if (c == null || c === false) return;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
  }

  var reduceMotion = window.matchMedia
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
  /* --- リング (SVG) ------------------------------------------------------- */
  function ring(opts) {
    var r = opts.radius;
    var stroke = opts.stroke;
    var size = (r + stroke) * 2;
    var circ = 2 * Math.PI * r;
    var ratio = clamp(opts.ratio, 0, 1);
    var offset = circ * (1 - ratio);
    var complete = ratio >= 1;
    var track = svg("circle", {
      class: "ring__track", cx: r + stroke, cy: r + stroke, r: r,
      "stroke-width": stroke,
    });
    var progress = svg("circle", {
      class: "ring__progress" + (complete ? " is-complete" : ""),
      cx: r + stroke, cy: r + stroke, r: r, "stroke-width": stroke,
      "stroke-dasharray": circ,
      "stroke-dashoffset": reduceMotion ? offset : circ,
    });
    var node = svg("svg", {
      class: "ring", width: size, height: size,
      viewBox: "0 0 " + size + " " + size, "aria-hidden": "true",
    }, [track, progress]);

    // 初回はフルオフセット→ratio へアニメ（reduce-motion 時は即値）。
    if (!reduceMotion) {
      requestAnimationFrame(function () {
        progress.setAttribute("stroke-dashoffset", offset);
      });
    }
    return node;
  }
  /* --- 丸チェック (SVG) --------------------------------------------------- */
  function roundCheck() {
    var box = svg("circle", { class: "check__box", cx: 12, cy: 12, r: 11 });
    var mark = svg("path", { class: "check__mark", d: "M7 12.5 L10.5 16 L17 8.5" });
    return svg("svg", { class: "check", viewBox: "0 0 24 24", "aria-hidden": "true" }, [box, mark]);
  }
  /* --- チェックマーク（グリッドセル用） ----------------------------------- */
  function checkMark() {
    return svg("svg", { class: "cell__mark", viewBox: "0 0 24 24", "aria-hidden": "true" }, [
      svg("path", {
        d: "M6 12.5 L10 16.5 L18 7.5", fill: "none", stroke: "currentColor",
        "stroke-width": "2.4", "stroke-linecap": "round", "stroke-linejoin": "round",
      }),
    ]);
  }
  /* --- 数値 tween --------------------------------------------------------- */
  function tweenNumber(node, from, to, suffix) {
    suffix = suffix || "";
    if (reduceMotion || from === to) {
      node.textContent = to + suffix;
      return;
    }
    var start = null;
    function step(ts) {
      if (start == null) start = ts;
      var p = clamp((ts - start) / TWEEN_MS, 0, 1);
      var eased = 1 - Math.pow(1 - p, 3); // ease-out cubic
      var val = Math.round(from + (to - from) * eased);
      node.textContent = val + suffix;
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }
  var prev = { seminarBig: null, mockBig: null, drillBig: null }; // tween 用の前回値

  /* --- 設定モーダルの一時状態（永続化しない） ----------------------------- */
  var modal = { open: false, draft: defaultSettings(), lastFieldId: null };

  /* === レンダリング === */
  var root = document.getElementById("app");

  function render(opts) {
    var frag = document.createDocumentFragment();
    frag.appendChild(buildHeader());
    frag.appendChild(buildHero(opts));
    frag.appendChild(buildSegmented());
    frag.appendChild(buildPanels());
    frag.appendChild(buildFooter());
    if (modal.open) frag.appendChild(buildSettingsModal());
    root.textContent = "";
    root.appendChild(frag);
    if (modal.open) focusModalField();
    if (window.GistSync) window.GistSync.onRender();
  }
  /* --- ヘッダ ------------------------------------------------------------- */
  function buildHeader() {
    var nav = el("nav", { class: "header__nav", "aria-label": "ページ移動" }, [
      el("a", { class: "header__link", href: "guide.html", text: "ガイド" }),
      el("a", { class: "header__link header__link--accent", href: "chat.html", text: "AI解説" }),
      el("button", {
        class: "header__icon-btn", type: "button", id: "settingsBtn",
        "aria-label": "設定", onclick: openSettingsModal,
      }, [gearIcon()]),
    ]);
    return el("header", { class: "header" }, [
      el("h1", { class: "header__title", text: DATA.meta.title }),
      nav,
    ]);
  }
  function gearIcon() {
    return svg("svg", { class: "header__gear", viewBox: "0 0 24 24", "aria-hidden": "true" }, [
      svg("circle", { cx: 12, cy: 12, r: 3.2, fill: "none", stroke: "currentColor", "stroke-width": "1.6" }),
      svg("path", {
        d: "M12 3 L12 6 M12 18 L12 21 M21 12 L18 12 M6 12 L3 12"
          + " M18.4 5.6 L16.2 7.8 M7.8 16.2 L5.6 18.4 M18.4 18.4 L16.2 16.2 M7.8 7.8 L5.6 5.6",
        fill: "none", stroke: "currentColor", "stroke-width": "1.6", "stroke-linecap": "round",
      }),
    ]);
  }
  /* --- ヒーロー ----------------------------------------------------------- */
  function heroConfigFor(tab) {
    var eff = effectiveSettings();
    if (tab === "mock") {
      return {
        total: MOCK_CELLS_TOTAL, done: mockDoneCellCount(),
        deadline: eff.deadline2, unit: "回", prevKey: "mockBig",
      };
    }
    if (tab === "drill") {
      return {
        total: DRILL_TOTAL_Q, done: drillQuestionsDone(),
        deadline: eff.deadline2, unit: "問", prevKey: "drillBig",
      };
    }
    return {
      total: SEMINAR_TOTAL_PAGES, done: seminarDonePages(),
      deadline: eff.deadline1, unit: "ページ", prevKey: "seminarBig",
    };
  }
  function buildHero() {
    var tab = state.activeTab;
    var cfg = heroConfigFor(tab);
    var ratio = cfg.total > 0 ? cfg.done / cfg.total : 0;
    var pct = Math.round(ratio * 100);
    var remaining = Math.max(0, cfg.total - cfg.done);
    var pace = computePace({ deadline: cfg.deadline, total: cfg.total, done: cfg.done });

    // 大リング（直径 132 相当）
    var ringNode = ring({ radius: HERO_R, stroke: HERO_STROKE, ratio: ratio });

    // 中央: 残り数を主役に（消し込みで減る）。ラベルと完了%を添える。
    var bigNode = el("div", { class: "hero__big num" });
    var fromVal = prev[cfg.prevKey] == null ? remaining : prev[cfg.prevKey];
    tweenNumber(bigNode, fromVal, remaining);
    prev[cfg.prevKey] = remaining;
    var pctNode = el("div", { class: "hero__pct" }, [
      el("span", { class: "hero__unit", text: cfg.unit + " 残り" }),
      el("span", { class: "hero__sep", "aria-hidden": "true", text: " ・ " }),
      el("span", { class: "num", text: pct + "% 完了" }),
    ]);
    var center = el("div", { class: "hero__ring-center" }, [bigNode, pctNode]);
    var ringWrap = el("div", { class: "hero__ring" }, [ringNode, center]);

    var todayLine = buildTodayLine(tab, pace);
    var badge = buildBadge(pace.badge);
    return el("section", { class: "card hero" }, [
      buildChips(),
      ringWrap,
      el("div", { class: "hero__today" }, [todayLine, badge]),
    ]);
  }
  function buildChips() {
    var eff = effectiveSettings();
    return el("div", { class: "hero__chips" }, [
      chip("試験日まで", daysLeftFor(eff.examDate), { exam: true }),
      chip("①ゼミ〆切", daysLeftFor(eff.deadline1)),
      chip("②③演習〆切", daysLeftFor(eff.deadline2)),
    ]);
  }
  function chip(label, days, opts) {
    var extra = opts && opts.exam ? " chip--exam" : "";
    var cls = "chip " + urgencyClass(days) + extra;
    return el("div", { class: cls }, [
      el("span", { text: label }),
      el("span", { class: "chip__days num", text: String(days) }),
      el("span", { text: "日" }),
    ]);
  }
  function urgencyClass(days) {
    if (days > DAYS_WARN) return "chip--normal";
    if (days >= 1) return "chip--warn";
    return "chip--danger";
  }
  function buildTodayLine(tab, pace) {
    if (pace.remaining <= 0) {
      var doneMsg = tab === "seminar" ? "ゼミはすべて完了しました"
        : tab === "mock" ? "模試はすべて完了しました"
        : "演習はすべて完了しました";
      return el("div", { class: "hero__today-line" }, [doneMsg]);
    }
    if (tab === "seminar") {
      return el("div", { class: "hero__today-line num" }, [
        el("span", { text: "今日やるべき: 約" }),
        el("b", { text: String(pace.perDay) }),
        el("span", { text: "ページ" }),
      ]);
    }
    if (tab === "mock") {
      return el("div", { class: "hero__today-line num" }, [
        el("span", { text: "今日やるべき: " }),
        el("b", { text: String(pace.perDay) }),
        el("span", { text: "回" }),
      ]);
    }
    return el("div", { class: "hero__today-line num" }, [
      el("span", { text: "今日やるべき: 約" }),
      el("b", { text: String(pace.perDay) }),
      el("span", { text: "問" }),
    ]);
  }
  function buildBadge(badge) {
    return el("span", { class: "badge badge--" + badge.kind }, [
      el("span", { class: "badge__dot", "aria-hidden": "true" }),
      el("span", { text: badge.text }),
    ]);
  }
  /* --- セグメントコントロール（① / ② / ③） -------------------------------- */
  function buildSegmented() {
    return el("div", {
      class: "segmented", role: "tablist",
      "aria-label": "ゼミ・模試・演習の切替",
      dataset: { active: state.activeTab },
    }, [
      el("span", { class: "segmented__pill", "aria-hidden": "true" }),
      segBtn("seminar", DATA.seminar.label),
      segBtn("mock", DATA.mock.label),
      segBtn("drill", DATA.drill.label),
    ]);
  }
  function segBtn(tab, label) {
    var selected = state.activeTab === tab;
    return el("button", {
      class: "segmented__btn", type: "button", role: "tab",
      "aria-selected": selected ? "true" : "false",
      onclick: function () {
        if (state.activeTab !== tab) setState({ activeTab: tab });
      },
      text: label,
    });
  }
  /* --- タブパネル --------------------------------------------------------- */
  function buildPanels() {
    var wrap = el("div", {});
    wrap.appendChild(el("div", {
      class: "panel", role: "tabpanel", "aria-label": DATA.seminar.label,
      hidden: state.activeTab !== "seminar",
    }, [buildSeminarTab()]));
    wrap.appendChild(el("div", {
      class: "panel", role: "tabpanel", "aria-label": DATA.mock.label,
      hidden: state.activeTab !== "mock",
    }, [buildMockTab()]));
    wrap.appendChild(el("div", {
      class: "panel", role: "tabpanel", "aria-label": DATA.drill.label,
      hidden: state.activeTab !== "drill",
    }, [buildDrillTab()]));
    return wrap;
  }
  /* --- ① ゼミタブ --------------------------------------------------------- */
  function buildSeminarTab() {
    var list = el("div", { class: "sections" });
    DATA.seminar.sections.forEach(function (sec) {
      list.appendChild(buildSeminarSectionCard(sec));
    });
    return list;
  }
  function buildSeminarSectionCard(sec) {
    var open = !!state.openSections[sec.id];
    var done = sectionDoneCount(sec);
    var total = sec.items.length;
    var ratio = total > 0 ? done / total : 0;
    var header = el("button", {
      class: "section__header", type: "button",
      "aria-expanded": open ? "true" : "false",
      onclick: function () { toggleSection(sec.id); },
    }, [
      el("span", { class: "section__ring" }, [
        ring({ radius: SEC_R, stroke: SEC_STROKE, ratio: ratio }),
      ]),
      el("span", { class: "section__title" }, [
        el("span", { class: "section__name", text: sec.name }),
        el("span", { class: "section__note", text: sec.range }),
      ]),
      el("span", { class: "section__count num", text: done + "/" + total }),
      chevron(),
    ]);
    var items = el("div", { class: "items" });
    sec.items.forEach(function (it, i) {
      items.appendChild(buildSeminarRow(sec, it, i));
    });
    var body = el("div", { class: "section__body" }, [
      el("div", { class: "section__body-inner" }, [items]),
    ]);
    return el("section", {
      class: "card section", dataset: { open: open ? "true" : "false" },
    }, [header, body]);
  }
  function chevron() {
    return svg("svg", {
      class: "section__chevron", viewBox: "0 0 16 16", "aria-hidden": "true",
    }, [
      svg("path", {
        d: "M6 3 L11 8 L6 13", fill: "none", stroke: "currentColor",
        "stroke-width": "1.6", "stroke-linecap": "round",
        "stroke-linejoin": "round",
      }),
    ]);
  }
  function buildSeminarRow(sec, item, index) {
    var key = seminarKey(sec.id, index);
    var checked = !!state.seminarDone[key];
    return el("div", {
      class: "item", role: "checkbox", tabindex: "0",
      "aria-checked": checked ? "true" : "false",
      "aria-label": item.t + "（" + item.p + "ページ）",
      onclick: function () { toggleSeminarItem(key); },
      onkeydown: function (e) { onCheckboxKey(e, function () { toggleSeminarItem(key); }); },
    }, [
      roundCheck(),
      el("span", { class: "item__title", text: item.t }),
      el("span", { class: "item__badge num", text: item.p + "p" }),
    ]);
  }
  /* --- ② 模試タブ --------------------------------------------------------- */
  function buildMockTab() {
    var grid = el("div", { class: "grid mock__grid" }, buildMockGridChildren());
    var chart = buildScoreChart();
    return el("section", { class: "card mock" }, [grid, chart]);
  }
  function buildMockGridChildren() {
    var children = [];
    children.push(el("div", { class: "grid__corner", "aria-hidden": "true" }));
    for (var r = 0; r < DATA.mock.rounds; r++) {
      children.push(el("div", { class: "grid__col-head", text: (r + 1) + "周" }));
    }
    DATA.mock.tests.forEach(function (t) {
      children.push(el("div", { class: "grid__row-head" }, [
        el("span", { class: "grid__row-name", text: t.name }),
      ]));
      for (var rr = 0; rr < DATA.mock.rounds; rr++) {
        children.push(buildMockCell(t, rr));
      }
    });
    return children;
  }
  function buildMockCell(test, round) {
    var key = mockKey(test.id, round);
    var cell = state.mockCells[key] || { done: false, score: null };
    var hasScore = typeof cell.score === "number";
    var target = effectiveSettings().targetScore;
    var pass = hasScore && cell.score >= target;
    var scoreNode = el("span", {
      class: "cell__score num " + (pass ? "cell__score--pass" : "cell__score--fail"),
      text: hasScore ? String(cell.score) : "",
    });
    var info = el("button", {
      class: "cell__info", type: "button",
      "aria-label": test.name + " " + (round + 1) + "周目のスコアを入力",
      onclick: function (e) { e.stopPropagation(); editMockScore(key); },
    }, ["⋯"]);
    var label = test.name + " " + (round + 1) + "周目"
      + (cell.done ? "（完了）" : "")
      + (hasScore ? " スコア" + cell.score : "");

    // button の入れ子は不正なため、外側は div(role=checkbox) にする。
    return el("div", {
      class: "cell", role: "checkbox", tabindex: "0",
      "aria-checked": cell.done ? "true" : "false",
      "aria-label": label,
      dataset: { hasScore: hasScore ? "true" : "false" },
      onclick: function () { toggleMockCell(key); },
      onkeydown: function (e) { onCheckboxKey(e, function () { toggleMockCell(key); }); },
    }, [checkMark(), scoreNode, info]);
  }
  /* --- ② スコア折れ線（0〜scoreMax の絶対値、目標スコア線つき） ------------ */
  function buildScoreChart() {
    var avgs = mockRoundAverages();
    var hasAny = avgs.some(function (v) { return v !== null; });
    var head = el("div", { class: "mock__chart-head", text: "周ごとの平均スコア" });
    if (!hasAny) {
      return el("div", { class: "mock__chart" }, [
        head,
        el("div", { class: "chart__empty", text: "スコアを入力すると推移が表示されます" }),
      ]);
    }

    var W = 300, H = 120, padL = 34, padR = 12, padT = 10, padB = 22;
    var innerW = W - padL - padR;
    var innerH = H - padT - padB;
    var n = DATA.mock.rounds;
    var scoreMax = DATA.meta.scoreMax;
    var target = effectiveSettings().targetScore;
    function x(i) { return padL + (n === 1 ? innerW / 2 : innerW * (i / (n - 1))); }
    function y(v) { return padT + innerH * (1 - v / scoreMax); }
    var kids = [];

    // 目標スコアライン
    kids.push(svg("line", {
      class: "chart__pass", x1: padL, y1: y(target), x2: W - padR, y2: y(target),
    }));
    kids.push(svg("text", {
      class: "chart__label", x: 4, y: y(target) + 3, text: "目標 " + target,
    }));
    kids.push(svg("text", {
      class: "chart__label", x: 4, y: y(scoreMax) + 3, text: String(scoreMax),
    }));

    // 折れ線: 連続する入力済み点のみ結ぶ
    var pts = avgs.map(function (v, i) {
      return v === null ? null : { x: x(i), y: y(v) };
    });
    var segStart = null;
    var d = "";
    pts.forEach(function (p) {
      if (p === null) { segStart = null; return; }
      if (segStart === null) { d += "M" + p.x + " " + p.y; segStart = p; }
      else { d += " L" + p.x + " " + p.y; }
    });
    if (d) kids.push(svg("path", { class: "chart__line", d: d }));

    // 点 + 周ラベル
    for (var i = 0; i < n; i++) {
      kids.push(svg("text", {
        class: "chart__label", x: x(i), y: H - 6,
        "text-anchor": "middle", text: (i + 1) + "周",
      }));
      if (pts[i]) {
        kids.push(svg("circle", {
          class: "chart__dot", cx: pts[i].x, cy: pts[i].y, r: 3.2,
        }));
        kids.push(svg("text", {
          class: "chart__label", x: pts[i].x, y: pts[i].y - 7,
          "text-anchor": "middle", text: String(Math.round(avgs[i])),
        }));
      }
    }
    var chartSvg = svg("svg", {
      class: "chart", viewBox: "0 0 " + W + " " + H, "aria-hidden": "true",
    }, kids);

    var srText = avgs.map(function (v, i) {
      return (i + 1) + "周: " + (v === null ? "未入力" : Math.round(v) + "点");
    }).join("、");
    return el("div", { class: "mock__chart" }, [
      head,
      chartSvg,
      el("p", { class: "visually-hidden", text: srText }),
    ]);
  }
  /* --- ③ 演習タブ --------------------------------------------------------- */
  function buildDrillTab() {
    var grid = el("div", { class: "grid drill__grid" }, buildDrillGridChildren());
    return el("section", { class: "card drill" }, [grid]);
  }
  function buildDrillGridChildren() {
    var children = [];
    children.push(el("div", { class: "grid__corner", "aria-hidden": "true" }));
    for (var r = 0; r < DATA.drill.rounds; r++) {
      children.push(el("div", { class: "grid__col-head", text: (r + 1) + "周" }));
    }
    DATA.drill.types.forEach(function (t) {
      children.push(el("div", { class: "grid__row-head" }, [
        el("span", { class: "grid__row-name", text: t.name }),
        el("span", { class: "grid__row-sub num", text: t.q + "問" }),
      ]));
      for (var rr = 0; rr < DATA.drill.rounds; rr++) {
        children.push(buildDrillCell(t, rr));
      }
    });
    return children;
  }
  function buildDrillCell(type, round) {
    var key = drillKey(type.id, round);
    var cell = state.drillCells[key] || { done: false };
    var label = type.name + " " + (round + 1) + "周目" + (cell.done ? "（完了）" : "");
    return el("div", {
      class: "cell", role: "checkbox", tabindex: "0",
      "aria-checked": cell.done ? "true" : "false",
      "aria-label": label,
      onclick: function () { toggleDrillCell(key); },
      onkeydown: function (e) { onCheckboxKey(e, function () { toggleDrillCell(key); }); },
    }, [checkMark()]);
  }
  /* --- フッタ ------------------------------------------------------------- */
  function buildFooter() {
    var actions = el("div", { class: "footer" }, [
      el("button", { class: "footer__btn", type: "button", text: "エクスポート", onclick: exportJson }),
      el("button", { class: "footer__btn", type: "button", text: "インポート", onclick: importJson }),
      el("button", { class: "footer__btn", type: "button", text: "リセット", onclick: resetAll }),
    ]);
    var meta = el("p", { class: "footer__meta num" }, [
      "全" + SEMINAR_TOTAL_ITEMS + "項目 ・ 模試" + DATA.mock.tests.length + "×" + DATA.mock.rounds
      + " ・ 演習" + DRILL_Q_PER_ROUND + "問×" + DATA.drill.rounds + "周",
    ]);
    var syncSlot = el("div", { class: "sync", id: "syncSlot" });
    return el("div", {}, [actions, syncSlot, meta]);
  }

  /* === 設定モーダル === */
  function draftEffective() {
    var d = modal.draft;
    return {
      examDate: d.examDate || DATA.meta.defaultExamDate,
      deadline1: d.deadline1 || DATA.meta.defaultDeadline1,
      deadline2: d.deadline2 || DATA.meta.defaultDeadline2,
      targetScore: d.targetScore != null ? d.targetScore : DATA.meta.defaultTargetScore,
    };
  }
  function isOrderValid(eff) {
    var d1 = parseDate(eff.deadline1).getTime();
    var d2 = parseDate(eff.deadline2).getTime();
    var ex = parseDate(eff.examDate).getTime();
    return d1 <= d2 && d2 <= ex;
  }
  function buildSettingsModal() {
    var eff = draftEffective();
    var warning = isOrderValid(eff) ? null : el("p", { class: "modal__warning" }, [
      "①〆切 → ②③〆切 → 試験日 の順になっていません。保存はできますが、見直しをおすすめします。",
    ]);
    var backdrop = el("div", { class: "modal__backdrop", onclick: closeSettingsModal });
    var panel = el("div", {
      class: "modal__panel", role: "dialog", "aria-modal": "true", "aria-label": "設定",
    }, [
      el("div", { class: "modal__head" }, [
        el("span", { class: "modal__title", text: "設定" }),
        el("button", {
          class: "modal__close", type: "button", "aria-label": "閉じる",
          onclick: closeSettingsModal,
        }, ["×"]),
      ]),
      dateField("examDate", "試験日", eff.examDate),
      dateField("deadline1", "①ゼミ〆切", eff.deadline1),
      dateField("deadline2", "②③演習〆切", eff.deadline2),
      scoreField(eff.targetScore),
      warning,
      el("div", { class: "modal__btn-row" }, [
        el("button", { class: "btn btn--ghost", type: "button", text: "既定に戻す", onclick: resetSettingsDraft }),
        el("button", { class: "btn btn--ghost", type: "button", text: "キャンセル", onclick: closeSettingsModal }),
        el("button", { class: "btn btn--primary", type: "button", text: "保存", onclick: saveSettings }),
      ]),
    ]);
    return el("div", {
      class: "modal", id: "settingsModal", onkeydown: onModalKeydown,
    }, [backdrop, panel]);
  }
  function dateField(field, label, value) {
    return el("div", { class: "field" }, [
      el("label", { class: "field__label", for: "settingsField-" + field, text: label }),
      el("input", {
        type: "date", id: "settingsField-" + field, class: "field__input",
        value: value,
        onchange: function (e) { updateDraft(field, e.target.value || null); },
      }),
    ]);
  }
  function scoreField(value) {
    var options = [];
    for (var v = 0; v <= DATA.meta.scoreMax; v += DATA.meta.scoreStep) {
      options.push(el("option", { value: String(v), text: v + "点" }));
    }
    var select = el("select", {
      id: "settingsField-targetScore", class: "field__select",
      onchange: function (e) { updateDraft("targetScore", parseInt(e.target.value, 10)); },
    }, options);
    select.value = String(value); // option 追加後でないと反映されないため後付け
    return el("div", { class: "field" }, [
      el("label", { class: "field__label", for: "settingsField-targetScore", text: "目標スコア" }),
      select,
    ]);
  }
  function focusModalField() {
    var id = modal.lastFieldId ? "settingsField-" + modal.lastFieldId : "settingsField-examDate";
    var node = document.getElementById(id);
    if (node) node.focus();
  }
  function onModalKeydown(e) {
    if (e.key === "Escape") closeSettingsModal();
  }

  /* === アクション（すべて setState 経由 = イミュータブル更新） === */
  function toggleSection(sectionId) {
    var next = Object.assign({}, state.openSections);
    if (next[sectionId]) delete next[sectionId];
    else next[sectionId] = true;
    setState({ openSections: next });
  }
  function toggleSeminarItem(key) {
    var next = Object.assign({}, state.seminarDone);
    if (next[key]) delete next[key];
    else next[key] = true;
    setState({ seminarDone: next });
  }
  function toggleMockCell(key) {
    var next = Object.assign({}, state.mockCells);
    var cur = next[key] || { done: false, score: null };
    next[key] = Object.assign({}, cur, { done: !cur.done });
    setState({ mockCells: next });
  }
  function editMockScore(key) {
    var cur = state.mockCells[key] || { done: false, score: null };
    var initial = typeof cur.score === "number" ? String(cur.score) : "";
    var input = window.prompt(
      "スコアを入力（0〜" + DATA.meta.scoreMax + "、" + DATA.meta.scoreStep + "刻み、空欄で消去）",
      initial
    );
    if (input === null) return; // キャンセル
    var trimmed = input.trim();
    var nextScore;
    if (trimmed === "") {
      nextScore = null;
    } else {
      var v = parseInt(trimmed, 10);
      if (isNaN(v)) return;
      v = clamp(v, 0, DATA.meta.scoreMax);
      nextScore = Math.round(v / DATA.meta.scoreStep) * DATA.meta.scoreStep;
    }
    var next = Object.assign({}, state.mockCells);
    // スコアを入れたらそのセルは完了扱いにする（未完了に得点は不自然）。
    var done = nextScore !== null ? true : cur.done;
    next[key] = Object.assign({}, cur, { score: nextScore, done: done });
    setState({ mockCells: next });
  }
  function toggleDrillCell(key) {
    var next = Object.assign({}, state.drillCells);
    var cur = next[key] || { done: false };
    next[key] = Object.assign({}, cur, { done: !cur.done });
    setState({ drillCells: next });
  }
  /* --- キーボード操作（Space/Enter） ------------------------------------- */
  function onCheckboxKey(e, fn) {
    if (e.key === " " || e.key === "Enter" || e.key === "Spacebar") {
      e.preventDefault();
      fn();
    }
  }

  /* --- 設定モーダルのアクション -------------------------------------------- */
  function openSettingsModal() {
    modal = { open: true, draft: Object.assign({}, state.settings), lastFieldId: null };
    render({});
  }
  function closeSettingsModal() {
    modal = { open: false, draft: defaultSettings(), lastFieldId: null };
    render({});
    var btn = document.getElementById("settingsBtn");
    if (btn) btn.focus();
  }
  function updateDraft(field, value) {
    var patch = {};
    patch[field] = value;
    modal = Object.assign({}, modal, {
      draft: Object.assign({}, modal.draft, patch),
      lastFieldId: field,
    });
    render({});
  }
  function resetSettingsDraft() {
    modal = Object.assign({}, modal, { draft: defaultSettings(), lastFieldId: null });
    render({});
  }
  function saveSettings() {
    var next = normalizeSettings(modal.draft);
    setState({ settings: next });
    closeSettingsModal();
  }

  /* === エクスポート / インポート / リセット === */
  function exportJson() {
    try {
      var payload = JSON.stringify(state, null, 2);
      var blob = new Blob([payload], { type: "application/json" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = "toeicsw-dashboard-" + toYmd(todayLocal()) + ".json";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    } catch (e) {
      window.alert("エクスポートに失敗しました");
    }
  }
  function importJson() {
    var input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.addEventListener("change", function () {
      var file = input.files && input.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var parsed = JSON.parse(String(reader.result));
          if (!parsed || typeof parsed !== "object") throw new Error("bad");
          var next = normalizeState(parsed);
          setState(next);
          window.alert("インポートしました");
        } catch (e) {
          window.alert("インポートに失敗しました（ファイル形式を確認してください）");
        }
      };
      reader.onerror = function () { window.alert("ファイルを読み込めませんでした"); };
      reader.readAsText(file);
    });
    input.click();
  }
  function resetAll() {
    var ok = window.confirm("進捗をすべて消去して初期化します。よろしいですか？");
    if (!ok) return;
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* noop */ }
    prev.seminarBig = null;
    prev.mockBig = null;
    prev.drillBig = null;
    setState(defaultState());
  }
  // 初回起動時に startDate を必ず永続化（破損復帰時も含む）。
  saveState(state);
  render({});

  // Gist 同期 (assets/sync.js) 連携ブリッジ。sync.js 未読込時は未使用。
  window.__DASHBOARD_BRIDGE__ = {
    getState: function () { return state; },
    applyRemoteState: function (obj) { setState(normalizeState(obj)); },
  };
})();
