/* ===========================================================================
   TOEIC Speaking AI解説チャット — chat-render.js
   純粋な表示レイヤ（状態を持たない）。エスケープ・最小Markdown・DOM組み立て。
   IIFE・非module。公開: window.ToeicSwChatRender
   XSS対策: assistant応答は「全文エスケープ→限定タグのみ自前変換」する。
   =========================================================================== */
(function () {
  "use strict";

  /* --- エスケープ & 最小 Markdown レンダラ -------------------------------- */

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // インライン: `code` と **bold**。入力は「エスケープ済み文字列」であること。
  function renderInline(escaped) {
    var parts = escaped.split("`");
    var out = "";
    for (var i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        out += '<code class="chat-md-code">' + parts[i] + "</code>";
      } else {
        out += parts[i].replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      }
    }
    return out;
  }

  // 全文をエスケープ→限定的に ## / **bold** / - リスト / `code` のみ変換。
  function renderMarkdown(text) {
    var escaped = escapeHtml(text || "");
    var lines = escaped.split("\n");
    var html = "";
    var inList = false;

    function closeList() {
      if (inList) {
        html += "</ul>";
        inList = false;
      }
    }

    for (var i = 0; i < lines.length; i++) {
      var trimmed = lines[i].replace(/\s+$/, "");

      var hMatch = /^(#{1,3})\s+(.*)$/.exec(trimmed);
      if (hMatch) {
        closeList();
        var tag = hMatch[1].length >= 2 ? "h4" : "h3";
        html += "<" + tag + ' class="chat-md-h">' + renderInline(hMatch[2]) + "</" + tag + ">";
        continue;
      }

      var lMatch = /^\s*[-*]\s+(.*)$/.exec(trimmed);
      if (lMatch) {
        if (!inList) {
          html += '<ul class="chat-md-ul">';
          inList = true;
        }
        html += "<li>" + renderInline(lMatch[1]) + "</li>";
        continue;
      }

      closeList();
      if (trimmed.length === 0) continue;
      html += '<p class="chat-md-p">' + renderInline(trimmed) + "</p>";
    }
    closeList();
    return html;
  }

  /* --- DOM 組み立て（状態を持たない部品） -------------------------------- */

  function buildImageThumb(url, onOpen) {
    var img = document.createElement("img");
    img.className = "msg-image";
    img.src = url; // blob: or data:（信頼できる）
    img.alt = "添付画像";
    img.addEventListener("click", function () {
      if (typeof onOpen === "function") onOpen(url);
    });
    return img;
  }

  function buildSpinner(isBridge) {
    var wrap = document.createElement("div");
    wrap.className = "spinner-row";
    var sp = document.createElement("span");
    sp.className = "spinner";
    sp.setAttribute("aria-hidden", "true");
    wrap.appendChild(sp);
    var label = document.createElement("span");
    label.className = "spinner-label";
    label.textContent = isBridge ? "ローカルで生成中…" : "生成中…";
    wrap.appendChild(label);
    return wrap;
  }

  function buildEmptyState() {
    var wrap = document.createElement("div");
    wrap.className = "empty-state";
    var title = document.createElement("p");
    title.className = "empty-state__title";
    title.textContent = "問題のスクリーンショットを貼り付けるか、質問を入力してください";
    wrap.appendChild(title);
    var hint = document.createElement("p");
    hint.className = "empty-state__hint";
    hint.textContent = "画像はペースト（⌘V）・ドラッグ＆ドロップ・添付ボタンで追加できます。";
    wrap.appendChild(hint);
    return wrap;
  }

  // handlers: { onOpenImage(url), onRetry() }
  function buildMessageEl(msg, handlers) {
    handlers = handlers || {};
    var isUser = msg.role === "user";
    var row = document.createElement("div");
    row.className = "msg msg--" + (isUser ? "user" : "assistant");

    var bubble = document.createElement("div");
    bubble.className = "bubble bubble--" + (isUser ? "user" : "assistant");

    if (msg.images && msg.images.length) {
      var imgWrap = document.createElement("div");
      imgWrap.className = "msg-images";
      msg.images.forEach(function (im) {
        imgWrap.appendChild(buildImageThumb(im.url, handlers.onOpenImage));
      });
      bubble.appendChild(imgWrap);
    }

    var body = document.createElement("div");
    body.className = "bubble__body";
    if (isUser) {
      body.textContent = msg.text || ""; // プレーンテキスト（安全）
    } else if (msg.pending && !msg.text) {
      body.appendChild(buildSpinner(msg.backend === "bridge"));
    } else {
      // XSS対策: renderMarkdown は全文エスケープ済みHTMLのみ返す。
      body.innerHTML = renderMarkdown(msg.text || "");
    }
    bubble.appendChild(body);

    if (msg.error) {
      var err = document.createElement("div");
      err.className = "bubble__error";
      err.textContent = msg.error;
      bubble.appendChild(err);
      var retry = document.createElement("button");
      retry.type = "button";
      retry.className = "bubble__retry";
      retry.textContent = "再試行";
      retry.addEventListener("click", function () {
        if (typeof handlers.onRetry === "function") handlers.onRetry();
      });
      bubble.appendChild(retry);
    }

    row.appendChild(bubble);
    return row;
  }

  /* --- 履歴リスト（状態を持たない部品） --------------------------------- */

  function formatDate(ts) {
    try {
      var d = new Date(ts);
      var mm = ("0" + (d.getMonth() + 1)).slice(-2);
      var dd = ("0" + d.getDate()).slice(-2);
      return d.getFullYear() + "/" + mm + "/" + dd;
    } catch (e) {
      return "";
    }
  }

  function buildIconButton(className, label, glyph, onClick) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = className;
    btn.setAttribute("aria-label", label);
    btn.textContent = glyph;
    btn.addEventListener("click", function (ev) {
      ev.stopPropagation();
      if (typeof onClick === "function") onClick();
    });
    return btn;
  }

  // handlers: { onOpen(id), onExport(id), onDelete(id) }
  function buildHistoryList(sessions, currentSessionId, handlers) {
    handlers = handlers || {};
    var frag = document.createDocumentFragment();
    if (!sessions || sessions.length === 0) {
      var empty = document.createElement("p");
      empty.className = "history__empty";
      empty.textContent = "まだ会話はありません。";
      frag.appendChild(empty);
      return frag;
    }
    sessions.forEach(function (s) {
      var row = document.createElement("div");
      row.className = "history-row";
      if (s.id === currentSessionId) row.classList.add("is-active");

      var main = document.createElement("button");
      main.type = "button";
      main.className = "history-row__main";
      var title = document.createElement("span");
      title.className = "history-row__title";
      title.textContent = s.title || "新しい質問";
      var date = document.createElement("span");
      date.className = "history-row__date num";
      date.textContent = formatDate(s.updatedAt || s.createdAt);
      main.appendChild(title);
      main.appendChild(date);
      main.addEventListener("click", function () {
        if (typeof handlers.onOpen === "function") handlers.onOpen(s.id);
      });
      row.appendChild(main);

      row.appendChild(
        buildIconButton("history-row__icon", "この会話をエクスポート", "⤓", function () {
          if (typeof handlers.onExport === "function") handlers.onExport(s.id);
        })
      );
      row.appendChild(
        buildIconButton(
          "history-row__icon history-row__icon--danger",
          "この会話を削除",
          "🗑",
          function () {
            if (typeof handlers.onDelete === "function") handlers.onDelete(s.id);
          }
        )
      );
      frag.appendChild(row);
    });
    return frag;
  }

  /* --- 画像処理（縮小 → JPEG Blob） -------------------------------------- */

  var MAX_LONG_EDGE = 1568;
  var JPEG_QUALITY = 0.85;

  function fileToImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        resolve({ img: img, url: url });
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error("画像を読み込めませんでした。"));
      };
      img.src = url;
    });
  }

  function resizeToJpegBlob(file) {
    return fileToImage(file).then(function (loaded) {
      var img = loaded.img;
      var w = img.naturalWidth || img.width;
      var h = img.naturalHeight || img.height;
      var longEdge = Math.max(w, h);
      var scale = longEdge > MAX_LONG_EDGE ? MAX_LONG_EDGE / longEdge : 1;
      var tw = Math.max(1, Math.round(w * scale));
      var th = Math.max(1, Math.round(h * scale));
      var canvas = document.createElement("canvas");
      canvas.width = tw;
      canvas.height = th;
      canvas.getContext("2d").drawImage(img, 0, 0, tw, th);
      URL.revokeObjectURL(loaded.url);
      return new Promise(function (resolve, reject) {
        canvas.toBlob(
          function (blob) {
            if (blob) resolve(blob);
            else reject(new Error("画像の変換に失敗しました。"));
          },
          "image/jpeg",
          JPEG_QUALITY
        );
      });
    });
  }

  /* --- 公開 API ----------------------------------------------------------- */

  window.ToeicSwChatRender = {
    escapeHtml: escapeHtml,
    renderMarkdown: renderMarkdown,
    buildMessageEl: buildMessageEl,
    buildEmptyState: buildEmptyState,
    buildHistoryList: buildHistoryList,
    resizeToJpegBlob: resizeToJpegBlob,
  };
})();
