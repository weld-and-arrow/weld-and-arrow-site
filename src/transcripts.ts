import { DurableObject } from "cloudflare:workers";
import type { Env, SessionAppend } from "./types";

const SESSION_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomSessionId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const chars = Array.from(bytes, (byte) => SESSION_ALPHABET[byte % SESSION_ALPHABET.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

function snippet(content: string, q?: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (!q) return normalized.slice(0, 180);
  const index = normalized.toLowerCase().indexOf(q.toLowerCase());
  if (index === -1) return normalized.slice(0, 180);
  const start = Math.max(0, index - 70);
  return normalized.slice(start, start + 180);
}

export interface TranscriptSearch {
  q?: string;
  fromTs?: number;
  toTs?: number;
  sessionId?: string;
}

export class TranscriptDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        created_ts INTEGER NOT NULL,
        consent_ts INTEGER NOT NULL,
        notice_version TEXT NOT NULL,
        commit_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        model TEXT,
        usage_json TEXT,
        FOREIGN KEY(session_id) REFERENCES sessions(id)
      );
      CREATE INDEX IF NOT EXISTS messages_session_ts_idx ON messages(session_id, ts);
      CREATE INDEX IF NOT EXISTS messages_ts_idx ON messages(ts);
    `);
  }

  createSession(consentTs: number, noticeVersion: string, commitHash: string): { sessionId: string } {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const sessionId = randomSessionId();
      try {
        this.ctx.storage.sql.exec(
          "INSERT INTO sessions (id, created_ts, consent_ts, notice_version, commit_hash) VALUES (?, ?, ?, ?, ?)",
          sessionId,
          Date.now(),
          consentTs,
          noticeVersion,
          commitHash
        );
        return { sessionId };
      } catch (error) {
        if (attempt === 11) throw error;
      }
    }
    throw new Error("Could not allocate a session ID");
  }

  hasSession(sessionId: string): boolean {
    const row = this.ctx.storage.sql.exec<{ id: string }>("SELECT id FROM sessions WHERE id = ?", sessionId).toArray()[0];
    return Boolean(row);
  }

  append(entries: SessionAppend[]): { inserted: number } {
    let inserted = 0;
    for (const entry of entries) {
      this.ctx.storage.sql.exec(
        "INSERT INTO messages (session_id, ts, role, content, model, usage_json) VALUES (?, ?, ?, ?, ?, ?)",
        entry.sessionId,
        entry.ts ?? Date.now(),
        entry.role,
        entry.content,
        entry.model ?? null,
        entry.usage ? JSON.stringify(entry.usage) : null
      );
      inserted += 1;
    }
    return { inserted };
  }

  search(query: TranscriptSearch) {
    const clauses: string[] = [];
    const params: (string | number)[] = [];

    if (query.sessionId) {
      clauses.push("s.id = ?");
      params.push(query.sessionId);
    }
    if (query.fromTs) {
      clauses.push("m.ts >= ?");
      params.push(query.fromTs);
    }
    if (query.toTs) {
      clauses.push("m.ts <= ?");
      params.push(query.toTs);
    }
    if (query.q) {
      clauses.push("m.content LIKE ?");
      params.push(`%${query.q.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.ctx.storage.sql
      .exec<{
        session_id: string;
        created_ts: number;
        consent_ts: number;
        notice_version: string;
        commit_hash: string;
        message_ts: number;
        role: string;
        content: string;
      }>(
        `SELECT s.id AS session_id, s.created_ts, s.consent_ts, s.notice_version, s.commit_hash,
                m.ts AS message_ts, m.role, m.content
         FROM sessions s
         JOIN messages m ON m.session_id = s.id
         ${where}
         ORDER BY m.ts DESC
         LIMIT 100`,
        ...params
      )
      .toArray();

    const sessions = new Map<string, {
      sessionId: string;
      createdTs: number;
      consentTs: number;
      noticeVersion: string;
      commitHash: string;
      matches: { ts: number; role: string; snippet: string }[];
    }>();

    for (const row of rows) {
      if (!sessions.has(row.session_id)) {
        sessions.set(row.session_id, {
          sessionId: row.session_id,
          createdTs: row.created_ts,
          consentTs: row.consent_ts,
          noticeVersion: row.notice_version,
          commitHash: row.commit_hash,
          matches: []
        });
      }
      const session = sessions.get(row.session_id);
      session?.matches.push({
        ts: row.message_ts,
        role: row.role,
        snippet: snippet(row.content, query.q)
      });
    }

    return { sessions: Array.from(sessions.values()) };
  }

  deleteSessions(ids: string[]): { deletedSessions: number } {
    let deleted = 0;
    for (const id of ids) {
      this.ctx.storage.sql.exec("DELETE FROM messages WHERE session_id = ?", id);
      const before = this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM sessions WHERE id = ?", id).toArray()[0]?.count ?? 0;
      this.ctx.storage.sql.exec("DELETE FROM sessions WHERE id = ?", id);
      deleted += before;
    }
    return { deletedSessions: deleted };
  }

  purgeOlderThan(retentionDays: number, nowMs = Date.now()): { deletedSessions: number } {
    const cutoff = nowMs - retentionDays * 24 * 60 * 60 * 1000;
    const rows = this.ctx.storage.sql.exec<{ id: string }>("SELECT id FROM sessions WHERE created_ts < ?", cutoff).toArray();
    return this.deleteSessions(rows.map((row) => row.id));
  }
}
