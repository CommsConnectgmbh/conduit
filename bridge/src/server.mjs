import http from "node:http";
import { WebSocketServer } from "ws";
import { jwtVerify } from "jose";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, appendFileSync, statSync, renameSync, accessSync, writeFileSync, constants as FS } from "node:fs";
import { join, extname } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import pty from "node-pty";
import {
  ensureSession, setClaudeSessionId, listSessions, getSession, deleteSession,
  listMessages, insertUserMessage, insertAssistantPlaceholder, appendAssistant,
  updateTitle, updateCwd, addUsage, maybeAutoTitle,
} from "./db.mjs";

function isValidCwd(p) {
  if (typeof p !== "string" || !p.startsWith("/") || p.includes("\0")) return false;
  try { return statSync(p).isDirectory(); } catch { return false; }
}

const PORT = parseInt(process.env.BRIDGE_PORT || "8787", 10);
const HOST = process.env.BRIDGE_HOST || "127.0.0.1";
const SECRET = process.env.BRIDGE_SECRET;
const CLAUDE_BIN = process.env.CLAUDE_BIN || `${homedir()}/.local/bin/claude`;
const CWD = process.env.CLAUDE_CWD || homedir();
const MODEL = process.env.CLAUDE_MODEL || "claude-opus-4-7";
const LOG_DIR = process.env.LOG_DIR || join(homedir(), "Library/Logs/conduit-bridge");
const IDLE_TTL_MS = 12 * 60 * 60 * 1000; // 12h in-memory state
const MAX_BUF = 1_000_000;
const LOG_FILE = join(LOG_DIR, "bridge.log");
const MAX_LOG_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_LOG_FILES = 5;
const WS_HEARTBEAT_MS = 30_000;          // server-side ping interval
const WS_PONG_TIMEOUT_MS = 75_000;       // terminate WS if no client traffic
const CHILD_STALL_MS = 600_000;          // no stdout for 10min → kill claude
const CHILD_HEARTBEAT_MS = 25_000;       // emit "still working" event during silence

// Whisper STT: persistent local whisper-server keeps the model warm in RAM
// for ~300 ms inference instead of ~4 s reload-per-call.
const WHISPER_SERVER_URL = process.env.WHISPER_SERVER_URL || "http://127.0.0.1:8088/inference";
const TRANSCRIBE_MAX_BYTES = 25 * 1024 * 1024; // 25 MB
const TRANSCRIBE_TIMEOUT_MS = 60_000;

if (!SECRET) { console.error("BRIDGE_SECRET missing"); process.exit(1); }
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

// In-process event-loop watchdog: if the loop is starved for >5s,
// self-exit so launchd restarts us. KeepAlive on the agent ensures
// the process is back within ThrottleInterval (10s).
{
  let lastTick = Date.now();
  setInterval(() => {
    const now = Date.now();
    const drift = now - lastTick - 1000;
    if (drift > 5000) {
      console.error(`[event-loop-watchdog] drift=${drift}ms — self-exit for restart`);
      process.exit(2);
    }
    lastTick = now;
  }, 1000).unref();
}

const enc = new TextEncoder();

function rotateLogIfNeeded() {
  try {
    const st = statSync(LOG_FILE);
    if (st.size < MAX_LOG_BYTES) return;
    for (let i = MAX_LOG_FILES - 1; i >= 0; i--) {
      const src = i === 0 ? LOG_FILE : `${LOG_FILE}.${i}`;
      const dst = `${LOG_FILE}.${i + 1}`;
      try { renameSync(src, dst); } catch {}
    }
  } catch {}
}

const log = (level, msg, meta = {}) => {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...meta }) + "\n";
  process.stdout.write(line);
  rotateLogIfNeeded();
  try { appendFileSync(LOG_FILE, line); } catch {}
};

