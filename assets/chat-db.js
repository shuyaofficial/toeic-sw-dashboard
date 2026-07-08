/* ===========================================================================
   TOEIC Speaking AI解説チャット — chat-db.js
   IndexedDB ラッパ（DB名 toeicsw-dash-chat v1）。外部依存ゼロ・IIFE・非module。
   公開: window.ToeicSwChatDb
   =========================================================================== */
(function () {
  "use strict";

  var DB_NAME = "toeicsw-dash-chat";
  var DB_VERSION = 1;
  var STORE_SESSIONS = "sessions";
  var STORE_MESSAGES = "messages";
  var IDX_BY_SESSION = "bySession";

  var dbPromise = null;

  /* --- 内部ユーティリティ ------------------------------------------------- */

  function newId() {
    // 端末内一意で十分な軽量ID（衝突事実上なし）。
    return (
      Date.now().toString(36) +
      "-" +
      Math.random().toString(36).slice(2, 10)
    );
  }

  function friendlyError(where) {
    return "データの" + where + "に失敗しました。ブラウザの空き容量やプライベートモードをご確認ください。";
  }

  /* --- DB オープン --------------------------------------------------------- */

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) {
        reject(new Error(friendlyError("初期化")));
        return;
      }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
          db.createObjectStore(STORE_SESSIONS, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(STORE_MESSAGES)) {
          var ms = db.createObjectStore(STORE_MESSAGES, { keyPath: "id" });
          ms.createIndex(IDX_BY_SESSION, "sessionId", { unique: false });
        }
      };
      req.onsuccess = function () {
        resolve(req.result);
      };
      req.onerror = function () {
        reject(new Error(friendlyError("初期化")));
      };
    });
    return dbPromise;
  }

  function tx(db, stores, mode) {
    return db.transaction(stores, mode);
  }

  function reqAsPromise(request, errMsg) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () {
        resolve(request.result);
      };
      request.onerror = function () {
        reject(new Error(errMsg));
      };
    });
  }

  function txDone(transaction, errMsg) {
    return new Promise(function (resolve, reject) {
      transaction.oncomplete = function () {
        resolve();
      };
      transaction.onerror = function () {
        reject(new Error(errMsg));
      };
      transaction.onabort = function () {
        reject(new Error(errMsg));
      };
    });
  }

  /* --- sessions ----------------------------------------------------------- */

  async function listSessions() {
    try {
      var db = await openDb();
      var store = tx(db, [STORE_SESSIONS], "readonly").objectStore(STORE_SESSIONS);
      var all = await reqAsPromise(store.getAll(), friendlyError("読み込み"));
      // 新しい順（updatedAt 降順）
      return all
        .slice()
        .sort(function (a, b) {
          return (b.updatedAt || 0) - (a.updatedAt || 0);
        });
    } catch (e) {
      throw new Error(e && e.message ? e.message : friendlyError("読み込み"));
    }
  }

  async function createSession(title) {
    try {
      var db = await openDb();
      var now = Date.now();
      var session = {
        id: newId(),
        title: title && String(title).trim() ? String(title).trim() : "新しい質問",
        createdAt: now,
        updatedAt: now,
      };
      var t = tx(db, [STORE_SESSIONS], "readwrite");
      t.objectStore(STORE_SESSIONS).add(session);
      await txDone(t, friendlyError("保存"));
      return session;
    } catch (e) {
      throw new Error(e && e.message ? e.message : friendlyError("保存"));
    }
  }

  async function renameSession(sessionId, title) {
    try {
      var db = await openDb();
      var t = tx(db, [STORE_SESSIONS], "readwrite");
      var store = t.objectStore(STORE_SESSIONS);
      var session = await reqAsPromise(store.get(sessionId), friendlyError("更新"));
      if (!session) return null;
      var next = Object.assign({}, session, {
        title: title && String(title).trim() ? String(title).trim() : session.title,
        updatedAt: Date.now(),
      });
      store.put(next);
      await txDone(t, friendlyError("更新"));
      return next;
    } catch (e) {
      throw new Error(e && e.message ? e.message : friendlyError("更新"));
    }
  }

  async function touchSession(sessionId, patch) {
    // updatedAt を進め、任意で title 等を更新（内部用途、公開はしない）。
    var db = await openDb();
    var t = tx(db, [STORE_SESSIONS], "readwrite");
    var store = t.objectStore(STORE_SESSIONS);
    var session = await reqAsPromise(store.get(sessionId), friendlyError("更新"));
    if (!session) {
      await txDone(t, friendlyError("更新"));
      return null;
    }
    var next = Object.assign({}, session, patch || {}, { updatedAt: Date.now() });
    store.put(next);
    await txDone(t, friendlyError("更新"));
    return next;
  }

  async function deleteSession(sessionId) {
    try {
      var db = await openDb();
      var t = tx(db, [STORE_SESSIONS, STORE_MESSAGES], "readwrite");
      t.objectStore(STORE_SESSIONS).delete(sessionId);
      var idx = t.objectStore(STORE_MESSAGES).index(IDX_BY_SESSION);
      var keys = await reqAsPromise(
        idx.getAllKeys(IDBKeyRange.only(sessionId)),
        friendlyError("削除")
      );
      var msgStore = t.objectStore(STORE_MESSAGES);
      keys.forEach(function (k) {
        msgStore.delete(k);
      });
      await txDone(t, friendlyError("削除"));
      return true;
    } catch (e) {
      throw new Error(e && e.message ? e.message : friendlyError("削除"));
    }
  }

  /* --- messages ----------------------------------------------------------- */

  async function listMessages(sessionId) {
    try {
      var db = await openDb();
      var idx = tx(db, [STORE_MESSAGES], "readonly")
        .objectStore(STORE_MESSAGES)
        .index(IDX_BY_SESSION);
      var all = await reqAsPromise(
        idx.getAll(IDBKeyRange.only(sessionId)),
        friendlyError("読み込み")
      );
      return all.slice().sort(function (a, b) {
        return (a.ts || 0) - (b.ts || 0);
      });
    } catch (e) {
      throw new Error(e && e.message ? e.message : friendlyError("読み込み"));
    }
  }

  async function addMessage(msg) {
    try {
      var db = await openDb();
      var record = {
        id: newId(),
        sessionId: msg.sessionId,
        role: msg.role,
        text: typeof msg.text === "string" ? msg.text : "",
        images: Array.isArray(msg.images) ? msg.images.slice() : [], // Blob[]
        model: msg.model || null,
        backend: msg.backend || null,
        ts: typeof msg.ts === "number" ? msg.ts : Date.now(),
      };
      var t = tx(db, [STORE_MESSAGES], "readwrite");
      t.objectStore(STORE_MESSAGES).add(record);
      await txDone(t, friendlyError("保存"));
      // セッションの更新時刻を進める（別トランザクション）。
      try {
        await touchSession(msg.sessionId, {});
      } catch (e) {
        /* セッション更新失敗はメッセージ保存の成否に影響させない */
      }
      return record;
    } catch (e) {
      throw new Error(e && e.message ? e.message : friendlyError("保存"));
    }
  }

  /* --- export ------------------------------------------------------------- */

  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      try {
        var reader = new FileReader();
        reader.onload = function () {
          resolve(reader.result);
        };
        reader.onerror = function () {
          reject(new Error("画像の変換に失敗しました。"));
        };
        reader.readAsDataURL(blob);
      } catch (e) {
        reject(new Error("画像の変換に失敗しました。"));
      }
    });
  }

  function triggerDownload(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // 後始末（少し遅らせる）。
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1000);
  }

  async function exportSession(sessionId) {
    try {
      var db = await openDb();
      var sStore = tx(db, [STORE_SESSIONS], "readonly").objectStore(STORE_SESSIONS);
      var session = await reqAsPromise(sStore.get(sessionId), friendlyError("読み込み"));
      if (!session) {
        throw new Error("対象の会話が見つかりませんでした。");
      }
      var messages = await listMessages(sessionId);

      var exportedMessages = [];
      for (var i = 0; i < messages.length; i++) {
        var m = messages[i];
        var dataUrls = [];
        var imgs = Array.isArray(m.images) ? m.images : [];
        for (var j = 0; j < imgs.length; j++) {
          try {
            dataUrls.push(await blobToDataUrl(imgs[j]));
          } catch (e) {
            /* 1枚失敗しても他はエクスポートする */
          }
        }
        exportedMessages.push({
          role: m.role,
          text: m.text,
          images: dataUrls,
          model: m.model,
          backend: m.backend,
          ts: m.ts,
        });
      }

      var payload = {
        app: "toeicsw-chat",
        version: 1,
        exportedAt: new Date().toISOString(),
        session: {
          id: session.id,
          title: session.title,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
        },
        messages: exportedMessages,
      };

      var json = JSON.stringify(payload, null, 2);
      var blob = new Blob([json], { type: "application/json" });
      var safeTitle = String(session.title || "chat")
        .replace(/[\\/:*?"<>|]/g, "_")
        .slice(0, 24);
      triggerDownload(blob, "toeicsw-chat-" + safeTitle + ".json");
      return true;
    } catch (e) {
      throw new Error(e && e.message ? e.message : friendlyError("書き出し"));
    }
  }

  /* --- 公開 API ----------------------------------------------------------- */

  window.ToeicSwChatDb = {
    openDb: openDb,
    listSessions: listSessions,
    createSession: createSession,
    renameSession: renameSession,
    deleteSession: deleteSession,
    listMessages: listMessages,
    addMessage: addMessage,
    exportSession: exportSession,
    _blobToDataUrl: blobToDataUrl, // chat-app.js が送信用 dataURL 化に再利用
  };
})();
