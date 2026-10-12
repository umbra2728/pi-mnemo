import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { autoRecall, parseRecallItems, passesGate, renderRecall } from "../src/recall.ts";
import { buildSlice, entriesAfter } from "../src/session.ts";
import { Store } from "../src/store.ts";
import { isTrivialPrompt, redact } from "../src/text.ts";
import { applyOps } from "../src/writer.ts";

const MODEL_DIR = process.env.MNEMO_MODEL_DIR ?? path.join(os.homedir(), ".pi/agent/mnemo/model");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-test-"));
const store = new Store(path.join(tmp, "t.db"), MODEL_DIR);
after(() => {
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("text", () => {
  it("treats acknowledgements and commands as trivial", () => {
    for (const p of ["ок", "да, делай", "go", "Продолжай!", "/model", "  ", "спасибо, норм"]) assert.equal(isTrivialPrompt(p), true, p);
    for (const p of ["chibisafe?", "почини деплой", "why does pnpm fail"]) assert.equal(isTrivialPrompt(p), false, p);
  });

  it("redacts common secrets", () => {
    const out = redact("key sk-ant-abcdefghijklmnopqrstu and ghp_abcdefghijklmnopqrstuvwxyz12 password=hunter2hunter https://bob:pa55word@host/x");
    assert.ok(!out.includes("abcdefghijklmnop"));
    assert.ok(!out.includes("hunter2hunter"));
    assert.ok(!out.includes("pa55word"));
  });
});

describe("recall display", () => {
  it("parses legacy recall blocks back into items", () => {
    const base = { kind: "pitfall", updatedAt: Date.UTC(2026, 8, 30), score: 1, cos: 1, ftsRank: 1 };
    const block = renderRecall([
      { ...base, id: 416, scope: "project", project: "pi-mnemo", text: "bun install\nrewrites the lockfile" },
      { ...base, id: 7, kind: "fact", scope: "global", project: null, text: "Caddy fronts the LXC (port 443)." },
    ] as never);
    assert.deepEqual(parseRecallItems(block), [
      { id: 416, kind: "pitfall", date: "2026-09-30", project: "pi-mnemo", text: "bun install rewrites the lockfile" },
      { id: 7, kind: "fact", date: "2026-09-30", project: null, text: "Caddy fronts the LXC (port 443)." },
    ]);
  });
});

describe("search", () => {
  const ids: Record<string, number> = {};
  it("indexes and finds memories across languages", () => {
    ids.chibi = store.addMemory({ text: "Chibisafe runs on the home LXC behind Caddy; uploads are private, direct links enabled.", kind: "fact", scope: "global", tags: "file sharing, self-hosted, upload service", ru: "файлообменник, загрузка файлов, хостинг файлов" });
    ids.pnpm = store.addMemory({ text: "User prefers pnpm over npm in all JavaScript projects.", kind: "preference", scope: "global", tags: "package manager, node", ru: "пакетный менеджер, установка зависимостей" });
    ids.proj = store.addMemory({ text: "In this repo tests run with node --test and type stripping.", kind: "decision", scope: "project", project: "alpha", tags: "testing", ru: "тесты" });
    const en = store.searchMemories(["self-hosted file upload service"], { limit: 3 });
    assert.equal(en[0].id, ids.chibi);
    const ru = store.searchMemories(["где у меня файлообменник крутится?"], { limit: 3 });
    assert.equal(ru[0].id, ids.chibi);
    const scoped = store.searchMemories(["tests"], { scope: "project", project: "beta" });
    assert.ok(!scoped.some((h) => h.id === ids.proj));
  });

  it("hides superseded and deleted memories", () => {
    const newer = store.addMemory({ text: "User prefers bun over pnpm for new JavaScript projects.", kind: "preference", scope: "global" });
    store.setStatus(ids.pnpm, "superseded", newer);
    const hits = store.searchMemories(["which package manager does the user prefer"], { limit: 5 });
    assert.ok(!hits.some((h) => h.id === ids.pnpm));
    assert.ok(hits.some((h) => h.id === newer));
  });

  it("auto-recall injects nothing for generic prompts and skips seen ids", () => {
    assert.deepEqual(autoRecall(store, "объясни как работают замыкания и лексическая область видимости", { project: null, seen: new Set() }), []);
    const first = autoRecall(store, "задеплой chibisafe заново, файлообменник лежит", { project: null, seen: new Set() });
    assert.ok(first.some((h) => h.id === ids.chibi));
    const again = autoRecall(store, "задеплой chibisafe заново, файлообменник лежит", { project: null, seen: new Set([ids.chibi]) });
    assert.ok(!again.some((h) => h.id === ids.chibi));
  });

  it("gate requires lexical support below the strong threshold", () => {
    const base = { id: 1, text: "", kind: "fact", scope: "global", project: null, tags: "", ru: "", status: "active", createdAt: 0, updatedAt: 0, sessionId: null, score: 0 } as const;
    assert.equal(passesGate({ ...base, cos: 0.6, ftsRank: null }), true);
    assert.equal(passesGate({ ...base, cos: 0.45, ftsRank: null }), false);
    assert.equal(passesGate({ ...base, cos: 0.45, ftsRank: 2 }), true);
  });
});

describe("writer", () => {
  it("only lets the model update memories it was shown", () => {
    const id = store.addMemory({ text: "Original note about the dev VM.", kind: "fact", scope: "global" });
    const other = store.addMemory({ text: "Unrelated note.", kind: "fact", scope: "global" });
    const stats = applyOps(
      store,
      [
        { op: "update", id, text: "Dev VM has 8 GiB RAM." },
        { op: "update", id: other, text: "hijacked" },
        { op: "add", kind: "pitfall", scope: "project", text: "token=abcdef123456 leaks", tags: ["x"], ru: "y" },
      ],
      { project: null, sessionId: "s1", allowedIds: new Set([id]) },
    );
    assert.equal(stats.updated, 1);
    assert.equal(store.getMemory(other)?.text, "Unrelated note.");
    const added = store.searchMemories(["leaks"], { limit: 1 })[0];
    assert.equal(added.scope, "global");
    assert.ok(!added.text.includes("abcdef123456"));
  });

  it("builds slices after the cursor and counts tool calls", () => {
    const entries = [
      { type: "session", id: "s", cwd: "/x" },
      { type: "message", id: "a", message: { role: "user", content: [{ type: "text", text: "old" }] } },
      { type: "message", id: "b", message: { role: "user", content: [{ type: "text", text: "<system-reminder>noise</system-reminder>fix the build" }] } },
      { type: "message", id: "c", message: { role: "assistant", content: [{ type: "text", text: "running" }, { type: "toolCall", name: "bash", arguments: { command: "make" } }] } },
      { type: "message", id: "d", message: { role: "toolResult", toolName: "bash", isError: true, content: [{ type: "text", text: "make: *** missing separator" }] } },
    ];
    const slice = buildSlice(entriesAfter(entries, "a"));
    assert.equal(slice.toolCalls, 1);
    assert.equal(slice.lastEntryId, "d");
    assert.equal(slice.lines[0].text, "fix the build");
    assert.ok(slice.lines.some((l) => l.role === "error" && l.text.includes("missing separator")));
  });
});

describe("jobs", () => {
  it("dedupes keyed pending jobs and leases them once", () => {
    store.enqueueJob("checkpoint", { n: 1 }, { key: "checkpoint:x" });
    store.enqueueJob("checkpoint", { n: 2 }, { key: "checkpoint:x" });
    const job = store.claimJob(60_000);
    assert.equal(job?.payload.n, 2);
    assert.equal(store.claimJob(60_000), undefined);
    store.failJob(job!.id, "boom", 0);
    const retry = store.claimJob(60_000);
    assert.equal(retry?.id, job!.id);
    store.finishJob(retry!.id);
    assert.equal(store.claimJob(60_000), undefined);
  });
});