/** sessionRuntime: sid -> { claudeSessionId, lastUsed, child? } */
const runtime = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of runtime) {
    if (now - s.lastUsed > IDLE_TTL_MS && !s.child) {
      runtime.delete(sid);
    }
  }
}, 5 * 60_000).unref();

async function verifyToken(token, audience) {
  try {
    const { payload } = await jwtVerify(token, enc.encode(SECRET), {
      issuer: "conduit",
      audience,
    });
    return { email: String(payload.email), sid: payload.sid ? String(payload.sid) : null };
  } catch {
    return null;
  }
}

async function authFromHeader(req) {
  const h = req.headers["authorization"] || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  return await verifyToken(m[1], "api");
}

function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

async function readJson(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    req.on("data", (c) => {
      total += c.length;
      if (total > 1_000_000) { req.destroy(); resolve(null); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { resolve(null); }
    });
    req.on("error", () => resolve(null));
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");

  if (u.pathname === "/healthz") {
    let claudeOk = false;
    try { accessSync(CLAUDE_BIN, FS.X_OK); claudeOk = true; } catch {}
    const ok = claudeOk;
    return json(res, ok ? 200 : 503, {
      ok,
      sessions: runtime.size,
      uptime: process.uptime(),
      claude: claudeOk,
      activeChildren: [...runtime.values()].filter((r) => r.child).length,
    });
  }

  if (u.pathname.startsWith("/api/")) {
    const auth = await authFromHeader(req);
    if (!auth) return json(res, 401, { ok: false, error: "unauthorized" });
    return handleApi(req, res, u, auth);
  }

  res.writeHead(404).end();
});

// Roots to search for @-file mentions. Defaults to CLAUDE_CWD; override with
// FILE_SEARCH_ROOTS as a colon-separated list of absolute paths.
const SEARCH_ROOTS = (process.env.FILE_SEARCH_ROOTS || CWD)
  .split(":")
  .map((s) => s.trim())
  .filter((s) => s.startsWith("/"));
const FILE_SEARCH_LIMIT = 30;
const FILE_SEARCH_EXCLUDES = new Set([
  "node_modules", ".next", ".git", ".build", "dist", ".vercel", ".turbo",
  ".cache", "coverage", "build", "out", ".expo", ".gradle", ".idea",
  "Pods", "DerivedData", "vendor", ".pnpm", ".yarn", "tmp",
]);

async function handleFileSearch(req, res, u, auth) {
  const q = (u.searchParams.get("q") || "").trim().toLowerCase();
  if (q.length < 2) return json(res, 200, { ok: true, files: [] });

  const out = [];
  const seen = new Set();
  const { readdirSync } = await import("node:fs");

  function walk(dir, depth) {
    if (out.length >= FILE_SEARCH_LIMIT * 3) return;
    if (depth > 6) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= FILE_SEARCH_LIMIT * 3) return;
      if (e.name.startsWith(".") && e.name !== ".env.shared") continue;
      if (FILE_SEARCH_EXCLUDES.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        // Directory itself can be a match
        if (e.name.toLowerCase().includes(q) && !seen.has(p)) {
          seen.add(p);
          out.push({ path: p, kind: "dir" });
        }
        walk(p, depth + 1);
      } else if (e.isFile()) {
        const name = e.name.toLowerCase();
        if (name.includes(q) && !seen.has(p)) {
          seen.add(p);
          out.push({ path: p, kind: "file" });
        }
      }
    }
  }

  for (const root of SEARCH_ROOTS) {
    try { if (!statSync(root).isDirectory()) continue; } catch { continue; }
    walk(root, 0);
    if (out.length >= FILE_SEARCH_LIMIT * 3) break;
  }

  // Rank: exact basename match > basename startsWith > basename contains > path contains
  const ranked = out.map((r) => {
    const base = r.path.split("/").pop().toLowerCase();
    let score = 0;
    if (base === q) score = 1000;
    else if (base.startsWith(q)) score = 500;
    else if (base.includes(q)) score = 200;
    else score = 50;
    score -= r.path.length * 0.1; // prefer shorter paths
    return { ...r, score };
  }).sort((a, b) => b.score - a.score).slice(0, FILE_SEARCH_LIMIT);

  return json(res, 200, {
    ok: true,
    files: ranked.map((r) => ({ path: r.path, kind: r.kind })),
  });
}

