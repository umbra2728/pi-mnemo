import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType, StatementSync } from "node:sqlite";
import { StaticEmbedder, dot, fromBlob, toBlob } from "./embed.ts";
import { ftsQuery, ftsText } from "./text.ts";

const require = createRequire(import.meta.url);

function loadSqlite(): typeof import("node:sqlite") {
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === "string" ? warning : warning?.message;
    if (text && text.includes("SQLite")) return;
    return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return require("node:sqlite");
  } finally {
    process.emitWarning = original;
  }
}

export const KINDS = ["fact", "preference", "procedure", "pitfall", "decision"] as const;
export type Kind = (typeof KINDS)[number];

export interface Memory {
  id: number;
  text: string;
  kind: Kind;
  scope: "global" | "project";
  project: string | null;
  tags: string;
  ru: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  sessionId: string | null;
}

export interface MemoryHit extends Memory {
  score: number;
  cos: number;
  ftsRank: number | null;
}

export interface SessionHit {
  id: string;
  file: string;
  project: string | null;
  title: string;
  summary: string;
  updatedAt: number;
  score: number;
  cos: number;
  snippets: string[];
}

export interface NewMemory {
  text: string;
  kind: Kind;
  scope: "global" | "project";
  project?: string | null;
  tags?: string;
  ru?: string;
  sessionId?: string | null;
  source?: string;
  enriched?: boolean;
  createdAt?: number;
}

export interface SearchOptions {
  project?: string | null;
  scope?: "all" | "project" | "global";
  kinds?: string[];
  limit?: number;
  excludeIds?: Set<number>;
}

