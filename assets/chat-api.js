/* ===========================================================================
   TOEIC Speaking AI解説チャット — chat-api.js
   バックエンド抽象化（ローカルブリッジ / BYOK: Anthropic API）。
   外部通信は Anthropic API（BYOK時）と 127.0.0.1:8977（ブリッジ）のみ。
   IIFE・非module。公開: window.ToeicSwChatApi
   =========================================================================== */
(function () {
  "use strict";

  var BRIDGE_ORIGIN = "http://127.0.0.1:8977";
  var ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
  var ANTHROPIC_VERSION = "2023-06-01";
  var DEFAULT_MODEL = "claude-opus-4-8";
  var HEALTH_TIMEOUT_MS = 1200;
  var BRIDGE_TIMEOUT_MS = 180000;
  var BYOK_MAX_TOKENS = 4096;

  var SYSTEM_PROMPT = [
    "あなたはTOEIC Speakingテスト専属のスピーキングコーチです。相手はスコアアップを目指す受験者です。",
    "貼られた問題の画像や質問に対し、必ず次の構成のMarkdownで、日本語で簡潔に解説してください。",
    "## 答え",
    "どの設問タイプ（Q1-2音読／Q3-4写真描写／Q5-7応答／Q8-10資料応答／Q11意見）かを明示し、模範的な解答の型（話す順序・骨子）を示す。",
    "## なぜ？",
    "発音・イントネーション・文法・語彙・一貫性など採点で評価される観点に沿って、その型が有効な理由を2〜3文で。",
    "## 例えると",
    "身近な例え話を1つ（プレゼンの型・電話応対・道案内など、話し方のイメージが伝わる比喩で直感的に）。",
    "## ついでに覚える",
    "関連して使い回せる定番フレーズや発音・間の取り方のコツを1〜2個。",
    "採点はTOEIC Speaking公式スコア0〜200点・10点刻み。目標スコア130点／150点それぞれを目指す場合に不足しがちな要素"
      + "（例: 130点は基本文型の正確さと最後まで話しきること、150点はより自然な展開・詳細さ・語彙の幅）を意識したアドバイスを添えること。",
    "専門用語には必ず一言のやさしい説明を添えること。冗長にしない。",
    "重要な制約: 市販教材（改訂版TOEIC(R)スピーキングテスト究極のゼミ 等）の本文・例文・設問文・模範解答を逐語的に引用・再現しないこと。"
      + "一般的な解法・自分の言葉での説明にとどめること。",
  ].join("\n");

  /* --- バックエンド判定 --------------------------------------------------- */

  var cachedBackend = null;

  function fetchWithTimeout(url, options, timeoutMs) {
    var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    var opts = Object.assign({}, options || {});
    if (controller) opts.signal = controller.signal;
    var timer = setTimeout(function () {
      if (controller) controller.abort();
    }, timeoutMs);
    return fetch(url, opts).finally(function () {
      clearTimeout(timer);
    });
  }

  function detectBackend() {
    // location.origin がブリッジと同一なら確定。
    try {
      if (typeof location !== "undefined" && location.origin === BRIDGE_ORIGIN) {
        cachedBackend = "bridge";
        return Promise.resolve("bridge");
      }
    } catch (e) {
      /* location 参照失敗は無視 */
    }
    return fetchWithTimeout(BRIDGE_ORIGIN + "/api/health", { method: "GET" }, HEALTH_TIMEOUT_MS)
      .then(function (res) {
        cachedBackend = res && res.ok ? "bridge" : "byok";
        return cachedBackend;
      })
      .catch(function () {
        cachedBackend = "byok";
        return "byok";
      });
  }

  /* --- エラーメッセージ変換（BYOK） -------------------------------------- */

  function humanizeHttpError(status, apiMessage) {
    if (status === 401) return "APIキーが無効です。設定でキーを確認してください。";
    if (status === 400) return apiMessage ? "リクエストエラー: " + apiMessage : "リクエストが不正です。";
    if (status === 429) return "利用制限中。少し待って再試行してください。";
    if (status === 529) return "混雑中。再試行してください。";
    if (status >= 500) return "サーバー側で問題が発生しました。再試行してください。";
    return apiMessage || "通信エラーが発生しました（HTTP " + status + "）。";
  }

  /* --- メッセージ整形 ----------------------------------------------------- */

  function stripDataUrlPrefix(dataUrl) {
    // "data:image/jpeg;base64,XXXX" → "XXXX"
    var comma = dataUrl.indexOf(",");
    return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  }

  function detectMediaType(dataUrl) {
    var m = /^data:([^;,]+)[;,]/.exec(dataUrl);
    return m ? m[1] : "image/jpeg";
  }

  // BYOK 用（Anthropic content blocks 形式）に変換。
  function toAnthropicMessages(messages) {
    return messages.map(function (msg) {
      var images = Array.isArray(msg.images) ? msg.images : [];
      if (msg.role === "assistant") {
        // アシスタントはテキストのみ（画像添付は想定しない）。
        return { role: "assistant", content: msg.text || "" };
      }
      // user
      if (images.length === 0) {
        return { role: "user", content: msg.text || "" };
      }
      var content = images.map(function (dataUrl) {
        return {
          type: "image",
          source: {
            type: "base64",
            media_type: detectMediaType(dataUrl),
            data: stripDataUrlPrefix(dataUrl),
          },
        };
      });
      if (msg.text) {
        content.push({ type: "text", text: msg.text });
      }
      return { role: "user", content: content };
    });
  }

  // ブリッジ用（images は dataURL のまま渡す）。
  function toBridgeMessages(messages) {
    return messages.map(function (msg) {
      return {
        role: msg.role,
        text: msg.text || "",
        images: Array.isArray(msg.images) ? msg.images.slice() : [],
      };
    });
  }

  /* --- ブリッジ送信（非ストリーミング） ---------------------------------- */

  function sendViaBridge(opts) {
    var body = JSON.stringify({
      system: opts.system || SYSTEM_PROMPT,
      messages: toBridgeMessages(opts.messages || []),
    });
    return fetchWithTimeout(
      BRIDGE_ORIGIN + "/api/chat",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body,
      },
      BRIDGE_TIMEOUT_MS
    )
      .then(function (res) {
        return res
          .json()
          .catch(function () {
            throw new Error("ローカルサーバーの応答を解釈できませんでした。");
          })
          .then(function (data) {
            if (res.ok && data && data.ok) {
              var full = typeof data.text === "string" ? data.text : "";
              if (typeof opts.onDone === "function") opts.onDone(full);
              return full;
            }
            var msg = data && data.error ? String(data.error) : "ローカルでの生成に失敗しました。";
            throw new Error(msg);
          });
      })
      .catch(function (err) {
        var message =
          err && err.name === "AbortError"
            ? "ローカル生成がタイムアウトしました。再試行してください。"
            : err && err.message
              ? err.message
              : "ローカルサーバーに接続できませんでした。.command での起動をご確認ください。";
        if (typeof opts.onError === "function") opts.onError(new Error(message));
        throw new Error(message);
      });
  }

  /* --- BYOK 送信（SSE ストリーミング） ----------------------------------- */

  async function sendViaByok(opts) {
    var apiKey = opts.apiKey;
    if (!apiKey) {
      var e = new Error("APIキーが設定されていません。設定から入力してください。");
      if (typeof opts.onError === "function") opts.onError(e);
      throw e;
    }
    var model = opts.model || DEFAULT_MODEL;
    var body = JSON.stringify({
      model: model,
      max_tokens: BYOK_MAX_TOKENS,
      stream: true,
      system: opts.system || SYSTEM_PROMPT,
      messages: toAnthropicMessages(opts.messages || []),
    });

    var res;
    try {
      res = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: body,
      });
    } catch (netErr) {
      var ne = new Error("ネットワークに接続できませんでした。通信環境をご確認ください。");
      if (typeof opts.onError === "function") opts.onError(ne);
      throw ne;
    }

    if (!res.ok) {
      var apiMessage = "";
      try {
        var errJson = await res.json();
        apiMessage = errJson && errJson.error && errJson.error.message ? errJson.error.message : "";
      } catch (e2) {
        /* JSON でない場合は無視 */
      }
      var he = new Error(humanizeHttpError(res.status, apiMessage));
      if (typeof opts.onError === "function") opts.onError(he);
      throw he;
    }

    if (!res.body || typeof res.body.getReader !== "function") {
      var se = new Error("この環境ではストリーミング応答を利用できません。");
      if (typeof opts.onError === "function") opts.onError(se);
      throw se;
    }

    var reader = res.body.getReader();
    var decoder = new TextDecoder("utf-8");
    var buffer = "";
    var full = "";
    var doneCalled = false;

    function handleDataLine(jsonStr) {
      if (jsonStr === "[DONE]") return;
      var evt;
      try {
        evt = JSON.parse(jsonStr);
      } catch (e3) {
        return; // 壊れた行はスキップ
      }
      if (
        evt &&
        evt.type === "content_block_delta" &&
        evt.delta &&
        evt.delta.type === "text_delta" &&
        typeof evt.delta.text === "string"
      ) {
        full += evt.delta.text;
        if (typeof opts.onDelta === "function") opts.onDelta(evt.delta.text);
      } else if (evt && evt.type === "message_stop") {
        doneCalled = true;
        if (typeof opts.onDone === "function") opts.onDone(full);
      } else if (evt && evt.type === "error") {
        var msg = evt.error && evt.error.message ? evt.error.message : "生成中にエラーが発生しました。";
        throw new Error(msg);
      }
    }

    function processBuffer() {
      var idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        var line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        line = line.replace(/\r$/, "").trim();
        if (line.length === 0) continue;
        if (line.indexOf("data:") === 0) {
          handleDataLine(line.slice(5).trim());
        }
        // "event:" 行等は type で判別するため無視。
      }
    }

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        processBuffer();
      }
      buffer += decoder.decode();
      processBuffer();
      // message_stop が欠落してもストリーム終端で完了を保証する。
      if (!doneCalled) {
        doneCalled = true;
        if (typeof opts.onDone === "function") opts.onDone(full);
      }
      return full;
    } catch (streamErr) {
      var msg = streamErr && streamErr.message ? streamErr.message : "生成中にエラーが発生しました。";
      var fe = new Error(msg);
      if (typeof opts.onError === "function") opts.onError(fe);
      throw fe;
    }
  }

  /* --- 公開 send ---------------------------------------------------------- */

  function send(opts) {
    var backend = opts && opts.backend;
    if (backend === "bridge") {
      return sendViaBridge(opts);
    }
    return sendViaByok(opts);
  }

  /* --- 公開 API ----------------------------------------------------------- */

  window.ToeicSwChatApi = {
    BRIDGE_ORIGIN: BRIDGE_ORIGIN,
    DEFAULT_MODEL: DEFAULT_MODEL,
    SYSTEM_PROMPT: SYSTEM_PROMPT,
    detectBackend: detectBackend,
    send: send,
  };
})();