const PASTE_DIR = "/tmp/conduit-pastes";
const PASTE_MAX_BYTES = 25 * 1024 * 1024; // 25 MB
const PASTE_ALLOWED_MIME = new Map([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/jpg", ".jpg"],
  ["image/gif", ".gif"],
  ["image/webp", ".webp"],
  ["image/heic", ".heic"],
  ["image/heif", ".heif"],
  ["application/pdf", ".pdf"],
]);

async function handlePasteUpload(req, res, auth) {
  const ct = (req.headers["content-type"] || "").toLowerCase();
  const cl = parseInt(req.headers["content-length"] || "0", 10);
  if (cl && cl > PASTE_MAX_BYTES) {
    return json(res, 413, { ok: false, error: "file too large (max 25 MB)" });
  }

  // Accept both raw image upload (Content-Type: image/...) and multipart
  if (!ct.startsWith("image/") && !ct.includes("multipart/form-data") && ct !== "application/pdf") {
    return json(res, 400, { ok: false, error: "expected image/* or multipart/form-data" });
  }

  try {
    if (!existsSync(PASTE_DIR)) mkdirSync(PASTE_DIR, { recursive: true });

    const chunks = [];
    let received = 0;
    for await (const chunk of req) {
      received += chunk.length;
      if (received > PASTE_MAX_BYTES) throw new Error("file too large");
      chunks.push(chunk);
    }
    if (!received) return json(res, 400, { ok: false, error: "empty body" });
    const body = Buffer.concat(chunks);

    let ext, fileBuf;
    if (ct.startsWith("image/") || ct === "application/pdf") {
      ext = PASTE_ALLOWED_MIME.get(ct.split(";")[0].trim()) || ".bin";
      fileBuf = body;
    } else {
      // Parse multipart - quick extraction of the first file part
      const match = ct.match(/boundary=(.+)$/i);
      if (!match) return json(res, 400, { ok: false, error: "missing multipart boundary" });
      const boundary = "--" + match[1];
      const str = body.toString("binary");
      const parts = str.split(boundary);
      let found = null;
      for (const p of parts) {
        const hdrEnd = p.indexOf("\r\n\r\n");
        if (hdrEnd < 0) continue;
        const hdrs = p.slice(0, hdrEnd).toLowerCase();
        if (!hdrs.includes("filename=")) continue;
        const ctMatch = hdrs.match(/content-type:\s*([^\r\n]+)/);
        const partCt = ctMatch ? ctMatch[1].trim() : "application/octet-stream";
        const data = p.slice(hdrEnd + 4, p.length - 2); // strip trailing \r\n
        found = { ct: partCt, data: Buffer.from(data, "binary") };
        break;
      }
      if (!found) return json(res, 400, { ok: false, error: "no file part" });
      ext = PASTE_ALLOWED_MIME.get(found.ct) || extname(found.ct) || ".bin";
      fileBuf = found.data;
    }

    if (!PASTE_ALLOWED_MIME.has(ct.split(";")[0].trim()) && ![".png", ".jpg", ".gif", ".webp", ".heic", ".heif", ".pdf"].includes(ext)) {
      return json(res, 415, { ok: false, error: "unsupported file type" });
    }

    const name = `${Date.now()}-${randomUUID().slice(0, 8)}${ext}`;
    const filePath = join(PASTE_DIR, name);
    writeFileSync(filePath, fileBuf);

    log("info", "paste_saved", { email: auth.email, path: filePath, bytes: fileBuf.length });
    return json(res, 200, { ok: true, path: filePath, bytes: fileBuf.length });
  } catch (e) {
    log("error", "paste_failed", { email: auth.email, err: String(e) });
    return json(res, 500, { ok: false, error: String(e?.message || e).slice(0, 300) });
  }
}

