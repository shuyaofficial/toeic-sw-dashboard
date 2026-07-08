/* ===========================================================================
   TOEIC Speaking AI解説チャット — chat-app.js
   UI・状態管理。IIFE・非module。依存: ToeicSwChatDb / ToeicSwChatApi。
   公開: window.ToeicSwChatApp（起動のみ）
   =========================================================================== */
(function () {
  "use strict";

  var Db = window.ToeicSwChatDb;
  var Api = window.ToeicSwChatApi;
  var Render = window.ToeicSwChatRender;

  var SETTINGS_KEY = "toeicsw-dash-chat-settings-v1";
  var DEFAULT_MODEL = (Api && Api.DEFAULT_MODEL) || "claude-opus-4-8";
  var HISTORY_LIMIT = 8; // 直近メッセージ数（画像含む）

  /* --- イミュータブルな状態 ---------------------------------------------- */
  var state = {
    backend: "byok", // "bridge" | "byok"
    settings: { apiKey: "", model: DEFAULT_MODEL },
    currentSessionId: null,
    sessions: [], // {id,title,createdAt,updatedAt}
    messages: [], // 表示用: {id?,role,text,images:[{blob,url}],model,backend,ts,error?,pending?}
    attachments: [], // 送信前の添付: {blob,url}
    sending: false,
  };

  function setState(patch) {
    state = Object.assign({}, state, patch);
  }

  /* --- DOM 参照 ----------------------------------------------------------- */
  var els = {};

  function $(id) {
    return document.getElementById(id);
  }

  /* --- 設定（localStorage） ---------------------------------------------- */

  function loadSettings() {
    try {
      var raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return { apiKey: "", model: DEFAULT_MODEL };
      var parsed = JSON.parse(raw);
      return {
        apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : "",
        model: typeof parsed.model === "string" && parsed.model ? parsed.model : DEFAULT_MODEL,
      };
    } catch (e) {
      return { apiKey: "", model: DEFAULT_MODEL };
    }
  }

  function saveSettings(next) {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      return true;
    } catch (e) {
      return false;
    }
  }

  function maskKey(key) {
    if (!key) return "未設定";
    if (key.length <= 7) return key.slice(0, 3) + "…";
    return key.slice(0, 7) + "…";
  }

  /* --- 画像処理ヘルパ ----------------------------------------------------- */

  function blobToUrl(blob) {
    return URL.createObjectURL(blob);
  }

  /* --- 添付管理 ----------------------------------------------------------- */

  async function addFiles(fileList) {
    var files = Array.prototype.slice.call(fileList).filter(function (f) {
      return f && /^image\//.test(f.type);
    });
    if (files.length === 0) return;
    var added = [];
    for (var i = 0; i < files.length; i++) {
      try {
        var blob = await Render.resizeToJpegBlob(files[i]);
        added.push({ blob: blob, url: blobToUrl(blob) });
      } catch (e) {
        /* 1枚失敗しても続行 */
      }
    }
    if (added.length) {
      setState({ attachments: state.attachments.concat(added) });
      renderAttachments();
    }
  }

  function removeAttachment(index) {
    var next = state.attachments.slice();
    var removed = next.splice(index, 1)[0];
    if (removed) URL.revokeObjectURL(removed.url);
    setState({ attachments: next });
    renderAttachments();
  }

  function clearAttachments() {
    state.attachments.forEach(function (a) {
      URL.revokeObjectURL(a.url);
    });
    setState({ attachments: [] });
    renderAttachments();
  }

  /* --- レンダリング: 添付プレビュー -------------------------------------- */

  function renderAttachments() {
    var wrap = els.attachPreview;
    wrap.textContent = "";
    if (state.attachments.length === 0) {
      wrap.hidden = true;
      return;
    }
    wrap.hidden = false;
    state.attachments.forEach(function (att, index) {
      var item = document.createElement("div");
      item.className = "attach-thumb";
      var img = document.createElement("img");
      img.src = att.url; // blob: URL（信頼できる）
      img.alt = "添付画像";
      item.appendChild(img);
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "attach-thumb__remove";
      btn.setAttribute("aria-label", "添付を削除");
      btn.textContent = "×";
      btn.addEventListener("click", function () {
        removeAttachment(index);
      });
      item.appendChild(btn);
      wrap.appendChild(item);
    });
  }

  /* --- レンダリング: 接続バッジ ------------------------------------------ */

  function renderBadge() {
    var badge = els.badge;
    badge.className = "conn-badge";
    var label = "";
    if (state.backend === "bridge") {
      badge.classList.add("conn-badge--bridge");
      label = "ローカル・無料";
    } else if (!state.settings.apiKey) {
      badge.classList.add("conn-badge--nokey");
      label = "キー未設定";
    } else {
      badge.classList.add("conn-badge--byok");
      label = "API";
    }
    var dot = document.createElement("span");
    dot.className = "conn-badge__dot";
    badge.textContent = "";
    badge.appendChild(dot);
    badge.appendChild(document.createTextNode(label));
  }

  /* --- レンダリング: スレッド全体 ---------------------------------------- */

  var messageHandlers = {
    onOpenImage: function (url) {
      openOverlay(url);
    },
    onRetry: function () {
      retryLast();
    },
  };

  function renderThread() {
    var thread = els.thread;
    thread.textContent = "";
    if (state.messages.length === 0) {
      thread.appendChild(Render.buildEmptyState());
      return;
    }
    state.messages.forEach(function (msg) {
      thread.appendChild(Render.buildMessageEl(msg, messageHandlers));
    });
    scrollToBottom();
  }

  function scrollToBottom() {
    var thread = els.thread;
    // レイアウト確定後にスクロール。
    requestAnimationFrame(function () {
      thread.scrollTop = thread.scrollHeight;
    });
  }

  /* --- 原寸オーバーレイ --------------------------------------------------- */

  function openOverlay(url) {
    var overlay = els.overlay;
    overlay.textContent = "";
    var img = document.createElement("img");
    img.src = url;
    img.alt = "拡大画像";
    overlay.appendChild(img);
    toggleLayer(overlay, true);
  }

  function closeOverlay() {
    toggleLayer(els.overlay, false);
    els.overlay.textContent = "";
  }

  /* --- セッション操作 ----------------------------------------------------- */

  async function refreshSessions() {
    try {
      var sessions = await Db.listSessions();
      setState({ sessions: sessions });
      renderHistoryList();
    } catch (e) {
      showToast(e.message || "履歴を読み込めませんでした。");
    }
  }

  async function loadSession(sessionId) {
    try {
      var records = await Db.listMessages(sessionId);
      var messages = records.map(function (r) {
        var images = (r.images || []).map(function (blob) {
          return { blob: blob, url: blobToUrl(blob) };
        });
        return {
          id: r.id,
          role: r.role,
          text: r.text,
          images: images,
          model: r.model,
          backend: r.backend,
          ts: r.ts,
        };
      });
      revokeMessageUrls(state.messages);
      setState({ currentSessionId: sessionId, messages: messages });
      renderThread();
      closeHistory();
    } catch (e) {
      showToast(e.message || "会話を読み込めませんでした。");
    }
  }

  function revokeMessageUrls(messages) {
    messages.forEach(function (m) {
      (m.images || []).forEach(function (im) {
        if (im.url) URL.revokeObjectURL(im.url);
      });
    });
  }

  function startNewChat() {
    revokeMessageUrls(state.messages);
    clearAttachments();
    setState({ currentSessionId: null, messages: [] });
    renderThread();
    closeHistory();
    els.input.focus();
  }

  async function deleteSessionUi(sessionId) {
    if (!window.confirm("この会話を削除します。よろしいですか？")) return;
    try {
      await Db.deleteSession(sessionId);
      if (state.currentSessionId === sessionId) {
        startNewChat();
      }
      await refreshSessions();
    } catch (e) {
      showToast(e.message || "削除に失敗しました。");
    }
  }

  async function exportSessionUi(sessionId) {
    try {
      await Db.exportSession(sessionId);
    } catch (e) {
      showToast(e.message || "書き出しに失敗しました。");
    }
  }

  /* --- 履歴リスト描画 ----------------------------------------------------- */

  var historyHandlers = {
    onOpen: function (id) {
      loadSession(id);
    },
    onExport: function (id) {
      exportSessionUi(id);
    },
    onDelete: function (id) {
      deleteSessionUi(id);
    },
  };

  function renderHistoryList() {
    els.historyList.textContent = "";
    els.historyList.appendChild(
      Render.buildHistoryList(state.sessions, state.currentSessionId, historyHandlers)
    );
  }

  /* --- シート/モーダル 開閉 ---------------------------------------------- */

  // 表示レイヤ（hidden + .is-open）の共通トグル。
  function toggleLayer(el, open) {
    el.hidden = !open;
    el.classList.toggle("is-open", open);
  }

  function openHistory() {
    refreshSessions();
    toggleLayer(els.historySheet, true);
  }
  function closeHistory() {
    toggleLayer(els.historySheet, false);
  }

  function openSettings() {
    els.modelSelect.value = state.settings.model || DEFAULT_MODEL;
    els.keyInput.value = "";
    els.keyMask.textContent = "現在: " + maskKey(state.settings.apiKey);
    els.backendMode.textContent =
      state.backend === "bridge" ? "ローカル・無料モード（自動検出）" : "APIモード（BYOK）";
    toggleLayer(els.settingsModal, true);
  }
  function closeSettings() {
    toggleLayer(els.settingsModal, false);
  }

  /* --- トースト ----------------------------------------------------------- */

  var toastTimer = null;
  function showToast(text) {
    var t = els.toast;
    t.textContent = text;
    t.classList.add("is-visible");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      t.classList.remove("is-visible");
    }, 3200);
  }

  /* --- 送信フロー --------------------------------------------------------- */

  function sanitizeTitle(text) {
    var t = (text || "").trim().replace(/\s+/g, " ");
    if (!t) return "新しい質問";
    return t.slice(0, 20);
  }

  async function ensureSession(firstText) {
    if (state.currentSessionId) return state.currentSessionId;
    var session = await Db.createSession(sanitizeTitle(firstText));
    setState({ currentSessionId: session.id });
    await refreshSessions();
    return session.id;
  }

  function buildApiMessages() {
    // 直近 HISTORY_LIMIT 件。画像は dataURL 化して渡す。
    var recent = state.messages.slice(-HISTORY_LIMIT);
    var out = [];
    for (var i = 0; i < recent.length; i++) {
      var m = recent[i];
      out.push({ role: m.role, text: m.text || "", images: m.__dataUrls || [] });
    }
    return out;
  }

  async function toDataUrls(images) {
    var urls = [];
    for (var i = 0; i < images.length; i++) {
      try {
        urls.push(await Db._blobToDataUrl(images[i].blob));
      } catch (e) {
        /* 変換失敗はスキップ */
      }
    }
    return urls;
  }

  async function handleSend() {
    if (state.sending) return;
    var text = els.input.value.trim();
    var attachments = state.attachments.slice();
    if (!text && attachments.length === 0) return;

    setState({ sending: true });
    els.sendBtn.disabled = true;

    try {
      var sessionId = await ensureSession(text);

      // 添付を dataURL 化（送信用）。
      var userDataUrls = await toDataUrls(attachments);

      // user メッセージ DB 保存（images は Blob）。
      var userImagesBlobs = attachments.map(function (a) {
        return a.blob;
      });
      var savedUser = await Db.addMessage({
        sessionId: sessionId,
        role: "user",
        text: text,
        images: userImagesBlobs,
        model: null,
        backend: state.backend,
      });

      // 表示用 user メッセージ（添付の url を引き継ぐ）。
      var userMsg = {
        id: savedUser.id,
        role: "user",
        text: text,
        images: attachments.map(function (a) {
          return { blob: a.blob, url: a.url };
        }),
        __dataUrls: userDataUrls,
        model: null,
        backend: state.backend,
        ts: savedUser.ts,
      };

      // 添付リストは所有権をメッセージに移すのでクリア（URL は revoke しない）。
      setState({ attachments: [] });
      renderAttachments();
      els.input.value = "";
      autoGrow();

      // pending の assistant バブル。
      var pendingAssistant = {
        role: "assistant",
        text: "",
        images: [],
        model: state.backend === "byok" ? state.settings.model : null,
        backend: state.backend,
        ts: Date.now(),
        pending: true,
      };

      setState({ messages: state.messages.concat([userMsg, pendingAssistant]) });
      renderThread();

      await streamAssistant(sessionId, pendingAssistant);
    } catch (e) {
      showToast(e.message || "送信に失敗しました。");
    } finally {
      setState({ sending: false });
      els.sendBtn.disabled = false;
    }
  }

  function updateAssistantBubble(updater) {
    var messages = state.messages.slice();
    var lastIndex = -1;
    for (var i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") {
        lastIndex = i;
        break;
      }
    }
    if (lastIndex < 0) return;
    messages[lastIndex] = updater(messages[lastIndex]);
    setState({ messages: messages });
  }

  function streamAssistant(sessionId, pendingAssistant) {
    var accumulated = "";
    var apiMessages = buildApiMessages();

    return new Promise(function (resolve) {
      Api.send({
        backend: state.backend,
        apiKey: state.settings.apiKey,
        model: state.settings.model,
        system: Api.SYSTEM_PROMPT,
        messages: apiMessages,
        onDelta: function (delta) {
          accumulated += delta;
          updateAssistantBubble(function (m) {
            return Object.assign({}, m, { text: accumulated, pending: false });
          });
          renderThread();
        },
        onDone: async function (full) {
          var finalText = full || accumulated;
          updateAssistantBubble(function (m) {
            return Object.assign({}, m, { text: finalText, pending: false });
          });
          renderThread();
          try {
            await Db.addMessage({
              sessionId: sessionId,
              role: "assistant",
              text: finalText,
              images: [],
              model: pendingAssistant.model,
              backend: state.backend,
            });
            await refreshSessions();
          } catch (e) {
            showToast(e.message || "応答の保存に失敗しました。");
          }
          resolve();
        },
        onError: function (err) {
          updateAssistantBubble(function (m) {
            return Object.assign({}, m, {
              pending: false,
              error: err && err.message ? err.message : "エラーが発生しました。",
            });
          });
          renderThread();
          resolve();
        },
      });
    });
  }

  async function retryLast() {
    // 末尾の assistant（エラー）を取り除いて再送信。直前 user は保持。
    var messages = state.messages.slice();
    if (messages.length === 0) return;
    var last = messages[messages.length - 1];
    if (last.role !== "assistant") return;
    messages.pop();

    var pendingAssistant = {
      role: "assistant",
      text: "",
      images: [],
      model: state.backend === "byok" ? state.settings.model : null,
      backend: state.backend,
      ts: Date.now(),
      pending: true,
    };
    setState({ messages: messages.concat([pendingAssistant]), sending: true });
    els.sendBtn.disabled = true;
    renderThread();
    try {
      var sessionId = state.currentSessionId;
      if (sessionId) await streamAssistant(sessionId, pendingAssistant);
    } finally {
      setState({ sending: false });
      els.sendBtn.disabled = false;
    }
  }

  /* --- コンポーザ: textarea 自動高さ ------------------------------------- */

  function autoGrow() {
    var ta = els.input;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 180) + "px";
  }

  /* --- 設定保存/削除 ------------------------------------------------------ */

  function applyModelChange() {
    var next = Object.assign({}, state.settings, { model: els.modelSelect.value });
    setState({ settings: next });
    saveSettings(next);
    renderBadge();
  }

  function saveKey() {
    var key = els.keyInput.value.trim();
    if (!key) {
      showToast("APIキーを入力してください。");
      return;
    }
    var next = Object.assign({}, state.settings, { apiKey: key });
    setState({ settings: next });
    var ok = saveSettings(next);
    els.keyInput.value = "";
    els.keyMask.textContent = "現在: " + maskKey(next.apiKey);
    renderBadge();
    showToast(ok ? "APIキーを保存しました。" : "保存に失敗しました。");
  }

  function deleteKey() {
    var next = Object.assign({}, state.settings, { apiKey: "" });
    setState({ settings: next });
    saveSettings(next);
    els.keyInput.value = "";
    els.keyMask.textContent = "現在: 未設定";
    renderBadge();
    showToast("APIキーを削除しました。");
  }

  async function redetect() {
    els.backendMode.textContent = "検出中…";
    var backend = await Api.detectBackend();
    setState({ backend: backend });
    els.backendMode.textContent =
      backend === "bridge" ? "ローカル・無料モード（自動検出）" : "APIモード（BYOK）";
    renderBadge();
  }

  /* --- イベント結線 ------------------------------------------------------- */

  function bindEvents() {
    els.sendBtn.addEventListener("click", handleSend);

    els.input.addEventListener("input", autoGrow);
    els.input.addEventListener("keydown", function (e) {
      // Enter=送信 / Shift+Enter=改行（デスクトップ）。
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        handleSend();
      }
    });

    els.imageBtn.addEventListener("click", function () {
      els.fileInput.click();
    });
    els.fileInput.addEventListener("change", function () {
      addFiles(els.fileInput.files);
      els.fileInput.value = "";
    });

    // クリップボードペースト
    document.addEventListener("paste", function (e) {
      if (!e.clipboardData) return;
      var items = e.clipboardData.items || [];
      var files = [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].kind === "file" && /^image\//.test(items[i].type)) {
          var f = items[i].getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length) {
        e.preventDefault();
        addFiles(files);
      }
    });

    // ドラッグ&ドロップ
    var dropZone = els.composer;
    ["dragenter", "dragover"].forEach(function (ev) {
      dropZone.addEventListener(ev, function (e) {
        e.preventDefault();
        dropZone.classList.add("is-dragover");
      });
    });
    ["dragleave", "drop"].forEach(function (ev) {
      dropZone.addEventListener(ev, function (e) {
        e.preventDefault();
        dropZone.classList.remove("is-dragover");
      });
    });
    dropZone.addEventListener("drop", function (e) {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        addFiles(e.dataTransfer.files);
      }
    });

    // ヘッダボタン
    els.historyBtn.addEventListener("click", openHistory);
    els.newBtn.addEventListener("click", startNewChat);
    els.settingsBtn.addEventListener("click", openSettings);
    els.badge.addEventListener("click", function () {
      if (state.backend !== "bridge") openSettings();
    });

    // シート/モーダル 閉じる
    els.historyClose.addEventListener("click", closeHistory);
    els.historyBackdrop.addEventListener("click", closeHistory);
    els.settingsClose.addEventListener("click", closeSettings);
    els.settingsBackdrop.addEventListener("click", closeSettings);

    // 設定操作
    els.modelSelect.addEventListener("change", applyModelChange);
    els.saveKeyBtn.addEventListener("click", saveKey);
    els.deleteKeyBtn.addEventListener("click", deleteKey);
    els.redetectBtn.addEventListener("click", redetect);

    // オーバーレイ
    els.overlay.addEventListener("click", closeOverlay);

    // Esc で各オーバーレイを閉じる
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        if (els.overlay.classList.contains("is-open")) closeOverlay();
        else if (els.settingsModal.classList.contains("is-open")) closeSettings();
        else if (els.historySheet.classList.contains("is-open")) closeHistory();
      }
    });
  }

  /* --- 起動 --------------------------------------------------------------- */

  function cacheEls() {
    els = {
      badge: $("connBadge"),
      historyBtn: $("historyBtn"),
      newBtn: $("newBtn"),
      settingsBtn: $("settingsBtn"),
      thread: $("thread"),
      composer: $("composer"),
      input: $("composerInput"),
      imageBtn: $("imageBtn"),
      fileInput: $("fileInput"),
      sendBtn: $("sendBtn"),
      attachPreview: $("attachPreview"),
      historySheet: $("historySheet"),
      historyBackdrop: $("historyBackdrop"),
      historyList: $("historyList"),
      historyClose: $("historyClose"),
      settingsModal: $("settingsModal"),
      settingsBackdrop: $("settingsBackdrop"),
      settingsClose: $("settingsClose"),
      backendMode: $("backendMode"),
      redetectBtn: $("redetectBtn"),
      keyInput: $("keyInput"),
      keyMask: $("keyMask"),
      saveKeyBtn: $("saveKeyBtn"),
      deleteKeyBtn: $("deleteKeyBtn"),
      modelSelect: $("modelSelect"),
      overlay: $("imageOverlay"),
      toast: $("toast"),
    };
  }

  async function init() {
    if (!Db || !Api || !Render) {
      document.body.textContent = "チャットの初期化に失敗しました。スクリプトの読み込みをご確認ください。";
      return;
    }
    cacheEls();
    setState({ settings: loadSettings() });
    els.modelSelect.value = state.settings.model || DEFAULT_MODEL;
    bindEvents();
    renderThread();
    renderAttachments();

    // バックエンド自動判定。
    try {
      var backend = await Api.detectBackend();
      setState({ backend: backend });
    } catch (e) {
      setState({ backend: "byok" });
    }
    renderBadge();

    // 履歴を先読み（DB 準備確認も兼ねる）。
    try {
      await Db.openDb();
      await refreshSessions();
    } catch (e) {
      showToast(e.message || "履歴機能を利用できません。");
    }

    els.input.focus();
  }

  window.ToeicSwChatApp = { init: init };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
