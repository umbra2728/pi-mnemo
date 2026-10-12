import type { MemoryHit, Store } from "./store.ts";
import { isTrivialPrompt, recallQueryFromPrompt } from "./text.ts";

export const GATE = {
  strongCos: 0.55,
  cos: 0.42,
  ftsRank: 5,
  topFtsCos: 0.38,
  spread: 0.1,
  maxItems: 3,
  maxChars: 1300,
  hintCos: 0.5,
  hintFtsRank: 3,
};

export function passesGate(h: MemoryHit, cos = GATE.cos, ftsRank = GATE.ftsRank, topFtsCos = GATE.topFtsCos): boolean {
  if (h.cos >= GATE.strongCos) return true;
  if (h.ftsRank === null) return false;
  return (h.cos >= cos && h.ftsRank <= ftsRank) || (h.cos >= topFtsCos && h.ftsRank === 1);
}

export function date(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function short(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

export function formatMemoryLine(m: MemoryHit | { id: number; kind: string; updatedAt: number; text: string; project?: string | null; scope?: string }, max: number): string {
  const where = m.scope === "project" && m.project ? `, ${m.project}` : "";
  return `- #${m.id} (${date(m.updatedAt)}, ${m.kind}${where}): ${short(m.text, max)}`;
}

export interface RecallItem {
  id: number;
  kind: string;
  date: string;
  project: string | null;
  text: string;
}

export function toRecallItem(m: MemoryHit): RecallItem {
  return { id: m.id, kind: m.kind, date: date(m.updatedAt), project: m.scope === "project" ? m.project : null, text: m.text.slice(0, 1800) };
}

const MEMORY_LINE = /^- #(\d+) \((\d{4}-\d{2}-\d{2}), ([\w-]+)(?:, ([^)]*))?\): (.*)$/;

export function parseRecallItems(content: string): RecallItem[] {
  return content.split("\n").flatMap((line) => {
    const m = MEMORY_LINE.exec(line.trim());
    return m ? [{ id: Number(m[1]), kind: m[3], date: m[2], project: m[4] ?? null, text: m[5] }] : [];
  });
}

export function autoRecall(store: Store, prompt: string, opts: { project: string | null; seen: Set<number> }): MemoryHit[] {
  if (isTrivialPrompt(prompt)) return [];
  const hits = store.searchMemories([recallQueryFromPrompt(prompt)], { project: opts.project, limit: 8, excludeIds: opts.seen });
  const gated = hits.filter((h) => passesGate(h));
  if (!gated.length) return [];
  const best = Math.max(...gated.map((h) => h.cos));
  const out: MemoryHit[] = [];
  let chars = 0;
  for (const h of gated) {
    if (out.length >= GATE.maxItems) break;
    if (h.cos < best - GATE.spread && h.cos < GATE.strongCos) continue;
    const len = Math.min(h.text.length, 520);
    if (out.length && chars + len > GATE.maxChars) break;
    out.push(h);
    chars += len;
  }
  return out;
}

export function renderRecall(hits: MemoryHit[]): string {
  return [
    "<memory>",
    "Possibly relevant notes from long-term memory (may be outdated; verify before relying on them; use recall for more):",
    ...hits.map((h) => formatMemoryLine(h, 500)),
    "</memory>",
  ].join("\n");
}

export function errorHint(store: Store, toolName: string, input: unknown, errorText: string, opts: { project: string | null; seen: Set<number> }): MemoryHit | undefined {
  const query = `${toolName} ${JSON.stringify(input ?? {}).slice(0, 300)}\n${errorText.slice(0, 700)}`;
  const hits = store.searchMemories([query], { project: opts.project, limit: 3, excludeIds: opts.seen, kinds: ["pitfall", "procedure", "fact", "decision"] });
  return hits.find((h) => passesGate(h, GATE.hintCos, GATE.hintFtsRank, GATE.hintCos));
}