async function handleTranscribe(req, res, auth) {
  const ct = req.headers["content-type"] || "";
  if (!ct.includes("multipart/form-data")) {
    return json(res, 400, { ok: false, error: "expected multipart/form-data" });
  }
  const cl = parseInt(req.headers["content-length"] || "0", 10);
  if (cl && cl > TRANSCRIBE_MAX_BYTES) {
    return json(res, 413, { ok: false, error: "audio too large" });
  }

  const started = Date.now();
  try {
    // Buffer the multipart body (small — typical 50–500 KB) and forward verbatim.
    const chunks = [];
    let received = 0;
    for await (const chunk of req) {
      received += chunk.length;
      if (received > TRANSCRIBE_MAX_BYTES) throw new Error("audio too large");
      chunks.push(chunk);
    }
    if (!received) return json(res, 400, { ok: false, error: "empty body" });
    const body = Buffer.concat(chunks);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TRANSCRIBE_TIMEOUT_MS);
    const r = await fetch(WHISPER_SERVER_URL, {
      method: "POST",
      body,
      headers: { "content-type": ct },
      signal: ctrl.signal,
    });
    clearTimeout(timer);

    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      log("error", "whisper_server_bad_status", { status: r.status, body: errText.slice(0, 200) });
      return json(res, 502, { ok: false, error: `whisper-server ${r.status}` });
    }
    const data = await r.json().catch(() => ({}));
    const text = String(data.text || "").replace(/\s+/g, " ").trim();

    const ms = Date.now() - started;
    log("info", "transcribe_ok", { email: auth.email, bytes: received, ms, len: text.length });
    return json(res, 200, { ok: true, text, ms });
  } catch (e) {
    const msg = String(e?.message || e);
    log("error", "transcribe_failed", { email: auth.email, err: msg });
    return json(res, 500, { ok: false, error: msg.slice(0, 300) });
  }
}

async function handleApi(req, res, u, auth) {
  const email = auth.email;
  const path = u.pathname;

  if (path === "/api/transcribe" && req.method === "POST") {
    return handleTranscribe(req, res, auth);
  }

  if (path === "/api/files" && req.method === "GET") {
    return handleFileSearch(req, res, u, auth);
  }

  if (path === "/api/paste" && req.method === "POST") {
    return handlePasteUpload(req, res, auth);
  }

  if (path === "/api/sessions" && req.method === "GET") {
    const rows = listSessions(email);
    return json(res, 200, {
      ok: true,
      sessions: rows.map((r) => ({
        id: r.id,
        title: r.title,
        updatedAt: r.updated_at,
        cwd: r.cwd || null,
        usage: {
          tokens_in: r.tokens_in || 0,
          tokens_out: r.tokens_out || 0,
          cache_read: r.cache_read || 0,
          cache_create: r.cache_create || 0,
          cost_usd: r.cost_usd || 0,
          turns: r.turns || 0,
        },
      })),
    });
  }

  const m = path.match(/^\/api\/sessions\/([0-9a-f-]+)(\/messages)?$/i);
  if (m) {
    const sid = m[1];
    const isMessages = !!m[2];
    if (isMessages && req.method === "GET") {
      const msgs = listMessages(sid, email);
      if (msgs === null) return json(res, 404, { ok: false, error: "not found" });
      return json(res, 200, { ok: true, messages: msgs.map((r) => ({ id: r.id, role: r.role, content: r.content, ts: r.ts })) });
    }
    if (!isMessages && req.method === "DELETE") {
      const r = deleteSession(sid, email);
      const rt = runtime.get(sid);
      if (rt?.child) { try { rt.child.kill("SIGTERM"); } catch {} }
      runtime.delete(sid);
      return json(res, 200, { ok: true, deleted: r.changes });
    }
    if (!isMessages && req.method === "PATCH") {
      const body = await readJson(req) || {};
      const out = { ok: true };
      if (typeof body.title === "string") {
        const title = body.title.trim().slice(0, 120);
        if (!title) return json(res, 400, { ok: false, error: "title empty" });
        out.titleUpdated = updateTitle(sid, email, title).changes;
      }
      if (typeof body.cwd === "string" || body.cwd === null) {
        if (body.cwd === null || body.cwd === "") {
          out.cwdUpdated = updateCwd(sid, email, null).changes;
        } else if (!isValidCwd(body.cwd)) {
          return json(res, 400, { ok: false, error: "cwd invalid or not a directory" });
        } else {
          out.cwdUpdated = updateCwd(sid, email, body.cwd).changes;
        }
      }
      if (out.titleUpdated === undefined && out.cwdUpdated === undefined) {
        return json(res, 400, { ok: false, error: "nothing to update" });
      }
      return json(res, 200, out);
    }
  }

  return json(res, 404, { ok: false, error: "route not found" });
}

