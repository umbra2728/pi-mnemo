import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectFor } from "./project.ts";
import { sessionHeader, type SessionEntry } from "./session.ts";
import type { Kind, Store } from "./store.ts";
import { redact } from "./text.ts";

interface HermesEntry {
  text: string;
  kind: Kind;
  scope: "global" | "project";
  project: string | null;
  createdAt?: number;
  origin: string;
}

const CATEGORY_KIND: Record<string, Kind> = {
  failure: "pitfall",
  "tool-quirk": "pitfall",
  correction: "preference",
  preference: "preference",
  convention: "decision",
  insight: "fact",
};

function splitEntries(file: string): { text: string; createdAt?: number }[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("§")
    .map((raw) => {
      const created = raw.match(/created=(\d{4}-\d{2}-\d{2})/);
      const text = raw.replace(/<!--[\s\S]*?-->/g, "").trim();
      return { text, createdAt: created ? Date.parse(created[1]) : undefined };
    })
    .filter((e) => e.text.length > 30);
}

export function readHermes(root = path.join(os.homedir(), ".pi/agent")): HermesEntry[] {
  const out: HermesEntry[] = [];
  const base = path.join(root, "pi-hermes-memory");
  for (const e of splitEntries(path.join(base, "MEMORY.md"))) out.push({ ...e, kind: "fact", scope: "global", project: null, origin: "MEMORY.md" });
  for (const e of splitEntries(path.join(base, "USER.md"))) out.push({ ...e, kind: "preference", scope: "global", project: null, origin: "USER.md" });
  for (const e of splitEntries(path.join(base, "failures.md"))) {
    const cat = e.text.match(/^\[([a-z-]+)\]\s*/);
    out.push({ text: cat ? e.text.slice(cat[0].length) : e.text, createdAt: e.createdAt, kind: CATEGORY_KIND[cat?.[1] ?? "failure"] ?? "pitfall", scope: "global", project: null, origin: "failures.md" });
  }
  const projDir = path.join(root, "projects-memory");
  if (fs.existsSync(projDir)) {
    for (const name of fs.readdirSync(projDir)) {
      const dir = path.join(projDir, name);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".md"))) {
        const kind: Kind = f.startsWith("USER") ? "preference" : f.startsWith("failures") ? "pitfall" : "fact";
        for (const e of splitEntries(path.join(dir, f))) out.push({ ...e, kind, scope: "project", project: name, origin: `projects-memory/${name}/${f}` });
      }
    }
  }
  const skillsDir = path.join(base, "skills");
  if (fs.existsSync(skillsDir)) {
    for (const name of fs.readdirSync(skillsDir)) {
      const file = path.join(skillsDir, name, "SKILL.md");
      if (!fs.existsSync(file)) continue;
      const body = fs.readFileSync(file, "utf8").replace(/^---[\s\S]*?---\s*/, "");
      const desc = fs.readFileSync(file, "utf8").match(/description:\s*(.+)/)?.[1] ?? "";
      out.push({ text: `Procedure "${name}": ${desc}\n${body}`.slice(0, 3500).trim(), kind: "procedure", scope: "global", project: null, origin: `skill:${name}` });
    }
  }
  return out;
}

function matchKey(text: string): string {
  return text.replace(/^\[[a-z-]+\]\s*/, "").replace(/\s+/g, " ").trim().slice(0, 200);
}

export function importHermes(store: Store, opts: { enrichmentFile?: string } = {}): { imported: number; reusedEnrichment: number; skipped: number } {
  if (store.getKv("hermes_imported")) return { imported: 0, reusedEnrichment: 0, skipped: -1 };
  const entries = readHermes();
  const enrichment = new Map<string, { summary?: string; tags?: string[] }>();
  if (opts.enrichmentFile && fs.existsSync(opts.enrichmentFile)) {
    for (const d of JSON.parse(fs.readFileSync(opts.enrichmentFile, "utf8"))) if (d.tags) enrichment.set(matchKey(d.text), d);
  }
  const cyr = /[а-яё]/i;
  let reused = 0;
  let skipped = 0;
  const seen = new Set<string>();
  store.tx(() => {
    for (const e of entries) {
      const key = e.text.replace(/\s+/g, " ").toLowerCase();
      if (seen.has(key)) {
        skipped++;
        continue;
      }
      seen.add(key);
      const enr = enrichment.get(matchKey(e.text));
      const tags = enr?.tags ?? [];
      if (enr) reused++;
      store.addMemory({
        text: redact(e.text),
        kind: e.kind,
        scope: e.scope,
        project: e.project,
        tags: tags.filter((t) => !cyr.test(t)).join(", "),
        ru: enr ? [enr.summary ?? "", tags.filter((t) => cyr.test(t)).join(", ")].join("\n") : "",
        source: `hermes:${e.origin}`,
        createdAt: e.createdAt,
        enriched: !!enr,
      });
    }
    store.setKv("hermes_imported", new Date().toISOString());
  });
  return { imported: seen.size, reusedEnrichment: reused, skipped };
}

function firstEntries(file: string): SessionEntry[] {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(16384);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const out: SessionEntry[] = [];
    for (const line of buf.subarray(0, n).toString("utf8").split("\n").slice(0, 2)) {
      try {
        out.push(JSON.parse(line));
      } catch {}
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

export function enqueueBackfill(store: Store, opts: { sessionsDir?: string; excludeId?: string } = {}): number {
  const dir = opts.sessionsDir ?? path.join(os.homedir(), ".pi/agent/sessions");
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const sub of fs.readdirSync(dir)) {
    const subDir = path.join(dir, sub);
    if (!fs.statSync(subDir).isDirectory()) continue;
    for (const f of fs.readdirSync(subDir).filter((x) => x.endsWith(".jsonl"))) {
      const file = path.join(subDir, f);
      const id = f.match(/_([0-9a-f-]{36})\.jsonl$/)?.[1];
      if (!id || id === opts.excludeId) continue;
      const existing = store.getSession(id);
      if (existing?.digested_at) continue;
      const head = firstEntries(file);
      const cwd = sessionHeader(head).cwd ?? null;
      store.upsertSession({ id, file, cwd, project: projectFor(cwd), startedAt: sessionHeader(head).startedAt });
      store.enqueueJob("digest", { sessionId: id, file, project: projectFor(cwd) }, { key: `digest:${id}` });
      n++;
    }
  }
  return n;
}

export function enqueueEnrichAll(store: Store, batch = 25): number {
  const ids = (store.db.prepare("SELECT id FROM memories WHERE status='active' AND enriched=0 ORDER BY id").all() as { id: number }[]).map((r) => Number(r.id));
  for (let i = 0; i < ids.length; i += batch) {
    const chunk = ids.slice(i, i + batch);
    store.enqueueJob("enrich", { ids: chunk }, { key: `enrich:${chunk[0]}-${chunk[chunk.length - 1]}` });
  }
  return ids.length;
}
