import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";

const DB_DIR = process.env.DB_DIR || join(homedir(), "Library/conduit-bridge");
mkdirSync(DB_DIR, { recursive: true });
const DB_PATH = join(DB_DIR, "db.sqlite");

export const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_email TEXT NOT NULL,
    claude_session_id TEXT,
    title TEXT NOT NULL DEFAULT 'Neuer Chat',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user_updated ON sessions(user_email, updated_at DESC);

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    ts INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_messages_session_ts ON messages(session_id, ts);
`);

// Idempotent column-adds: SQLite ALTER throws if column exists, so wrap each.
for (const ddl of [
  "ALTER TABLE sessions ADD COLUMN cwd TEXT",
  "ALTER TABLE sessions ADD COLUMN tokens_in INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE sessions ADD COLUMN tokens_out INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE sessions ADD COLUMN cache_read INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE sessions ADD COLUMN cache_create INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE sessions ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0",
  "ALTER TABLE sessions ADD COLUMN turns INTEGER NOT NULL DEFAULT 0",
]) {
  try { db.exec(ddl); } catch { /* column already present */ }
}

const Q = {
  upsertSession: db.prepare(`
    INSERT INTO sessions (id, user_email, title, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at
  `),
  setClaudeSessionId: db.prepare(`UPDATE sessions SET claude_session_id = ?, updated_at = ? WHERE id = ?`),
  setTitle: db.prepare(`UPDATE sessions SET title = ?, updated_at = ? WHERE id = ? AND user_email = ?`),
  setCwd: db.prepare(`UPDATE sessions SET cwd = ?, updated_at = ? WHERE id = ? AND user_email = ?`),
  touchSession: db.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`),
  getSession: db.prepare(`SELECT * FROM sessions WHERE id = ? AND user_email = ?`),
  getSessionRaw: db.prepare(`SELECT * FROM sessions WHERE id = ?`),
  listSessions: db.prepare(`
    SELECT id, title, updated_at, cwd, tokens_in, tokens_out, cache_read, cache_create, cost_usd, turns
    FROM sessions WHERE user_email = ? ORDER BY updated_at DESC LIMIT 100
  `),
  deleteSession: db.prepare(`DELETE FROM sessions WHERE id = ? AND user_email = ?`),
  insertMessage: db.prepare(`INSERT INTO messages (id, session_id, role, content, ts) VALUES (?, ?, ?, ?, ?)`),
  listMessages: db.prepare(`SELECT id, role, content, ts FROM messages WHERE session_id = ? ORDER BY ts ASC`),
  appendAssistant: db.prepare(`UPDATE messages SET content = content || ? WHERE id = ?`),
  addUsage: db.prepare(`
    UPDATE sessions SET
      tokens_in    = tokens_in    + ?,
      tokens_out   = tokens_out   + ?,
      cache_read   = cache_read   + ?,
      cache_create = cache_create + ?,
      cost_usd     = cost_usd     + ?,
      turns        = turns        + 1,
      updated_at   = ?
    WHERE id = ?
  `),
};

export function ensureSession(sid, email, title = "Neuer Chat") {
  const now = Date.now();
  const existing = Q.getSessionRaw.get(sid);
  if (existing) {
    if (existing.user_email !== email) return null;
    Q.touchSession.run(now, sid);
    return existing;
  }
  Q.upsertSession.run(sid, email, title, now, now);
  return Q.getSessionRaw.get(sid);
}

export function setClaudeSessionId(sid, claudeSid) {
  Q.setClaudeSessionId.run(claudeSid, Date.now(), sid);
}

export function updateTitle(sid, email, title) {
  return Q.setTitle.run(title, Date.now(), sid, email);
}

export function updateCwd(sid, email, cwd) {
  return Q.setCwd.run(cwd, Date.now(), sid, email);
}

export function listSessions(email) {
  return Q.listSessions.all(email);
}

export function getSession(sid, email) {
  return Q.getSession.get(sid, email);
}

export function deleteSession(sid, email) {
  return Q.deleteSession.run(sid, email);
}

export function listMessages(sid, email) {
  const s = Q.getSession.get(sid, email);
  if (!s) return null;
  return Q.listMessages.all(sid);
}

export function insertUserMessage(sid, msgId, content) {
  Q.insertMessage.run(msgId, sid, "user", content, Date.now());
}

export function insertAssistantPlaceholder(sid, msgId) {
  Q.insertMessage.run(msgId, sid, "assistant", "", Date.now());
}

export function appendAssistant(msgId, text) {
  Q.appendAssistant.run(text, msgId);
}

export function addUsage(sid, usage) {
  // Use Math.trunc (not `| 0`): bitwise ops clamp to 32-bit signed (~2.1B),
  // which cumulative cache-read tokens can exceed over a long session.
  const int = (x) => Math.trunc(Number(x)) || 0;
  Q.addUsage.run(
    int(usage.tokens_in),
    int(usage.tokens_out),
    int(usage.cache_read),
    int(usage.cache_create),
    Number(usage.cost_usd) || 0,
    Date.now(),
    sid,
  );
}

export function maybeAutoTitle(sid, email, firstUserText) {
  const s = Q.getSession.get(sid, email);
  if (!s) return;
  if (s.title && s.title !== "Neuer Chat") return;
  const t = firstUserText.replace(/\s+/g, " ").trim().slice(0, 48);
  if (t) Q.setTitle.run(t, Date.now(), sid, email);
}