const wss = new WebSocketServer({ noServer: true });
const ptyWss = new WebSocketServer({ noServer: true });

server.on("upgrade", async (req, socket, head) => {
  const ua = (req.headers["user-agent"] || "").slice(0, 60);
  const cf = req.headers["cf-ray"] || "";
  try {
    const u = new URL(req.url, "http://localhost");
    log("info", "ws_upgrade_attempt", { path: u.pathname, cfRay: cf, ua });
    if (u.pathname !== "/ws" && u.pathname !== "/pty") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n"); socket.destroy(); return;
    }
    const token = u.searchParams.get("token");
    const querySid = u.searchParams.get("sid");
    if (!token) { socket.write("HTTP/1.1 400 Bad Request\r\n\r\n"); socket.destroy(); return; }
    const auth = await verifyToken(token, "bridge");
    if (!auth) {
      log("warn", "ws_upgrade_bad_token", {});
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); socket.destroy(); return;
    }
    const sid = querySid || auth.sid;
    if (!sid) { socket.write("HTTP/1.1 400 Bad Request\r\n\r\n"); socket.destroy(); return; }
    const targetWss = u.pathname === "/pty" ? ptyWss : wss;
    targetWss.handleUpgrade(req, socket, head, (ws) => {
      ws.auth = { ...auth, sid };
      log("info", "ws_open", { sid, email: auth.email, cfRay: cf, kind: u.pathname });
      if (u.pathname === "/pty") handlePtySocket(ws);
      else handleSocket(ws);
    });
  } catch (e) {
    log("error", "upgrade_failed", { err: String(e) });
    try { socket.destroy(); } catch {}
  }
});

// Heartbeat: ping clients periodically, terminate dead ones.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      log("warn", "ws_terminate_dead", { sid: ws.auth?.sid });
      try { ws.terminate(); } catch {}
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, WS_HEARTBEAT_MS);
heartbeat.unref();

wss.on("close", () => clearInterval(heartbeat));