const RRF_K = 60;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories(
  id INTEGER PRIMARY KEY,
  text TEXT NOT NULL,
  kind TEXT NOT NULL,
  scope TEXT NOT NULL,
  project TEXT,
  tags TEXT NOT NULL DEFAULT '',
  ru TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  superseded_by INTEGER,
  source TEXT,
  session_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  last_hit_at INTEGER,
  enriched INTEGER NOT NULL DEFAULT 0,
  vec BLOB
);
CREATE INDEX IF NOT EXISTS memories_status ON memories(status);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(text, tags, ru, tokenize='unicode61 remove_diacritics 0');
CREATE TABLE IF NOT EXISTS sessions(
  id TEXT PRIMARY KEY,
  file TEXT NOT NULL,
  cwd TEXT,
  project TEXT,
  title TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  ru TEXT NOT NULL DEFAULT '',
  started_at INTEGER,
  updated_at INTEGER,
  cursor TEXT,
  indexed_entry TEXT,
  digested_at INTEGER,
  vec BLOB
);
CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(title, summary, ru, tokenize='unicode61 remove_diacritics 0');
CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  role TEXT NOT NULL,
  ts INTEGER,
  text TEXT NOT NULL,
  UNIQUE(session_id, entry_id)
);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, tokenize='unicode61 remove_diacritics 0');
CREATE TABLE IF NOT EXISTS jobs(
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  key TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  run_after INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_pending ON jobs(status, run_after);
CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT);
`;

function rowToMemory(r: Record<string, unknown>): Memory {
  return {
    id: Number(r.id),
    text: String(r.text),
    kind: r.kind as Kind,
    scope: r.scope as "global" | "project",
    project: (r.project as string) ?? null,
    tags: String(r.tags ?? ""),
    ru: String(r.ru ?? ""),
    status: String(r.status),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    sessionId: (r.session_id as string) ?? null,
  };
}

function rrf(rank: number): number {
  return 1 / (RRF_K + rank);
}

export class Store {
  readonly db: DatabaseSyncType;
  embedder: StaticEmbedder | undefined;
  private vecCache: { gen: string; ids: number[]; vecs: Float32Array[]; meta: Map<number, Memory> } | undefined;
  private sessionVecCache: { gen: string; ids: string[]; vecs: Float32Array[] } | undefined;
  private readonly stmts = new Map<string, StatementSync>();

  constructor(dbPath: string, modelDir: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const { DatabaseSync } = loadSqlite();
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=8000; PRAGMA synchronous=NORMAL;");
    this.db.exec(SCHEMA);
    this.embedder = StaticEmbedder.tryLoad(modelDir);
  }

  close(): void {
    this.embedder?.close();
    try {
      this.db.close();
    } catch {}
  }

  stmt(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  attachEmbedder(modelDir: string): boolean {
    const next = StaticEmbedder.tryLoad(modelDir);
    if (!next) return false;
    this.embedder?.close();
    this.embedder = next;
    this.reembedMissing();
    return true;
  }

  reembedMissing(): number {
    const embedder = this.embedder;
    if (!embedder) return 0;
    const mems = this.stmt("SELECT id, text, tags, ru FROM memories WHERE vec IS NULL").all() as { id: number; text: string; tags: string; ru: string }[];
    const sessions = this.stmt("SELECT id, title, summary, ru FROM sessions WHERE vec IS NULL AND digested_at IS NOT NULL").all() as {
      id: string;
      title: string;
      summary: string;
      ru: string;
    }[];
    this.tx(() => {
      for (const m of mems) this.stmt("UPDATE memories SET vec=? WHERE id=?").run(toBlob(embedder.embed(`${m.text}\n${m.tags}\n${m.ru}`)), m.id);
      for (const s of sessions) this.stmt("UPDATE sessions SET vec=? WHERE id=?").run(toBlob(embedder.embed(`${s.title}\n${s.summary}\n${s.ru}`)), s.id);
    });
    if (mems.length) this.bump("mem_gen");
    if (sessions.length) this.bump("sess_gen");
    return mems.length + sessions.length;
  }

  getKv(key: string): string | undefined {
    const r = this.stmt("SELECT value FROM kv WHERE key=?").get(key) as { value: string } | undefined;
    return r?.value;
  }

  setKv(key: string, value: string): void {
    this.stmt("INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }

  private bump(key: string): void {
    this.setKv(key, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  }

  private embedMemory(text: string, tags: string, ru: string): Buffer | null {
    if (!this.embedder) return null;
    return toBlob(this.embedder.embed(`${text}\n${tags}\n${ru}`));
  }

  addMemory(m: NewMemory): number {
    const now = Date.now();
    const tags = m.tags ?? "";
    const ru = m.ru ?? "";
    const r = this.stmt(
      `INSERT INTO memories(text,kind,scope,project,tags,ru,source,session_id,created_at,updated_at,enriched,vec)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(m.text, m.kind, m.scope, m.project ?? null, tags, ru, m.source ?? null, m.sessionId ?? null, m.createdAt ?? now, now, m.enriched ? 1 : 0, this.embedMemory(m.text, tags, ru));
    const id = Number(r.lastInsertRowid);
    this.stmt("INSERT INTO memories_fts(rowid,text,tags,ru) VALUES(?,?,?,?)").run(id, ftsText(m.text), ftsText(tags), ftsText(ru));
    this.bump("mem_gen");
    return id;
  }

  updateMemory(id: number, patch: { text?: string; kind?: Kind; tags?: string; ru?: string; scope?: "global" | "project"; project?: string | null; enriched?: boolean }): boolean {
    const cur = this.getMemory(id);
    if (!cur) return false;
    const next = {
      text: patch.text ?? cur.text,
      kind: patch.kind ?? cur.kind,
      tags: patch.tags ?? cur.tags,
      ru: patch.ru ?? cur.ru,
      scope: patch.scope ?? cur.scope,
      project: patch.project === undefined ? cur.project : patch.project,
    };
    const enriched = patch.enriched === undefined ? undefined : patch.enriched ? 1 : 0;
    this.stmt(
      `UPDATE memories SET text=?,kind=?,tags=?,ru=?,scope=?,project=?,updated_at=?,vec=?,enriched=COALESCE(?,enriched) WHERE id=?`,
    ).run(next.text, next.kind, next.tags, next.ru, next.scope, next.project, Date.now(), this.embedMemory(next.text, next.tags, next.ru), enriched ?? null, id);
    this.stmt("DELETE FROM memories_fts WHERE rowid=?").run(id);
    this.stmt("INSERT INTO memories_fts(rowid,text,tags,ru) VALUES(?,?,?,?)").run(id, ftsText(next.text), ftsText(next.tags), ftsText(next.ru));
    this.bump("mem_gen");
    return true;
  }

  setStatus(id: number, status: "active" | "superseded" | "deleted", supersededBy?: number): boolean {
    const r = this.stmt("UPDATE memories SET status=?, superseded_by=?, updated_at=? WHERE id=?").run(status, supersededBy ?? null, Date.now(), id);
    this.bump("mem_gen");
    return Number(r.changes) > 0;
  }

  getMemory(id: number): Memory | undefined {
    const r = this.stmt("SELECT * FROM memories WHERE id=?").get(id) as Record<string, unknown> | undefined;
    return r ? rowToMemory(r) : undefined;
  }

  getMemories(ids: number[]): Memory[] {
    return ids.map((id) => this.getMemory(id)).filter((m): m is Memory => !!m);
  }

  countMemories(): { active: number; total: number; unenriched: number } {
    const r = this.stmt(
      "SELECT SUM(status='active') active, COUNT(*) total, SUM(status='active' AND enriched=0) unenriched FROM memories",
    ).get() as Record<string, number>;
    return { active: Number(r.active ?? 0), total: Number(r.total ?? 0), unenriched: Number(r.unenriched ?? 0) };
  }

  noteHits(ids: number[]): void {
    const now = Date.now();
    for (const id of ids) this.stmt("UPDATE memories SET hits=hits+1, last_hit_at=? WHERE id=?").run(now, id);
  }

  private memVectors() {
    const gen = this.getKv("mem_gen") ?? "0";
    if (this.vecCache?.gen === gen) return this.vecCache;
    const rows = this.stmt("SELECT * FROM memories WHERE status='active'").all() as Record<string, unknown>[];
    const ids: number[] = [];
    const vecs: Float32Array[] = [];
    const meta = new Map<number, Memory>();
    for (const r of rows) {
      const m = rowToMemory(r);
      meta.set(m.id, m);
      if (r.vec) {
        ids.push(m.id);
        vecs.push(fromBlob(r.vec as Uint8Array));
      }
    }
    this.vecCache = { gen, ids, vecs, meta };
    return this.vecCache;
  }

  searchMemories(queries: string[], opts: SearchOptions = {}): MemoryHit[] {
    const cache = this.memVectors();
    const limit = opts.limit ?? 8;
    const fused = new Map<number, { score: number; cos: number; ftsRank: number | null }>();
    const allowed = (m: Memory | undefined) => {
      if (!m) return false;
      if (opts.excludeIds?.has(m.id)) return false;
      if (opts.kinds?.length && !opts.kinds.includes(m.kind)) return false;
      if (opts.scope === "global" && m.scope !== "global") return false;
      if (opts.scope === "project" && (m.scope !== "project" || m.project !== opts.project)) return false;
      return true;
    };
    for (const q of queries) {
      const match = ftsQuery(q);
      const ftsRanks = new Map<number, number>();
      if (match) {
        const rows = this.stmt(
          "SELECT rowid id FROM memories_fts WHERE memories_fts MATCH ? ORDER BY bm25(memories_fts, 0.5, 1.0, 1.0) LIMIT 60",
        ).all(match) as { id: number }[];
        let rank = 0;
        for (const r of rows) {
          const id = Number(r.id);
          if (!allowed(cache.meta.get(id))) continue;
          ftsRanks.set(id, ++rank);
        }
      }
      const cosById = new Map<number, number>();
      if (this.embedder) {
        const qv = this.embedder.embed(q);
        const scored: [number, number][] = [];
        for (let i = 0; i < cache.ids.length; i++) {
          const id = cache.ids[i];
          if (!allowed(cache.meta.get(id))) continue;
          scored.push([id, dot(qv, cache.vecs[i])]);
        }
        scored.sort((a, b) => b[1] - a[1]);
        scored.forEach(([id, c], i) => {
          cosById.set(id, c);
          if (i < 60) {
            const f = fused.get(id) ?? { score: 0, cos: -1, ftsRank: null };
            f.score += rrf(i + 1);
            fused.set(id, f);
          }
        });
      }
      for (const [id, rank] of ftsRanks) {
        const f = fused.get(id) ?? { score: 0, cos: -1, ftsRank: null };
        f.score += rrf(rank);
        f.ftsRank = f.ftsRank === null ? rank : Math.min(f.ftsRank, rank);
        fused.set(id, f);
      }
      for (const [id, f] of fused) f.cos = Math.max(f.cos, cosById.get(id) ?? -1);
    }
    const out: MemoryHit[] = [];
    for (const [id, f] of fused) {
      const m = cache.meta.get(id);
      if (!m) continue;
      let score = f.score / queries.length;
      if (opts.project && m.scope === "project") score *= m.project === opts.project ? 1.15 : 0.85;
      out.push({ ...m, score, cos: f.cos, ftsRank: f.ftsRank });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, limit);
  }

  upsertSession(s: { id: string; file: string; cwd?: string | null; project?: string | null; startedAt?: number | null }): void {
    this.stmt(
      `INSERT INTO sessions(id,file,cwd,project,started_at,updated_at) VALUES(?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET file=excluded.file, cwd=COALESCE(excluded.cwd,cwd), project=COALESCE(excluded.project,project)`,
    ).run(s.id, s.file, s.cwd ?? null, s.project ?? null, s.startedAt ?? null, Date.now());
  }

  getSession(id: string): Record<string, unknown> | undefined {
    return this.stmt("SELECT * FROM sessions WHERE id=?").get(id) as Record<string, unknown> | undefined;
  }

  setSessionCursor(id: string, cursor: string): void {
    this.stmt("UPDATE sessions SET cursor=? WHERE id=?").run(cursor, id);
  }

  setSessionIndexed(id: string, entry: string): void {
    this.stmt("UPDATE sessions SET indexed_entry=? WHERE id=?").run(entry, id);
  }

  setSessionDigest(id: string, d: { title: string; summary: string; ru: string; updatedAt?: number }): void {
    const vec = this.embedder ? toBlob(this.embedder.embed(`${d.title}\n${d.summary}\n${d.ru}`)) : null;
    const row = this.stmt("SELECT rowid FROM sessions WHERE id=?").get(id) as { rowid: number } | undefined;
    if (!row) return;
    this.stmt("UPDATE sessions SET title=?, summary=?, ru=?, digested_at=?, updated_at=COALESCE(?,updated_at), vec=? WHERE id=?").run(
      d.title,
      d.summary,
      d.ru,
      Date.now(),
      d.updatedAt ?? null,
      vec,
      id,
    );
    this.stmt("DELETE FROM sessions_fts WHERE rowid=?").run(row.rowid);
    this.stmt("INSERT INTO sessions_fts(rowid,title,summary,ru) VALUES(?,?,?,?)").run(row.rowid, ftsText(d.title), ftsText(d.summary), ftsText(d.ru));
    this.bump("sess_gen");
  }

  addMessage(m: { sessionId: string; entryId: string; role: string; ts: number; text: string }): void {
    const r = this.stmt("INSERT OR IGNORE INTO messages(session_id,entry_id,role,ts,text) VALUES(?,?,?,?,?)").run(m.sessionId, m.entryId, m.role, m.ts, m.text);
    if (Number(r.changes) > 0) this.stmt("INSERT INTO messages_fts(rowid,text) VALUES(?,?)").run(Number(r.lastInsertRowid), ftsText(m.text));
  }

  private sessionVectors() {
    const gen = this.getKv("sess_gen") ?? "0";
    if (this.sessionVecCache?.gen === gen) return this.sessionVecCache;
    const rows = this.stmt("SELECT id, vec FROM sessions WHERE vec IS NOT NULL").all() as { id: string; vec: Uint8Array }[];
    this.sessionVecCache = { gen, ids: rows.map((r) => r.id), vecs: rows.map((r) => fromBlob(r.vec)) };
    return this.sessionVecCache;
  }

  searchSessions(queries: string[], opts: { limit?: number; project?: string | null } = {}): SessionHit[] {
    const limit = opts.limit ?? 4;
    const fused = new Map<string, { score: number; cos: number; snippets: string[] }>();
    const get = (id: string) => {
      let f = fused.get(id);
      if (!f) {
        f = { score: 0, cos: -1, snippets: [] };
        fused.set(id, f);
      }
      return f;
    };
    const vecs = this.sessionVectors();
    for (const q of queries) {
      const match = ftsQuery(q);
      if (match) {
        const rows = this.stmt(
          `SELECT s.id id FROM sessions_fts f JOIN sessions s ON s.rowid=f.rowid WHERE sessions_fts MATCH ? ORDER BY bm25(sessions_fts, 1.0, 1.0, 0.7) LIMIT 30`,
        ).all(match) as { id: string }[];
        rows.forEach((r, i) => (get(r.id).score += rrf(i + 1)));
        const msgs = this.stmt(
          `SELECT m.session_id sid, m.role role, m.text text FROM messages_fts f JOIN messages m ON m.id=f.rowid WHERE messages_fts MATCH ? ORDER BY bm25(messages_fts) LIMIT 40`,
        ).all(match) as { sid: string; role: string; text: string }[];
        const seen = new Map<string, number>();
        for (const m of msgs) {
          if (!seen.has(m.sid)) seen.set(m.sid, seen.size + 1);
          const f = get(m.sid);
          if (f.snippets.length < 2) f.snippets.push(`${m.role}: ${m.text.replace(/\s+/g, " ").slice(0, 240)}`);
        }
        for (const [sid, rank] of seen) get(sid).score += 0.5 * rrf(rank);
      }
      if (this.embedder && vecs.ids.length) {
        const qv = this.embedder.embed(q);
        const scored = vecs.ids.map((id, i) => [id, dot(qv, vecs.vecs[i])] as [string, number]);
        scored.sort((a, b) => b[1] - a[1]);
        scored.slice(0, 30).forEach(([id, c], i) => {
          const f = get(id);
          f.score += rrf(i + 1);
          f.cos = Math.max(f.cos, c);
        });
      }
    }
    const out: SessionHit[] = [];
    for (const [id, f] of fused) {
      const s = this.getSession(id);
      if (!s) continue;
      let score = f.score / queries.length;
      if (opts.project && s.project === opts.project) score *= 1.1;
      out.push({
        id,
        file: String(s.file),
        project: (s.project as string) ?? null,
        title: String(s.title ?? ""),
        summary: String(s.summary ?? ""),
        updatedAt: Number(s.updated_at ?? s.started_at ?? 0),
        score,
        cos: f.cos,
        snippets: f.snippets,
      });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, limit);
  }

  enqueueJob(kind: string, payload: unknown, opts: { key?: string; delayMs?: number } = {}): void {
    const now = Date.now();
    const runAfter = now + (opts.delayMs ?? 0);
    if (opts.key) {
      const existing = this.stmt("SELECT id FROM jobs WHERE key=? AND status='pending'").get(opts.key) as { id: number } | undefined;
      if (existing) {
        this.stmt("UPDATE jobs SET payload=?, run_after=MIN(run_after, ?), updated_at=? WHERE id=?").run(JSON.stringify(payload), runAfter, now, existing.id);
        return;
      }
    }
    this.stmt("INSERT INTO jobs(kind,key,payload,run_after,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(kind, opts.key ?? null, JSON.stringify(payload), runAfter, now, now);
  }

  claimJob(leaseMs: number, kinds?: string[]): { id: number; kind: string; payload: any; attempts: number } | undefined {
    const now = Date.now();
    return this.tx(() => {
      const kindFilter = kinds?.length ? `AND kind IN (${kinds.map(() => "?").join(",")})` : "";
      const row = this.stmt(
        `SELECT id, kind, payload, attempts FROM jobs WHERE ((status='pending' AND run_after<=?) OR (status='running' AND lease_until<?)) ${kindFilter} ORDER BY run_after LIMIT 1`,
      ).get(now, now, ...(kinds ?? [])) as { id: number; kind: string; payload: string; attempts: number } | undefined;
      if (!row) return undefined;
      this.stmt("UPDATE jobs SET status='running', lease_until=?, attempts=attempts+1, updated_at=? WHERE id=?").run(now + leaseMs, now, row.id);
      return { id: Number(row.id), kind: row.kind, payload: JSON.parse(row.payload), attempts: Number(row.attempts) + 1 };
    });
  }

  finishJob(id: number): void {
    this.stmt("DELETE FROM jobs WHERE id=?").run(id);
  }

  failJob(id: number, error: string, retryInMs: number | null): void {
    const now = Date.now();
    if (retryInMs === null) {
      this.stmt("UPDATE jobs SET status='failed', error=?, updated_at=? WHERE id=?").run(error.slice(0, 2000), now, id);
    } else {
      this.stmt("UPDATE jobs SET status='pending', error=?, run_after=?, lease_until=0, updated_at=? WHERE id=?").run(error.slice(0, 2000), now + retryInMs, now, id);
    }
  }

  jobStats(): Record<string, number> {
    const rows = this.stmt("SELECT kind||':'||status k, COUNT(*) n FROM jobs GROUP BY 1").all() as { k: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.k, Number(r.n)]));
  }
}
