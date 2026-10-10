import { completeJson, type Registry } from "./llm.ts";
import { buildSlice, chunkLines, condenseForDigest, conversationText, entriesAfter, readEntries, renderLines, sessionHeader } from "./session.ts";
import { KINDS, type Kind, type Memory, type Store } from "./store.ts";
import { contentStems, redact } from "./text.ts";

const SIGNAL = /(запомни|помни|всегда|никогда|не делай|не надо|перестань|предпочитаю|мне нравится|мне не нравится|я хочу чтобы|неправильно|не так|исправь|ошибся|remember|always|never|don't|do not|prefer|stop doing|wrong)/i;

const RU_FIELD =
  'ru: one line of Russian search keywords (8-15 words or short phrases: how a Russian-speaking user would name this topic, synonyms, colloquial terms) followed by a short Russian paraphrase. It is a hidden search index, never shown to the agent.';

const EXTRACT_SYSTEM = `You maintain the long-term memory of a coding agent that works for one developer across many sessions and projects.
You receive a new slice of a session transcript plus existing memories that may overlap. Decide what durable knowledge to save.

SAVE only knowledge that will help in FUTURE sessions:
- user preferences, standing instructions and corrections of the agent's behaviour
- environment/infrastructure facts: machines, hosts (described without secrets), paths, versions, installed tools, how things are wired
- project conventions, architecture and technology decisions with the reason
- pitfalls: what failed, the root cause and the working fix
- procedures that worked after trial and error (short numbered steps with concrete commands)

DO NOT SAVE: task progress or status, one-off details, things obvious from reading the code, speculation, anything already covered by an existing memory, secrets (tokens, passwords, keys, private URLs with credentials).
Most slices produce zero or one memory. Quality over quantity.

Rules for each memory:
- text: English, self-contained, concrete (names, paths, commands, versions). No "the user just", no "in this session". Max 400 chars; procedures max 900 chars.
- kind: one of ${KINDS.join(", ")}
- scope: "project" when specific to the current project, else "global"
- tags: 5-12 English keywords and synonyms
- ${RU_FIELD}
- If an existing memory covers the same subject, use "update" (rewrite it, merged) instead of "add". If new information contradicts an existing memory, use "supersede".

Also maintain a digest of the whole session: title (max 80 chars, English), summary (2-4 sentences English: what was done, decisions, outcome), ru (Russian keywords + one-sentence Russian summary). Update the previous digest with the new slice.

Reply with JSON only:
{"ops":[{"op":"add","kind":"...","scope":"...","text":"...","tags":["..."],"ru":"..."},{"op":"update","id":1,"text":"...","tags":["..."],"ru":"..."},{"op":"supersede","id":2,"kind":"...","scope":"...","text":"...","tags":["..."],"ru":"..."}],"digest":{"title":"...","summary":"...","ru":"..."}}`;

const DIGEST_SYSTEM = `You index past sessions of a coding agent for later search.
Given a condensed transcript, write a digest. Reply with JSON only:
{"title":"max 80 chars, English","summary":"2-4 sentences in English: what was done, key decisions, outcome, notable tools/hosts/projects","ru":"Russian search keywords (8-15 words/phrases) and a one-sentence Russian summary"}`;

const ENRICH_SYSTEM = `You index memory entries of a coding agent for search. For EACH entry produce:
- tags: 5-12 English keywords and synonyms (topics, concepts, likely intents), not just words copied from the text
- ${RU_FIELD}
Reply with JSON only: [{"id":1,"tags":["..."],"ru":"..."}]`;

interface Op {
  op: "add" | "update" | "supersede" | "delete";
  id?: number;
  kind?: string;
  scope?: string;
  text?: string;
  tags?: string[] | string;
  ru?: string;
}

function normKind(k: unknown, fallback: Kind = "fact"): Kind {
  return (KINDS as readonly string[]).includes(String(k)) ? (k as Kind) : fallback;
}

function normTags(t: unknown): string {
  if (Array.isArray(t)) return t.map(String).join(", ");
  return typeof t === "string" ? t : "";
}

export interface WriterContext {
  store: Store;
  registry: Registry;
  signal?: AbortSignal;
  log?: (msg: string) => void;
}

export interface CheckpointPayload {
  sessionId: string;
  file: string;
  project: string | null;
}

function similarMemories(store: Store, slice: string, project: string | null): Memory[] {
  const userish = slice.split("\n").filter((l) => l.startsWith("[USER]") || l.startsWith("[ERROR]") || l.startsWith("[AGENT]"));
  const queries = [userish.join("\n").slice(0, 3000), userish.slice(-6).join("\n").slice(0, 1500)].filter((q) => contentStems(q).length > 0);
  if (!queries.length) return [];
  return store.searchMemories(queries, { project, limit: 12 });
}

export function applyOps(store: Store, ops: Op[], ctx: { project: string | null; sessionId: string | null; allowedIds: Set<number> }): { added: number; updated: number; superseded: number } {
  const stats = { added: 0, updated: 0, superseded: 0 };
  for (const op of ops) {
    const text = op.text ? redact(String(op.text)).trim() : "";
    const scope = op.scope === "project" && ctx.project ? "project" : "global";
    const project = scope === "project" ? ctx.project : null;
    if (op.op === "add" && text) {
      store.addMemory({ text, kind: normKind(op.kind), scope, project, tags: normTags(op.tags), ru: String(op.ru ?? ""), sessionId: ctx.sessionId, source: "checkpoint", enriched: true });
      stats.added++;
    } else if (op.op === "update" && op.id && ctx.allowedIds.has(op.id)) {
      store.updateMemory(op.id, {
        text: text || undefined,
        kind: op.kind ? normKind(op.kind) : undefined,
        tags: op.tags ? normTags(op.tags) : undefined,
        ru: op.ru ? String(op.ru) : undefined,
        enriched: true,
      });
      stats.updated++;
    } else if (op.op === "supersede" && op.id && ctx.allowedIds.has(op.id) && text) {
      const old = store.getMemory(op.id);
      const id = store.addMemory({
        text,
        kind: normKind(op.kind, old?.kind ?? "fact"),
        scope,
        project,
        tags: normTags(op.tags),
        ru: String(op.ru ?? ""),
        sessionId: ctx.sessionId,
        source: "checkpoint",
        enriched: true,
      });
      store.setStatus(op.id, "superseded", id);
      stats.superseded++;
    }
  }
  return stats;
}

export function indexMessages(store: Store, sessionId: string, entries: ReturnType<typeof readEntries>, after: string | null | undefined): string | undefined {
  const fresh = entriesAfter(entries, after);
  const msgs = conversationText(fresh);
  if (msgs.length) store.tx(() => msgs.forEach((m) => store.addMessage({ sessionId, ...m })));
  return fresh.length ? fresh[fresh.length - 1].id : after ?? undefined;
}

export async function runCheckpoint(w: WriterContext, p: CheckpointPayload): Promise<string> {
  const { store } = w;
  const entries = readEntries(p.file);
  if (!entries.length) return "empty session file";
  const header = sessionHeader(entries);
  store.upsertSession({ id: p.sessionId, file: p.file, cwd: header.cwd, project: p.project, startedAt: header.startedAt });
  const row = store.getSession(p.sessionId)!;
  const indexed = indexMessages(store, p.sessionId, entries, row.indexed_entry as string | null);
  if (indexed) store.setSessionIndexed(p.sessionId, indexed);

  const fresh = entriesAfter(entries, row.cursor as string | null);
  const slice = buildSlice(fresh);
  if (!slice.lastEntryId) return "nothing new";
  const userText = slice.lines.filter((l) => l.role === "user").map((l) => l.text).join("\n");
  const trivial = slice.toolCalls === 0 && slice.chars < 1500 && !SIGNAL.test(userText);
  if (trivial) {
    store.setSessionCursor(p.sessionId, slice.lastEntryId);
    return "trivial slice skipped";
  }
  let digest = { title: String(row.title ?? ""), summary: String(row.summary ?? ""), ru: String(row.ru ?? "") };
  const totals = { added: 0, updated: 0, superseded: 0 };
  for (const chunk of chunkLines(slice.lines, 28000)) {
    const rendered = renderLines(chunk);
    const similar = similarMemories(store, rendered, p.project);
    const allowedIds = new Set(similar.map((m) => m.id));
    const user = [
      `Current project: ${p.project ?? "(none, home directory)"}`,
      `Previous session digest: ${digest.title ? JSON.stringify(digest) : "(none yet)"}`,
      "Existing related memories:",
      similar.length ? similar.map((m) => `#${m.id} [${m.kind}, ${m.scope}${m.project ? `:${m.project}` : ""}] ${m.text}`).join("\n") : "(none)",
      "",
      "New transcript slice:",
      rendered,
    ].join("\n");
    const res = await completeJson<{ ops?: Op[]; digest?: typeof digest }>(w.registry, EXTRACT_SYSTEM, user, { signal: w.signal, maxTokens: 6000 });
    const s = applyOps(store, Array.isArray(res.value.ops) ? res.value.ops : [], { project: p.project, sessionId: p.sessionId, allowedIds });
    totals.added += s.added;
    totals.updated += s.updated;
    totals.superseded += s.superseded;
    if (res.value.digest?.summary) digest = { title: String(res.value.digest.title ?? ""), summary: String(res.value.digest.summary), ru: String(res.value.digest.ru ?? "") };
  }
  if (digest.summary) store.setSessionDigest(p.sessionId, { ...digest, updatedAt: Date.now() });
  store.setSessionCursor(p.sessionId, slice.lastEntryId);
  return `+${totals.added} ~${totals.updated} ⇄${totals.superseded}`;
}

export async function runDigest(w: WriterContext, p: { sessionId: string; file: string; project: string | null }): Promise<string> {
  const { store } = w;
  const entries = readEntries(p.file);
  if (!entries.length) return "empty";
  const header = sessionHeader(entries);
  store.upsertSession({ id: p.sessionId, file: p.file, cwd: header.cwd, project: p.project, startedAt: header.startedAt });
  const row = store.getSession(p.sessionId)!;
  const indexed = indexMessages(store, p.sessionId, entries, row.indexed_entry as string | null);
  if (indexed) store.setSessionIndexed(p.sessionId, indexed);
  const slice = buildSlice(entries, { includeTools: true });
  if (slice.userChars < 20) {
    if (slice.lastEntryId) store.setSessionCursor(p.sessionId, slice.lastEntryId);
    return "no user content";
  }
  const lastTs = entries.reduce((m, e) => Math.max(m, e.timestamp ? Date.parse(e.timestamp) : 0), 0);
  const res = await completeJson<{ title?: string; summary?: string; ru?: string }>(
    w.registry,
    DIGEST_SYSTEM,
    `Project: ${p.project ?? "(none)"}\n\n${condenseForDigest(slice.lines, 24000)}`,
    { signal: w.signal, maxTokens: 1500 },
  );
  if (res.value.summary) store.setSessionDigest(p.sessionId, { title: String(res.value.title ?? ""), summary: String(res.value.summary), ru: String(res.value.ru ?? ""), updatedAt: lastTs || undefined });
  if (slice.lastEntryId && !row.cursor) store.setSessionCursor(p.sessionId, slice.lastEntryId);
  return "digested";
}

export async function runEnrich(w: WriterContext, p: { ids?: number[] }): Promise<string> {
  const { store } = w;
  const ids =
    p.ids ??
    (store.db.prepare("SELECT id FROM memories WHERE status='active' AND enriched=0 ORDER BY id LIMIT 25").all() as { id: number }[]).map((r) => Number(r.id));
  const mems = store.getMemories(ids).filter((m) => m.status === "active");
  if (!mems.length) return "nothing to enrich";
  const res = await completeJson<{ id: number; tags?: unknown; ru?: string }[]>(
    w.registry,
    ENRICH_SYSTEM,
    JSON.stringify(mems.map((m) => ({ id: m.id, text: m.text.slice(0, 1500) }))),
    { signal: w.signal, maxTokens: 8000 },
  );
  const pending = new Set(mems.map((m) => m.id));
  for (const r of Array.isArray(res.value) ? res.value : []) {
    const id = Number(r.id);
    if (!pending.has(id)) continue;
    store.updateMemory(id, { tags: normTags(r.tags), ru: String(r.ru ?? ""), enriched: true });
    pending.delete(id);
  }
  for (const id of pending) store.updateMemory(id, { enriched: true });
  return `enriched ${mems.length - pending.size}/${mems.length}`;
}
