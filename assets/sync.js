/* ===========================================================================
   TOEIC Speaking 学習管理ダッシュボード — sync.js
   GitHub Gist を介した任意のスマホ同期。未設定時は完全に無害（通信ゼロ）。
   非module IIFE。グローバル公開は window.GistSync のみ。
   依存: window.__DASHBOARD_BRIDGE__ (app.js が公開)、localStorage、fetch。
   =========================================================================== */
(function () {
  "use strict";

  var CONFIG = {
    app: "toeicsw-dashboard",
    gistFileName: "toeicsw-study.json",
    settingsKey: "toeicsw-sync-v1",
    gistMarker: "study-dashboard-sync-v1",
    mapFields: ["seminarDone", "mockCells", "drillCells"],
    localOnlyFields: ["activeTab", "openSections"],
    pushDebounceMs: 2500,
    pullThrottleMs: 30000,
  };

  var API_BASE = "https://api.github.com";

  /* --- 同期設定 (localStorage、アプリ state とは別キー) -------------------- */
  function defaultSettings() {
    return {
      token: "",
      gistId: "",
      localUpdatedAt: "",
      baseRemoteUpdatedAt: "",
      lastSyncAt: "",
      dirty: false,
    };
  }
  function loadSettings() {
    try {
      var raw = localStorage.getItem(CONFIG.settingsKey);
      if (!raw) return defaultSettings();
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return defaultSettings();
      return Object.assign(defaultSettings(), parsed);
    } catch (e) {
      return defaultSettings();
    }
  }
  function persistSettings() {
    try {
      localStorage.setItem(CONFIG.settingsKey, JSON.stringify(settings));
    } catch (e) {
      /* 保存不可でも同期は継続（次回起動で再入力が必要になる可能性あり） */
    }
  }
  // イミュータブルな settings 更新 + 永続化（app.js の setState と同じ方針）。
  function updateSettings(patch) {
    settings = Object.assign({}, settings, patch);
    persistSettings();
  }

  var settings = loadSettings();
  var applying = false;      // applyRemote 中の onLocalSave 抑制
  var syncing = false;
  var authInvalid = false;   // 401 後は再設定まで自動同期を止める
  var pushTimer = null;
  var lastPullAt = 0;
  var statusKind = "idle";   // idle | ok | error | syncing
  var statusText = "";

  // 設定フォーム（未接続時）の一時状態。永続化しない。
  var formOpen = false;
  var formFocused = false;
  var formError = "";
  var tokenDraft = "";
  var connecting = false;

  function bridge() { return window.__DASHBOARD_BRIDGE__; }
  function nowIso() { return new Date().toISOString(); }
  function safeParse(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  /* --- DOM ヘルパ（sync.js 専用の最小版。app.js の el() と同じ流儀） -------- */
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v == null || v === false) return;
        if (k === "text") { node.textContent = v; return; }
        if (k === "class") { node.setAttribute("class", v); return; }
        if (k === "onclick") { node.addEventListener("click", v); return; }
        if (k === "oninput") { node.addEventListener("input", v); return; }
        if (k === "onfocus") { node.addEventListener("focus", v); return; }
        if (k === "onblur") { node.addEventListener("blur", v); return; }
        if (k in node) {
          try { node[k] = v; return; } catch (e) { /* fall through */ }
        }
        node.setAttribute(k, v);
      });
    }
    if (children != null) {
      (Array.isArray(children) ? children : [children]).forEach(function (c) {
        if (c == null || c === false) return;
        node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
      });
    }
    return node;
  }

  /* === 公開 API === */
  function onLocalSave() {
    if (applying) return;
    updateSettings({ localUpdatedAt: nowIso(), dirty: true });
    refreshSlot();
    if (!settings.token || authInvalid) return;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(syncNow, CONFIG.pushDebounceMs);
  }
  function onRender() {
    refreshSlot();
  }
  window.GistSync = { onLocalSave: onLocalSave, onRender: onRender };

  /* --- GitHub Gist API ----------------------------------------------------- */
  function apiHeaders() {
    return {
      "Authorization": "Bearer " + settings.token,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }
  function apiRequest(url, method, body) {
    var headers = apiHeaders();
    var init = { method: method, headers: headers };
    if (body !== undefined) {
      init.headers = Object.assign({}, headers, { "Content-Type": "application/json" });
      init.body = JSON.stringify(body);
    }
    return fetch(url, init).then(function (res) {
      if (!res.ok) {
        var err = new Error("http_" + res.status);
        err.status = res.status;
        throw err;
      }
      if (res.status === 204) return null;
      return res.json();
    });
  }
  function buildPayload(stateObj, ts) {
    return {
      app: CONFIG.app,
      schemaVersion: 1,
      updatedAt: ts || nowIso(),
      state: stateObj,
    };
  }
  // description = マーカーの Gist を発見（自ファイル名を含むものを優先）。
  function discoverGist() {
    return apiRequest(API_BASE + "/gists?per_page=100", "GET").then(function (list) {
      var matches = (list || []).filter(function (g) {
        return g.description === CONFIG.gistMarker;
      });
      if (matches.length === 0) return null;
      var withFile = matches.filter(function (g) {
        return g.files && g.files[CONFIG.gistFileName];
      });
      var chosen = withFile.length > 0 ? withFile[0] : matches[0];
      // 一覧APIは content を含まないため、詳細を取り直す。
      return apiRequest(API_BASE + "/gists/" + chosen.id, "GET");
    });
  }
  function createGist() {
    var files = {};
    files[CONFIG.gistFileName] = {
      content: JSON.stringify(buildPayload(bridge().getState()), null, 2),
    };
    return apiRequest(API_BASE + "/gists", "POST", {
      description: CONFIG.gistMarker,
      public: false,
      files: files,
    });
  }
  function locateOrCreateGist() {
    return discoverGist().then(function (gist) {
      if (gist) {
        updateSettings({ gistId: gist.id });
        return gist;
      }
      return createGist().then(function (created) {
        updateSettings({ gistId: created.id });
        return created;
      });
    });
  }
  function obtainGist() {
    if (!settings.gistId) return locateOrCreateGist();
    return apiRequest(API_BASE + "/gists/" + settings.gistId, "GET")
      .then(function (gist) {
        return gist;
      })
      .catch(function (err) {
        if (err && err.status === 404) return locateOrCreateGist();
        throw err;
      });
  }
  function push(stateObj) {
    var ts = nowIso();
    var files = {};
    files[CONFIG.gistFileName] = { content: JSON.stringify(buildPayload(stateObj, ts), null, 2) };
    return apiRequest(API_BASE + "/gists/" + settings.gistId, "PATCH", { files: files })
      .then(function () {
        updateSettings({ baseRemoteUpdatedAt: ts, localUpdatedAt: ts, dirty: false });
      });
  }
  // キー単位の union マージ。mapFields はキーごと、それ以外はローカル優先。
  function mergeStates(local, remote) {
    var merged = Object.assign({}, remote, local);
    CONFIG.mapFields.forEach(function (f) {
      merged[f] = Object.assign({}, remote[f] || {}, local[f] || {});
    });
    return merged;
  }
  function applyRemote(obj) {
    var b = bridge();
    if (!b) return;
    applying = true;
    try {
      var cur = b.getState();
      var next = Object.assign({}, obj);
      CONFIG.localOnlyFields.forEach(function (f) { next[f] = cur[f]; });
      b.applyRemoteState(next);
    } finally {
      applying = false;
    }
  }
  function processGist(gist, manual) {
    var file = gist.files && gist.files[CONFIG.gistFileName];
    var remote = file && file.content ? safeParse(file.content) : null;
    if (remote && remote.updatedAt) {
      if (remote.updatedAt !== settings.baseRemoteUpdatedAt) {
        if (settings.dirty) {
          var merged = mergeStates(bridge().getState(), remote.state || {});
          applyRemote(merged);
          return push(merged);
        }
        applyRemote(remote.state || {});
        updateSettings({
          baseRemoteUpdatedAt: remote.updatedAt,
          localUpdatedAt: remote.updatedAt,
          dirty: false,
        });
        return;
      }
      if (settings.dirty) return push(bridge().getState());
      return;
    }
    if (!file) return push(bridge().getState());
    // リモートの内容が壊れている（parse不能 or updatedAt無し）。
    // 手動同期時のみ confirm でこの端末の内容による上書き復旧を許可する。
    if (manual && window.confirm("同期先のデータを読めません。この端末の内容で上書きしますか？")) {
      return push(bridge().getState());
    }
    var err = new Error("corrupt_remote");
    err.corrupt = true;
    throw err;
  }
  function handleSyncError(err) {
    if (err && err.corrupt) {
      statusKind = "error";
      statusText = "リモートデータを読めません";
      return;
    }
    if (err && err.status === 401) {
      authInvalid = true;
      statusKind = "error";
      statusText = "トークンが無効です";
      return;
    }
    statusKind = "error";
    statusText = "オフライン（未同期の変更あり）";
  }
  function syncNow(opts) {
    var manual = !!(opts && opts.manual);
    if (formOpen) return;
    if (syncing || !settings.token) return;
    if (!bridge()) return;
    syncing = true;
    statusKind = "syncing";
    refreshSlot();
    obtainGist()
      .then(function (gist) { return processGist(gist, manual); })
      .then(function () {
        updateSettings({ lastSyncAt: nowIso() });
        authInvalid = false;
        statusKind = "ok";
        statusText = "";
      })
      .catch(function (err) {
        handleSyncError(err);
      })
      .then(function () {
        syncing = false;
        refreshSlot();
      });
  }

  /* --- 設定フォームの操作 ---------------------------------------------------- */
  function openForm() {
    formOpen = true;
    formFocused = true;
    formError = "";
    tokenDraft = "";
    refreshSlot();
  }
  function closeForm() {
    formOpen = false;
    formFocused = false;
    formError = "";
    tokenDraft = "";
    refreshSlot();
  }
  function connect(rawToken) {
    var token = (rawToken || tokenDraft || "").trim();
    if (!token) {
      formError = "トークンを入力してください";
      refreshSlot();
      return;
    }
    connecting = true;
    formError = "";
    refreshSlot();
    var previous = settings;
    settings = Object.assign({}, defaultSettings(), { token: token });
    apiRequest(API_BASE + "/gists?per_page=100", "GET")
      .then(function () {
        // 初回接続時、ローカルに進捗があれば dirty を立てる。
        // dirty=false のままだと processGist の非dirty分岐で
        // リモート（他端末の空 state 等）に丸ごと上書きされ進捗が消えるため。
        var hasProgress = false;
        var b = bridge();
        if (b) {
          var st = b.getState();
          hasProgress = CONFIG.mapFields.some(function (f) {
            return st[f] && Object.keys(st[f]).length > 0;
          });
        }
        settings = Object.assign({}, settings, {
          dirty: hasProgress,
          localUpdatedAt: hasProgress ? nowIso() : "",
        });
        persistSettings();
        connecting = false;
        formOpen = false;
        formFocused = false;
        tokenDraft = "";
        authInvalid = false;
        refreshSlot();
        syncNow();
      })
      .catch(function (err) {
        settings = previous; // 未検証トークンは保存しない
        connecting = false;
        formError = (err && err.status === 401)
          ? "トークンを確認できませんでした"
          : "接続に失敗しました。ネットワークを確認してください";
        refreshSlot();
      });
  }
  function disconnect() {
    var ok = window.confirm("同期を解除してこの端末からトークンを削除しますか？（Gist 上のデータは残ります）");
    if (!ok) return;
    try { localStorage.removeItem(CONFIG.settingsKey); } catch (e) { /* noop */ }
    settings = defaultSettings();
    authInvalid = false;
    statusKind = "idle";
    statusText = "";
    if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
    refreshSlot();
  }

  /* --- フッタの同期スロット (#syncSlot) -------------------------------------- */
  // render() は毎回フルDOM再構築で消えるため onRender で復元し、
  // 状態更新は render を呼ばずスロットへの直接DOMパッチのみで行う。
  function statusLabel() {
    if (syncing) return "同期中…";
    if (statusKind === "error") return statusText || "同期エラー";
    if (settings.lastSyncAt) return "同期: 最終 " + formatTime(settings.lastSyncAt);
    return "同期: 未実行";
  }
  function formatTime(iso) {
    try {
      var d = new Date(iso);
      var hh = String(d.getHours()).padStart(2, "0");
      var mm = String(d.getMinutes()).padStart(2, "0");
      return hh + ":" + mm;
    } catch (e) {
      return "";
    }
  }
  function refreshSlot() {
    var slot = document.getElementById("syncSlot");
    if (!slot) return;
    // 再構築前に退避: slot.textContent="" が旧 input を除去すると同期的に
    // blur が発火して formFocused が false に落ちてしまうため。
    var wasFocused = formFocused;
    slot.textContent = "";
    if (formOpen) { renderForm(slot, wasFocused); return; }
    renderStatus(slot);
  }
  function renderForm(slot, wasFocused) {
    var input = el("input", {
      class: "sync__input", type: "password",
      placeholder: "GitHub トークン (classic / gist)",
      value: tokenDraft,
      oninput: function (e) { tokenDraft = e.target.value; },
      onfocus: function () { formFocused = true; },
      onblur: function () { formFocused = false; },
    });
    slot.appendChild(input);
    slot.appendChild(el("div", { class: "sync__actions" }, [
      el("button", {
        class: "footer__btn", type: "button",
        text: connecting ? "接続中…" : "接続", disabled: connecting,
        onclick: function () { connect(input.value); },
      }),
      el("button", {
        class: "footer__btn", type: "button", text: "キャンセル",
        disabled: connecting, onclick: closeForm,
      }),
    ]));
    slot.appendChild(el("p", {
      class: "sync__help",
      text: "classic トークン（gist スコープのみ）が必要です。Fine-grained トークンは Gist API 非対応です。",
    }));
    if (formError) {
      slot.appendChild(el("p", { class: "sync__error", text: formError }));
    }
    if (wasFocused) {
      input.focus();
      try {
        var len = input.value.length;
        input.setSelectionRange(len, len);
      } catch (e) { /* password 型で未対応のブラウザは無視 */ }
    }
  }
  function renderStatus(slot) {
    if (!settings.token) {
      slot.appendChild(el("span", { class: "sync__status", text: "Gist同期: 未設定" }));
      slot.appendChild(el("button", {
        class: "footer__btn", type: "button", text: "同期を設定", onclick: openForm,
      }));
      return;
    }
    slot.appendChild(el("span", {
      class: "sync__status" + (statusKind === "error" ? " sync__status--error" : ""),
      text: statusLabel(),
    }));
    slot.appendChild(el("button", {
      class: "footer__btn", type: "button", text: "今すぐ同期",
      disabled: syncing, onclick: function () { syncNow({ manual: true }); },
    }));
    slot.appendChild(el("button", {
      class: "footer__btn", type: "button", text: "解除",
      disabled: syncing, onclick: disconnect,
    }));
  }

  /* --- Pull トリガ (visibilitychange / focus、30秒スロットル) --------------- */
  function maybePull() {
    if (!settings.token || authInvalid || formOpen) return;
    var now = Date.now();
    if (now - lastPullAt < CONFIG.pullThrottleMs) return;
    lastPullAt = now;
    syncNow();
  }
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") maybePull();
  });
  window.addEventListener("focus", maybePull);

  // 離脱直前、未同期の変更を keepalive で投げ捨てる（取りこぼし対策）。
  window.addEventListener("pagehide", function () {
    if (!settings.dirty || !settings.token || !settings.gistId) return;
    var b = bridge();
    if (!b) return;
    var files = {};
    files[CONFIG.gistFileName] = {
      content: JSON.stringify(buildPayload(b.getState()), null, 2),
    };
    try {
      fetch(API_BASE + "/gists/" + settings.gistId, {
        method: "PATCH",
        headers: Object.assign({ "Content-Type": "application/json" }, apiHeaders()),
        body: JSON.stringify({ files: files }),
        keepalive: true,
      });
    } catch (e) { /* ベストエフォート送信。失敗しても致命的ではない */ }
  });

  /* --- 初期化 ---------------------------------------------------------------- */
  // data.js → app.js → sync.js の順に defer 読み込みされるため、
  // ここに到達した時点で app.js の render() は完了しブリッジも公開済み。
  if (bridge()) {
    refreshSlot();
    if (settings.token) syncNow();
  }
})();
