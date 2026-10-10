import fs from "node:fs";
import { redact } from "./text.ts";

export interface SessionEntry {
  type: string;
  id?: string;
  timestamp?: string;
  cwd?: string;
  customType?: string;
  message?: {
    role: string;
    content?: unknown;
    toolName?: string;
    isError?: boolean;
    timestamp?: number;
  };
}

export interface SliceLine {
  entryId: string;
  role: "user" | "assistant" | "tool" | "error";
  text: string;
}

export interface Slice {
  lines: SliceLine[];
  lastEntryId: string | undefined;
  toolCalls: number;
  userChars: number;
  chars: number;
}

export function readEntries(file: string): SessionEntry[] {
  const out: SessionEntry[] = [];
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

export function sessionHeader(entries: SessionEntry[]): { id?: string; cwd?: string; startedAt?: number } {
  const h = entries.find((e) => e.type === "session") as (SessionEntry & { id?: string }) | undefined;
  return { id: h?.id, cwd: h?.cwd, startedAt: h?.timestamp ? Date.parse(h.timestamp) : undefined };
}

export function entriesAfter(entries: SessionEntry[], cursor: string | null | undefined): SessionEntry[] {
  if (!cursor) return entries;
  const idx = entries.findIndex((e) => e.id === cursor);
  return idx < 0 ? entries : entries.slice(idx + 1);
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c: any) => c?.type === "text" && typeof c.text === "string")
    .map((c: any) => c.text)
    .join("\n");
}

function clip(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const head = Math.floor(max * 0.7);
  return `${t.slice(0, head)} …[${t.length - max} chars cut]… ${t.slice(t.length - (max - head))}`;
}

function stripInjected(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").replace(/<memory>[\s\S]*?<\/memory>/g, "").trim();
}

export function conversationText(entries: SessionEntry[]): { entryId: string; role: string; ts: number; text: string }[] {
  const out: { entryId: string; role: string; ts: number; text: string }[] = [];
  for (const e of entries) {
    if (e.type !== "message" || !e.message || !e.id) continue;
    const role = e.message.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = stripInjected(textOf(e.message.content));
    if (!text) continue;
    out.push({ entryId: e.id, role, ts: e.message.timestamp ?? (e.timestamp ? Date.parse(e.timestamp) : 0), text: redact(clip(text, 4000)) });
  }
  return out;
}

export function buildSlice(entries: SessionEntry[], opts: { includeTools?: boolean } = {}): Slice {
  const includeTools = opts.includeTools ?? true;
  const lines: SliceLine[] = [];
  let toolCalls = 0;
  let userChars = 0;
  let lastEntryId: string | undefined;
  for (const e of entries) {
    if (e.id) lastEntryId = e.id;
    if (e.type !== "message" || !e.message || !e.id) continue;
    const m = e.message;
    if (m.role === "user") {
      const text = stripInjected(textOf(m.content));
      if (!text) continue;
      userChars += text.length;
      lines.push({ entryId: e.id, role: "user", text: clip(text, 2500) });
    } else if (m.role === "assistant") {
      const text = textOf(m.content);
      if (text.trim()) lines.push({ entryId: e.id, role: "assistant", text: clip(text, 2000) });
      if (Array.isArray(m.content)) {
        for (const c of m.content as any[]) {
          if (c?.type !== "toolCall") continue;
          toolCalls++;
          if (includeTools) {
            const args = JSON.stringify(c.arguments ?? {});
            lines.push({ entryId: e.id, role: "tool", text: `${c.name}(${clip(args, 260)})` });
          }
        }
      }
    } else if (m.role === "toolResult" && includeTools) {
      const text = textOf(m.content);
      if (m.isError) lines.push({ entryId: e.id, role: "error", text: `${m.toolName ?? "tool"} failed: ${clip(text, 600)}` });
      else if (m.toolName === "bash" && text.trim()) lines.push({ entryId: e.id, role: "tool", text: `→ ${clip(text, 220)}` });
    }
  }
  const redacted = lines.map((l) => ({ ...l, text: redact(l.text) }));
  return { lines: redacted, lastEntryId, toolCalls, userChars, chars: redacted.reduce((s, l) => s + l.text.length, 0) };
}

export function renderLines(lines: SliceLine[]): string {
  const tag = { user: "USER", assistant: "AGENT", tool: "TOOL", error: "ERROR" } as const;
  return lines.map((l) => `[${tag[l.role]}] ${l.text}`).join("\n");
}

export function chunkLines(lines: SliceLine[], maxChars: number): SliceLine[][] {
  const chunks: SliceLine[][] = [];
  let cur: SliceLine[] = [];
  let size = 0;
  for (const l of lines) {
    if (size + l.text.length > maxChars && cur.length) {
      chunks.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(l);
    size += l.text.length + 10;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

export function condenseForDigest(lines: SliceLine[], maxChars: number): string {
  const important = lines.filter((l) => l.role === "user" || l.role === "assistant" || l.role === "error");
  const text = renderLines(important);
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.45);
  return `${text.slice(0, head)}\n…[middle of session omitted]…\n${text.slice(text.length - (maxChars - head))}`;
}