function handleSocket(ws) {
  let currentChild = null;
  let childStallTimer = null;
  let childHeartbeatTimer = null;
  let lastChildOutputAt = 0;
  let lastClientTrafficAt = Date.now();
  ws.isAlive = true;

  const send = (obj) => { try { ws.send(JSON.stringify(obj)); } catch {} };
  const touchClient = () => { lastClientTrafficAt = Date.now(); ws.isAlive = true; };

  ws.on("pong", touchClient);

  const killChild = (reason) => {
    if (!currentChild) return;
    try { currentChild.kill("SIGTERM"); } catch {}
    log("warn", "child_killed", { sid: ws.auth?.sid, reason });
  };

  const armChildStallTimer = () => {
    lastChildOutputAt = Date.now();
    if (childStallTimer) clearTimeout(childStallTimer);
    childStallTimer = setTimeout(() => {
      if (currentChild) {
        send({ type: "error", message: "Claude antwortet seit 10 min nicht — abgebrochen." });
        killChild("stall");
      }
    }, CHILD_STALL_MS);
  };

  const startChildHeartbeat = () => {
    stopChildHeartbeat();
    childHeartbeatTimer = setInterval(() => {
      if (!currentChild) return;
      const silentMs = Date.now() - lastChildOutputAt;
      if (silentMs >= CHILD_HEARTBEAT_MS) {
        send({ type: "heartbeat", silentMs });
      }
    }, CHILD_HEARTBEAT_MS);
    childHeartbeatTimer.unref?.();
  };

  const stopChildHeartbeat = () => {
    if (childHeartbeatTimer) { clearInterval(childHeartbeatTimer); childHeartbeatTimer = null; }
  };

  const clearChildStallTimer = () => {
    if (childStallTimer) { clearTimeout(childStallTimer); childStallTimer = null; }
    stopChildHeartbeat();
  };

  // Detect client gone: if no ping/pong/message for ~75s, terminate.
  const clientWatch = setInterval(() => {
    if (Date.now() - lastClientTrafficAt > WS_PONG_TIMEOUT_MS) {
      log("warn", "ws_silent_client_terminate", { sid: ws.auth?.sid });
      try { ws.terminate(); } catch {}
    }
  }, 15_000);
  clientWatch.unref();

  ws.on("message", async (raw) => {
    touchClient();
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    const sid = ws.auth.sid;
    const email = ws.auth.email;

    if (msg.type === "prompt" && typeof msg.content === "string") {
      if (currentChild) {
        send({ type: "error", message: "Previous response still running — please stop it." });
        return;
      }

      const sess = ensureSession(sid, email);
      if (!sess) {
        send({ type: "error", message: "Session conflict (belongs to a different account)." });
        return;
      }

      // Stale-Child-Kill: kill any orphan child still bound to this sid
      // from a previous (now-dead) WS connection before spawning a new one.
      const existing = runtime.get(sid);
      if (existing?.child) {
        log("warn", "killing_stale_child_on_reconnect", { sid });
        try { existing.child.kill("SIGTERM"); } catch {}
        existing.child = undefined;
      }

      maybeAutoTitle(sid, email, msg.content);

      const userMsgId = msg.userMessageId || cryptoRandom();
      try { insertUserMessage(sid, userMsgId, msg.content); } catch (e) { /* dup id ignored */ }

      const assistantId = msg.assistantMessageId || cryptoRandom();
      try { insertAssistantPlaceholder(sid, assistantId); } catch {}

      send({ type: "started", userMessageId: userMsgId, assistantMessageId: assistantId });

      const rt = runtime.get(sid) || { claudeSessionId: sess.claude_session_id || null, lastUsed: Date.now() };
      runtime.set(sid, rt);
      rt.lastUsed = Date.now();

      const args = [
        "-p", msg.content,
        "--model", MODEL,
        "--output-format", "stream-json",
        "--verbose",
        "--permission-mode", "bypassPermissions",
      ];
      if (rt.claudeSessionId) args.push("--resume", rt.claudeSessionId);
      else if (isUuid(sid)) args.push("--session-id", sid);

      log("info", "spawn_claude", { sid, hasResume: !!rt.claudeSessionId, len: msg.content.length });

      const spawnCwd = (sess.cwd && isValidCwd(sess.cwd)) ? sess.cwd : CWD;
      let child;
      try {
        child = spawn(CLAUDE_BIN, args, { cwd: spawnCwd, env: { ...process.env, FORCE_COLOR: "0" }, stdio: ["ignore", "pipe", "pipe"] });
      } catch (e) {
        send({ type: "error", message: `claude konnte nicht gestartet werden: ${e.message}` });
        return;
      }
      currentChild = child;
      rt.child = child;
      armChildStallTimer();
      startChildHeartbeat();

      let buf = "";
      let stderrBuf = "";
      child.stdout.on("data", (chunk) => {
        armChildStallTimer();
        buf += chunk.toString("utf8");
        if (buf.length > MAX_BUF) buf = buf.slice(-MAX_BUF);
        let idx;
        while ((idx = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          handleStreamLine(line, send, rt, sid, assistantId);
        }
      });
      child.stderr.on("data", (chunk) => {
        stderrBuf += chunk.toString("utf8");
        if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-4000);
      });
      child.on("close", (code, signal) => {
        clearChildStallTimer();
        if (buf.trim()) handleStreamLine(buf.trim(), send, rt, sid, assistantId);
        if (code !== 0 && signal !== "SIGTERM") {
          send({ type: "error", message: `claude exit ${code}: ${stderrBuf.trim().slice(0, 600) || "unbekannt"}` });
        } else {
          send({ type: "done", assistantMessageId: assistantId });
        }
        currentChild = null;
        rt.child = undefined;
        log("info", "claude_done", { sid, code, signal });
      });
      child.on("error", (e) => {
        clearChildStallTimer();
        send({ type: "error", message: `claude error: ${e.message}` });
        currentChild = null;
        rt.child = undefined;
      });
    } else if (msg.type === "stop") {
      killChild("client_stop");
    } else if (msg.type === "ping") {
      send({ type: "pong" });
    }
  });
  ws.on("close", () => {
    clearChildStallTimer();
    clearInterval(clientWatch);
    // Note: we do NOT kill the child on ws.close — keep streaming so that
    // a reconnect (or another tab) can pick up via DB persistence. The
    // stale-child-kill on next prompt prevents zombies. Idle child cleanup
    // happens via IDLE_TTL_MS sweeper.
    log("info", "ws_close", { sid: ws.auth?.sid, hasChild: !!currentChild });
  });
}

