/* ===========================================================================
   TOEIC Speaking AIブリッジ — local-bridge/server.mjs
   ローカル専用の静的配信 + claude CLI ヘッドレス呼び出しブリッジ。
   Node標準モジュールのみ使用（npm install不要）。
   セキュリティ方針:
     - listen は 127.0.0.1 のみ
     - claude CLI には --allowedTools で一時画像フォルダの Read のみ許可
       （--permission-mode / --dangerously-skip-permissions は使用しない）
     - シェル文字列連結禁止。execFile に引数配列を渡す
     - プロンプト・画像内容はログに出力しない
   =========================================================================== */

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOST = "127.0.0.1";
const PORT = 8977;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SITE_ROOT = path.resolve(__dirname, "..");
const BRIDGE_DIR_NAME = "local-bridge";

const ALLOWED_ORIGINS = new Set([
  "http://127.0.0.1:8977",
  "http://127.0.0.1:8976",
  "https://shuyaofficial.github.io",
  "null",
]);

const MAX_BODY_BYTES = 25 * 1024 * 1024; // 25MB
const CLAUDE_TIMEOUT_MS = 170000;
const CLAUDE_MAX_BUFFER = 10 * 1024 * 1024;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const IMAGE_EXT_BY_MEDIA_TYPE = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

const TMP_CHAT_DIR = path.join(os.tmpdir(), "toeicsw-chat");

/* --- ユーティリティ ----------------------------------------------------- */

function logRequest(method, urlPath, status) {
  console.log(`${method} ${urlPath} ${status}`);
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin === undefined) {
    // Origin ヘッダ無し（curl 等）は CORS ヘッダ不要で許可。
    return true;
  }
  if (ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    return true;
  }
  return false;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

/* --- 静的配信 ------------------------------------------------------------ */

async function serveStatic(req, res, urlPath) {
  const decodedPath = decodeURIComponent(urlPath.split("?")[0]);
  const relativePath = decodedPath === "/" ? "/index.html" : decodedPath;

  // local-bridge/ 配下と隠しファイルは配信拒否。
  const segments = relativePath.split("/").filter(Boolean);
  const isHidden = segments.some((seg) => seg.startsWith("."));
  const isBridgeDir = segments[0] === BRIDGE_DIR_NAME;
  if (isHidden || isBridgeDir) {
    sendJson(res, 404, { ok: false, error: "Not Found" });
    logRequest(req.method, urlPath, 404);
    return;
  }

  const resolvedPath = path.resolve(SITE_ROOT, "." + relativePath);
  const rootWithSep = SITE_ROOT.endsWith(path.sep) ? SITE_ROOT : SITE_ROOT + path.sep;

  // パストラバーサル対策: 解決後パスがルート配下か検証。
  if (resolvedPath !== SITE_ROOT && !resolvedPath.startsWith(rootWithSep)) {
    sendJson(res, 404, { ok: false, error: "Not Found" });
    logRequest(req.method, urlPath, 404);
    return;
  }

  try {
    const stat = await fsp.stat(resolvedPath);
    if (stat.isDirectory()) {
      sendJson(res, 404, { ok: false, error: "Not Found" });
      logRequest(req.method, urlPath, 404);
      return;
    }
    const ext = path.extname(resolvedPath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    res.writeHead(200, {
      "content-type": contentType,
      "content-length": stat.size,
    });
    fs.createReadStream(resolvedPath).pipe(res);
    logRequest(req.method, urlPath, 200);
  } catch (err) {
    sendJson(res, 404, { ok: false, error: "Not Found" });
    logRequest(req.method, urlPath, 404);
  }
}

/* --- claude CLI 実行 ------------------------------------------------------ */

function resolveClaudeBin() {
  return ["claude", `${os.homedir()}/.claude/local/claude`, "/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
}

function runClaude(prompt, allowedToolsScope) {
  const candidates = resolveClaudeBin();

  function attempt(index) {
    if (index >= candidates.length) {
      return Promise.reject(new Error("claude CLI が見つかりませんでした。インストール状況をご確認ください。"));
    }
    const bin = candidates[index];
    return new Promise((resolve, reject) => {
      execFile(
        bin,
        ["-p", prompt, "--allowedTools", allowedToolsScope, "--model", "sonnet"],
        { timeout: CLAUDE_TIMEOUT_MS, maxBuffer: CLAUDE_MAX_BUFFER, env: process.env },
        (error, stdout) => {
          if (error) {
            if (error.code === "ENOENT") {
              resolve(attempt(index + 1));
              return;
            }
            if (error.killed || error.signal === "SIGTERM") {
              reject(new Error("応答がタイムアウトしました。もう一度お試しください。"));
              return;
            }
            reject(new Error("AIの呼び出しに失敗しました。claude CLI の状態をご確認ください。"));
            return;
          }
          resolve(stdout);
        }
      );
    });
  }

  return attempt(0);
}

/* --- プロンプト組み立て --------------------------------------------------- */

function buildPrompt(system, messages, imagePathsByMessageIndex) {
  const lines = [];
  lines.push(String(system || ""));
  lines.push("");
  lines.push("これまでの会話:");
  messages.forEach((msg, idx) => {
    const speaker = msg.role === "assistant" ? "[あなた]" : "[ユーザー]";
    lines.push(`${speaker} ${msg.text || ""}`);
    const imagePaths = imagePathsByMessageIndex.get(idx) || [];
    imagePaths.forEach((imgPath) => {
      lines.push(`画像: ${imgPath}`);
    });
  });
  lines.push("最後のユーザー発言に回答してください。画像パスが記載されている場合は必ずその画像をReadツールで読み、内容を踏まえて回答してください。");
  return lines.join("\n");
}

/* --- 画像保存 -------------------------------------------------------------- */

function parseDataUrl(dataUrl) {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
  if (!match) return null;
  return { mediaType: match[1], base64: match[2] };
}

async function saveImages(messages) {
  await fsp.mkdir(TMP_CHAT_DIR, { recursive: true });
  const imagePathsByMessageIndex = new Map();
  const savedPaths = [];

  for (let idx = 0; idx < messages.length; idx += 1) {
    const msg = messages[idx];
    const images = Array.isArray(msg.images) ? msg.images : [];
    if (images.length === 0) continue;

    const paths = [];
    for (const dataUrl of images) {
      const parsed = parseDataUrl(dataUrl);
      if (!parsed) {
        throw Object.assign(new Error("画像データの形式が不正です。"), { statusCode: 400 });
      }
      const ext = IMAGE_EXT_BY_MEDIA_TYPE[parsed.mediaType];
      if (!ext) {
        throw Object.assign(new Error("対応していない画像形式です（jpeg/png/webp/gifのみ）。"), { statusCode: 400 });
      }
      const fileId = crypto.randomBytes(16).toString("hex");
      const filePath = path.join(TMP_CHAT_DIR, `${fileId}.${ext}`);
      const buffer = Buffer.from(parsed.base64, "base64");
      await fsp.writeFile(filePath, buffer);
      paths.push(filePath);
      savedPaths.push(filePath);
    }
    imagePathsByMessageIndex.set(idx, paths);
  }

  return { imagePathsByMessageIndex, savedPaths };
}

async function cleanupFiles(filePaths) {
  await Promise.all(
    filePaths.map((filePath) =>
      fsp.unlink(filePath).catch(() => {
        /* 削除失敗は無視 */
      })
    )
  );
}

/* --- /api/chat ------------------------------------------------------------- */

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let rejected = false;
    req.on("data", (chunk) => {
      if (rejected) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        rejected = true;
        const err = new Error("リクエストサイズが上限（25MB）を超えています。");
        err.statusCode = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (rejected) return;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (err) => {
      if (rejected) return;
      reject(err);
    });
  });
}