function handleStreamLine(line, send, rt, sid, assistantId) {
  let ev;
  try { ev = JSON.parse(line); } catch { return; }
  if (ev.type === "system" && ev.subtype === "init" && ev.session_id) {
    rt.claudeSessionId = ev.session_id;
    try { setClaudeSessionId(sid, ev.session_id); } catch {}
  } else if (ev.type === "assistant" && ev.message?.content) {
    for (const block of ev.message.content) {
      if (block.type === "text" && typeof block.text === "string") {
        send({ type: "chunk", text: block.text, assistantMessageId: assistantId });
        try { appendAssistant(assistantId, block.text); } catch {}
      } else if (block.type === "tool_use") {
        const marker = `\n\n_⚙ ${block.name}_\n`;
        send({ type: "chunk", text: marker, assistantMessageId: assistantId });
        try { appendAssistant(assistantId, marker); } catch {}
      }
    }
  } else if (ev.type === "result") {
    if (ev.is_error && ev.result) {
      send({ type: "error", message: String(ev.result).slice(0, 600) });
    }
    if (ev.usage) {
      const delta = {
        tokens_in:    Number(ev.usage.input_tokens)               || 0,
        tokens_out:   Number(ev.usage.output_tokens)              || 0,
        cache_read:   Number(ev.usage.cache_read_input_tokens)    || 0,
        cache_create: Number(ev.usage.cache_creation_input_tokens) || 0,
        cost_usd:     Number(ev.total_cost_usd)                   || 0,
      };
      try { addUsage(sid, delta); } catch {}
      send({ type: "usage", delta, durationMs: ev.duration_ms || 0 });
    }
  }
}