async function handleChat(req, res) {
  let savedPaths = [];
  try {
    const bodyBuffer = await readBody(req);
    let payload;
    try {
      payload = JSON.parse(bodyBuffer.toString("utf-8"));
    } catch (parseErr) {
      sendJson(res, 400, { ok: false, error: "リクエストの形式が不正です。" });
      logRequest(req.method, "/api/chat", 400);
      return;
    }

    const system = typeof payload.system === "string" ? payload.system : "";
    const messages = Array.isArray(payload.messages) ? payload.messages : [];

    const { imagePathsByMessageIndex, savedPaths: paths } = await saveImages(messages);
    savedPaths = paths;

    const prompt = buildPrompt(system, messages, imagePathsByMessageIndex);
    const allowedToolsScope = `Read(//${TMP_CHAT_DIR}/**)`;

    const stdout = await runClaude(prompt, allowedToolsScope);
    sendJson(res, 200, { ok: true, text: stdout.trim() });
    logRequest(req.method, "/api/chat", 200);
  } catch (err) {
    const status = err && err.statusCode ? err.statusCode : 500;
    const message = err && err.message ? err.message : "AIとの通信でエラーが発生しました。";
    sendJson(res, status, { ok: false, error: message });
    logRequest(req.method, "/api/chat", status);
  } finally {
    await cleanupFiles(savedPaths);
  }
}

/* --- ルーティング ----------------------------------------------------------- */

async function handleRequest(req, res) {
  const urlPath = req.url || "/";
  const pathname = urlPath.split("?")[0];

  const corsOk = applyCors(req, res);

  if (req.method === "OPTIONS") {
    if (!corsOk) {
      sendJson(res, 403, { ok: false, error: "Forbidden origin" });
      logRequest(req.method, pathname, 403);
      return;
    }
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    res.writeHead(204);
    res.end();
    logRequest(req.method, pathname, 204);
    return;
  }

  if (!corsOk) {
    sendJson(res, 403, { ok: false, error: "Forbidden origin" });
    logRequest(req.method, pathname, 403);
    return;
  }

  if (req.method === "GET" && pathname === "/api/health") {
    sendJson(res, 200, { ok: true, backend: "claude-cli" });
    logRequest(req.method, pathname, 200);
    return;
  }

  if (req.method === "POST" && pathname === "/api/chat") {
    await handleChat(req, res);
    return;
  }

  if (req.method === "POST") {
    sendJson(res, 404, { ok: false, error: "Not Found" });
    logRequest(req.method, pathname, 404);
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    await serveStatic(req, res, pathname);
    return;
  }

  sendJson(res, 404, { ok: false, error: "Not Found" });
  logRequest(req.method, pathname, 404);
}

/* --- サーバー起動 ------------------------------------------------------------ */

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    if (!res.headersSent) {
      sendJson(res, 500, { ok: false, error: "サーバー内部エラーが発生しました。" });
    }
    logRequest(req.method, req.url || "/", 500);
  });
});

server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    console.log("すでに起動しています");
    process.exit(0);
  }
  console.error("サーバー起動エラー:", err.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`TOEIC Speaking AIブリッジ起動: http://${HOST}:${PORT} （このウィンドウを閉じると停止します）`);
});