// -------- PTY Mode (xterm.js terminal in PWA) --------
// Each WS connection spawns a PTY that runs `claude` interactively.
// Frames from client: {type:"input", data:string} / {type:"resize", cols, rows} / {type:"signal", name:"SIGINT"}
// Frames to client:   {type:"data", data:string} / {type:"exit", code, signal}
//
// Sudo askpass: SUDO_ASKPASS points to askpass-claude-sudo.sh, which pulls the
// password from the macOS Keychain (service "claude-sudo"). `sudo -A` uses this
// automatically, so sudo commands in the terminal work without a hanging prompt.

const ASKPASS_PATH = process.env.ASKPASS_PATH || join(homedir(), "Library/conduit-bridge/bin/askpass-claude-sudo.sh");

function handlePtySocket(ws) {
  const sid = ws.auth.sid;
  const email = ws.auth.email;

  // CWD: aus Session-DB (Project-Picker) oder fallback CWD
  let sess = null;
  try { sess = ensureSession(sid, email); } catch {}
  if (!sess) {
    try { ws.send(JSON.stringify({ type: "exit", code: -1, error: "session conflict" })); } catch {}
    try { ws.close(); } catch {}
    return;
  }
  const spawnCwd = (sess.cwd && isValidCwd(sess.cwd)) ? sess.cwd : CWD;

  // Optional: `claude --resume <id>` wenn vorhanden, sonst neuer Session-Start
  const args = [];
  if (sess.claude_session_id) args.push("--resume", sess.claude_session_id);
  else if (isUuid(sid)) args.push("--session-id", sid);
  args.push("--permission-mode", "bypassPermissions");

  const env = {
    ...process.env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    LANG: process.env.LANG || "en_US.UTF-8",
    SUDO_ASKPASS: ASKPASS_PATH,
    FORCE_COLOR: "1",
  };

  let term;
  try {
    term = pty.spawn(CLAUDE_BIN, args, {
      name: "xterm-256color",
      cols: 120,
      rows: 32,
      cwd: spawnCwd,
      env,
    });
  } catch (e) {
    try { ws.send(JSON.stringify({ type: "exit", code: -1, error: `pty spawn failed: ${e.message}` })); } catch {}
    try { ws.close(); } catch {}
    log("error", "pty_spawn_failed", { sid, err: e.message });
    return;
  }

  log("info", "pty_open", { sid, email, cwd: spawnCwd, resume: !!sess.claude_session_id });

  // PTY → Client
  term.onData((data) => {
    try { ws.send(JSON.stringify({ type: "data", data })); } catch {}
  });
  term.onExit(({ exitCode, signal }) => {
    try { ws.send(JSON.stringify({ type: "exit", code: exitCode, signal })); } catch {}
    try { ws.close(); } catch {}
    log("info", "pty_exit", { sid, code: exitCode, signal });
  });

  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  // Client → PTY
  ws.on("message", (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === "input" && typeof msg.data === "string") {
      try { term.write(msg.data); } catch {}
    } else if (msg.type === "resize" && Number.isInteger(msg.cols) && Number.isInteger(msg.rows)) {
      try { term.resize(Math.max(2, msg.cols), Math.max(2, msg.rows)); } catch {}
    } else if (msg.type === "signal") {
      try {
        if (msg.name === "SIGINT") term.kill("SIGINT");
        else if (msg.name === "SIGTERM") term.kill("SIGTERM");
      } catch {}
    } else if (msg.type === "ping") {
      try { ws.send(JSON.stringify({ type: "pong" })); } catch {}
    }
  });

  ws.on("close", () => {
    log("info", "pty_ws_close", { sid });
    try { term.kill(); } catch {}
  });
  ws.on("error", () => {
    try { term.kill(); } catch {}
  });
}

function isUuid(s) {
  return typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function cryptoRandom() {
  return [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

server.listen(PORT, HOST, () => {
  log("info", "bridge_listening", { host: HOST, port: PORT, claude: CLAUDE_BIN, cwd: CWD, db: process.env.DB_DIR || "~/Library/conduit-bridge" });
});
