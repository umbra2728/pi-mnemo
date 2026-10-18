import os from "node:os";
import path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { enqueueBackfill, enqueueEnrichAll, importHermes } from "./importer.ts";
import { JobRunner } from "./jobs.ts";
import { projectFor } from "./project.ts";
import { autoRecall, date, errorHint, formatMemoryLine, parseRecallItems, renderRecall, toRecallItem, type RecallItem } from "./recall.ts";
import { recallView } from "./render.ts";
import { ensureModel, modelReady } from "./model.ts";
import { KINDS, Store, type Kind } from "./store.ts";
import { STATE_ENTRY, stateOf, type SessionEntry } from "./session.ts";
import { redact } from "./text.ts";

const ROOT = process.env.MNEMO_DIR ?? path.join(os.homedir(), ".pi/agent/mnemo");
const DB_PATH = path.join(ROOT, "mnemo.db");
const MODEL_DIR = path.join(ROOT, "model");
const IS_CHILD = !!process.env.PI_SUBAGENT_CHILD;
const CHECKPOINT_TOOL_CALLS = 25;
const CHECKPOINT_CHARS = 60_000;
const CHECKPOINT_MIN_INTERVAL = 5 * 60_000;
const HINT_SPACING = 10;
const OWN_TOOLS = new Set(["recall", "remember"]);

const NAMESPACE = {
  name: "mnemo",
  description: "Long-term memory shared across sessions",
  instructions: [
    "mnemo stores durable knowledge in English: facts, user preferences, decisions, pitfalls (cause + fix) and procedures, scoped globally or to a project.",
    "A background model extracts memories from sessions automatically and keeps a digest of every session; relevant notes are auto-injected as <memory> blocks.",
    "recall: pass 1-5 English queries; for vague topics pass 2-3 differently worded queries (synonyms, concrete tool names). Set sessions=true to also search past session digests and transcripts.",
    "Results from scripts: recall resolves to { memories: [{id, kind, scope, project, date, text, score}], sessions: [{id, title, date, project, summary, file, snippets}] }. Read a session file with the read tool for full detail.",
    "remember: save only durable, self-contained English notes; pass replaces=<id> to supersede an outdated note.",
  ].join("\n"),
};

const MemoryOut = Type.Object({
  id: Type.Integer(),
  kind: Type.String(),
  scope: Type.String(),
  project: Type.Union([Type.String(), Type.Null()]),
  date: Type.String(),
  text: Type.String(),
  score: Type.Number(),
});

const SessionOut = Type.Object({
  id: Type.String(),
  title: Type.String(),
  date: Type.String(),
  project: Type.Union([Type.String(), Type.Null()]),
  summary: Type.String(),
  file: Type.String(),
  snippets: Type.Array(Type.String()),
});

export default function mnemo(pi: ExtensionAPI) {
  let store: Store | undefined;
  let runner: JobRunner | undefined;
  let project: string | null = null;
  let sessionId: string | undefined;
  let sessionFile: string | undefined;
  let seen = new Set<number>();
  let toolCallsSince = 0;
  let charsSince = 0;
  let lastCheckpointAt = 0;
  let toolsSinceHint = HINT_SPACING;
  let lastError: string | undefined;
  let enabled = true;
  let hiddenTools: string[] = [];

  const applyEnabled = (ctx: ExtensionContext) => {
    const active = pi.getActiveTools();
    if (!enabled) {
      hiddenTools = [...new Set([...hiddenTools, ...active.filter((name) => OWN_TOOLS.has(name))])];
      pi.setActiveTools(active.filter((name) => !OWN_TOOLS.has(name)));
    } else if (hiddenTools.length) {
      pi.setActiveTools([...new Set([...active, ...hiddenTools])]);
      hiddenTools = [];
    }
    try {
      if (ctx.hasUI) ctx.ui.setStatus("mnemo", enabled ? undefined : "memory off");
    } catch {}
  };

  const getStore = (): Store => {
    if (!store) store = new Store(DB_PATH, MODEL_DIR);
    return store;
  };

  const safe = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch (e) {
      lastError = (e as Error).message;
      return fallback;
    }
  };

  const enqueueCheckpoint = (delayMs: number) => {
    if (IS_CHILD || !enabled || !sessionId || !sessionFile) return;
    safe(() => {
      const s = getStore();
      s.upsertSession({ id: sessionId!, file: sessionFile!, cwd: null, project });
      s.enqueueJob("checkpoint", { sessionId, file: sessionFile, project }, { key: `checkpoint:${sessionId}`, delayMs });
    }, undefined);
    lastCheckpointAt = Date.now();
    toolCallsSince = 0;
    charsSince = 0;
    runner?.kick();
  };

  let provisioning = false;
  const provisionModel = (ctx: ExtensionContext) => {
    if (modelReady(MODEL_DIR)) {
      safe(() => {
        const s = getStore();
        if (!s.embedder) s.attachEmbedder(MODEL_DIR);
      }, undefined);
      return;
    }
    if (provisioning || (ctx.mode !== "tui" && ctx.mode !== "rpc")) return;
    provisioning = true;
    const notify = (text: string) => {
      try {
        if (ctx.hasUI) ctx.ui.notify(text, "info");
      } catch {}
    };
    notify("mnemo: downloading the search model (~55 MB) in the background");
    ensureModel(MODEL_DIR)
      .then((status) => {
        if (status !== "downloaded") return;
        safe(() => getStore().attachEmbedder(MODEL_DIR), undefined);
        notify("mnemo: search model ready");
      })
      .catch((e) => {
        lastError = `model download: ${(e as Error).message}`;
      })
      .finally(() => {
        provisioning = false;
      });
  };

  const bindSession = (ctx: ExtensionContext) => {
    sessionId = ctx.sessionManager.getSessionId();
    sessionFile = ctx.sessionManager.getSessionFile();
    project = projectFor(ctx.cwd);
    seen = new Set();
    toolCallsSince = 0;
    charsSince = 0;
    toolsSinceHint = HINT_SPACING;
    enabled = ctx.sessionManager.getBranch().reduce<boolean>((acc, e) => stateOf(e as SessionEntry) ?? acc, true);
    applyEnabled(ctx);
    if (sessionFile) safe(() => getStore().upsertSession({ id: sessionId!, file: sessionFile!, cwd: ctx.cwd, project, startedAt: Date.now() }), undefined);
    if (!IS_CHILD) provisionModel(ctx);
    runner?.stop();
    runner = undefined;
    if (!IS_CHILD && (ctx.mode === "tui" || ctx.mode === "rpc" || process.env.MNEMO_RUNNER === "1")) {
      runner = new JobRunner(getStore(), ctx.modelRegistry as any, Number(process.env.MNEMO_CONCURRENCY ?? 2));
      runner.start();
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    safe(() => bindSession(ctx), undefined);
  });

  pi.on("session_shutdown", async () => {
    enqueueCheckpoint(0);
    runner?.stop();
    runner = undefined;
    store?.close();
    store = undefined;
  });

  pi.on("session_before_compact", async () => {
    enqueueCheckpoint(0);
  });

  pi.on("before_agent_start", async (event) => {
    if (!enabled) return;
    const hits = safe(() => autoRecall(getStore(), event.prompt, { project, seen }), []);
    if (!hits.length) return;
    for (const h of hits) seen.add(h.id);
    safe(() => getStore().noteHits(hits.map((h) => h.id)), undefined);
    return { message: { customType: "mnemo-recall", content: renderRecall(hits), display: true, details: { ids: hits.map((h) => h.id), items: hits.map(toRecallItem) } } };
  });

  pi.on("turn_end", async (event) => {
    toolCallsSince += event.toolResults?.length ?? 0;
    charsSince += JSON.stringify(event.message ?? "").length;
    for (const r of event.toolResults ?? []) charsSince += JSON.stringify(r.content ?? "").length;
    const due = toolCallsSince >= CHECKPOINT_TOOL_CALLS || charsSince >= CHECKPOINT_CHARS;
    if (due && Date.now() - lastCheckpointAt >= CHECKPOINT_MIN_INTERVAL) enqueueCheckpoint(0);
  });

  pi.on("agent_end", async () => {
    enqueueCheckpoint(15_000);
  });

  pi.on("tool_result", async (event) => {
    toolsSinceHint++;
    if (!enabled || !event.isError || OWN_TOOLS.has(event.toolName) || toolsSinceHint < HINT_SPACING) return;
    const errorText = event.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    const hit = safe(() => errorHint(getStore(), event.toolName, event.input, errorText, { project, seen }), undefined);
    if (!hit) return;
    seen.add(hit.id);
    toolsSinceHint = 0;
    safe(() => getStore().noteHits([hit.id]), undefined);
    safe(() => pi.appendEntry("mnemo-hint", { items: [toRecallItem(hit)] }), undefined);
    return {
      content: [...event.content, { type: "text" as const, text: `\n[mnemo] Similar issue seen before:\n${formatMemoryLine(hit, 600)}` }],
      structuredContent: event.structuredContent,
    };
  });

  pi.registerMessageRenderer("mnemo-recall", (message, { expanded, outputPad }, theme) => {
    const items = (message.details as { items?: RecallItem[] } | undefined)?.items ?? parseRecallItems(typeof message.content === "string" ? message.content : message.content.map((c) => (c.type === "text" ? c.text : "")).join("\n"));
    return recallView(`recall:${message.timestamp}`, "memory", items, expanded, theme, outputPad);
  });

  pi.registerEntryRenderer("mnemo-hint", (entry, { expanded }, theme) => {
    const items = (entry.data as { items?: RecallItem[] } | undefined)?.items ?? [];
    if (!items.length) return undefined;
    return recallView(`hint:${entry.id}`, "similar issue seen before", items, expanded, theme, 1);
  });

  pi.registerTool({
    name: "recall",
    label: "Recall",
    description:
      "Search long-term memory (facts, preferences, decisions, pitfalls, procedures; optionally past sessions). Memory is English: query in English, 2-3 phrasings for vague topics.",
    promptGuidelines: [
      "Relevant memories are auto-injected as <memory>; call recall before non-trivial work on hosts, projects, tools or problems the user may have dealt with before, or when they refer to past work.",
    ],
    parameters: Type.Object({
      queries: Type.Array(Type.String(), { minItems: 1, maxItems: 5 }),
      scope: Type.Optional(StringEnum(["all", "project", "global"] as const)),
      kinds: Type.Optional(Type.Array(StringEnum(KINDS))),
      sessions: Type.Optional(Type.Boolean({ description: "Also search past sessions" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    }),
    outputSchema: Type.Object({ memories: Type.Array(MemoryOut), sessions: Type.Array(SessionOut) }),
    namespace: NAMESPACE,
    annotations: { readOnlyHint: true, openWorldHint: false },
    async execute(_id, params) {
      const s = getStore();
      const hits = s.searchMemories(params.queries, { project, scope: params.scope ?? "all", kinds: params.kinds, limit: params.limit ?? 8 });
      s.noteHits(hits.map((h) => h.id));
      for (const h of hits) seen.add(h.id);
      const sessions = params.sessions ? s.searchSessions(params.queries, { project, limit: 4 }) : [];
      const memories = hits.map((h) => ({ id: h.id, kind: h.kind, scope: h.scope, project: h.project, date: date(h.updatedAt), text: h.text.slice(0, 1800), score: Number(h.score.toFixed(4)) }));
      const sessionsOut = sessions.map((x) => ({ id: x.id, title: x.title, date: x.updatedAt ? date(x.updatedAt) : "", project: x.project, summary: x.summary, file: x.file, snippets: x.snippets }));
      const lines = [
        memories.length ? memories.map((m) => `- #${m.id} (${m.date}, ${m.kind}${m.project ? `, ${m.project}` : ""}): ${m.text}`).join("\n") : "No matching memories.",
        ...(params.sessions
          ? [
              "",
              "Sessions:",
              sessionsOut.length
                ? sessionsOut.map((x) => `- ${x.date} ${x.title || "(untitled)"} [${x.project ?? "home"}] ${x.summary}${x.snippets.length ? `\n  ${x.snippets.join("\n  ")}` : ""}\n  file: ${x.file}`).join("\n")
                : "No matching sessions.",
            ]
          : []),
      ];
      return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: { memories, sessions: sessionsOut }, details: undefined };
    },
  });

  pi.registerTool({
    name: "remember",
    label: "Remember",
    description:
      "Save a durable, self-contained English note (preference, environment fact, decision, pitfall with fix, procedure). Not for task progress or secrets; background extraction already saves most things.",
    parameters: Type.Object({
      text: Type.String(),
      kind: StringEnum(KINDS),
      scope: Type.Optional(StringEnum(["project", "global"] as const)),
      replaces: Type.Optional(Type.Integer({ description: "id of outdated memory to supersede" })),
    }),
    outputSchema: Type.Object({ id: Type.Integer(), replaced: Type.Union([Type.Integer(), Type.Null()]) }),
    namespace: NAMESPACE,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async execute(_id, params) {
      const s = getStore();
      const scope = params.scope === "project" || (!params.scope && project) ? "project" : "global";
      const id = s.addMemory({
        text: redact(params.text.trim()),
        kind: params.kind as Kind,
        scope: scope === "project" && project ? "project" : "global",
        project: scope === "project" ? project : null,
        sessionId: sessionId ?? null,
        source: "remember",
      });
      let replaced: number | null = null;
      if (params.replaces && s.getMemory(params.replaces)) {
        s.setStatus(params.replaces, "superseded", id);
        replaced = params.replaces;
      }
      s.enqueueJob("enrich", { ids: [id] }, { key: `enrich:${id}`, delayMs: 2000 });
      runner?.kick();
      seen.add(id);
      return {
        content: [{ type: "text", text: `Saved #${id}${replaced ? ` (supersedes #${replaced})` : ""}.` }],
        structuredContent: { id, replaced },
        details: undefined,
      };
    },
  });

  pi.registerCommand("mnemo", {
    description: "Long-term memory: off | on | stats | search <q> | show <id> | forget <id> | import-hermes | backfill | enrich",
    handler: async (args, ctx) => {
      const [cmd, ...rest] = args.trim().split(/\s+/);
      const arg = rest.join(" ");
      const say = (text: string) => ctx.ui.notify(text, "info");
      if (cmd === "off" || cmd === "on") {
        const next = cmd === "on";
        if (next === enabled) return say(`mnemo: memory already ${cmd} in this session`);
        if (!next) enqueueCheckpoint(0);
        pi.appendEntry(STATE_ENTRY, { enabled: next });
        enabled = next;
        applyEnabled(ctx);
        return say(
          next
            ? "mnemo: memory on — auto-recall, hints, recall/remember and extraction resumed (the paused part stays excluded)"
            : "mnemo: memory off for this session — no auto-recall, no hints, no recall/remember tools, nothing from now on is extracted",
        );
      }
      const s = getStore();
      if (!cmd || cmd === "stats") {
        const c = s.countMemories();
        const sessions = s.db.prepare("SELECT COUNT(*) n, SUM(digested_at IS NOT NULL) d FROM sessions").get() as { n: number; d: number };
        say(
          [
            `memories: ${c.active} active / ${c.total} total (${c.unenriched} awaiting tags)`,
            `sessions: ${sessions.n} known, ${sessions.d ?? 0} digested`,
            `jobs: ${JSON.stringify(s.jobStats())}`,
            `session memory: ${enabled ? "on" : "off"}`,
            `project: ${project ?? "(home)"}  model: ${s.embedder ? "static embeddings" : "MISSING (run npm run fetch-model)"}`,
            runner?.lastResult ? `last job: ${runner.lastResult}` : "",
            runner?.lastError || lastError ? `last error: ${runner?.lastError ?? lastError}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        );
      } else if (cmd === "search") {
        const hits = s.searchMemories([arg], { project, limit: 8 });
        say(hits.length ? hits.map((h) => `${formatMemoryLine(h, 200)}  [cos ${h.cos.toFixed(2)} fts ${h.ftsRank ?? "-"}]`).join("\n") : "nothing found");
      } else if (cmd === "show") {
        const m = s.getMemory(Number(arg));
        say(m ? `#${m.id} ${m.kind} ${m.scope}${m.project ? `:${m.project}` : ""} ${m.status} ${date(m.updatedAt)}\n${m.text}\ntags: ${m.tags}\nru: ${m.ru}` : "not found");
      } else if (cmd === "forget") {
        say(s.setStatus(Number(arg), "deleted") ? `forgot #${arg}` : "not found");
      } else if (cmd === "import-hermes") {
        const r = importHermes(s, { enrichmentFile: arg || undefined });
        const missing = enqueueEnrichAll(s);
        runner?.kick();
        say(r.skipped === -1 ? "already imported" : `imported ${r.imported} (reused tags for ${r.reusedEnrichment}, ${r.skipped} duplicates skipped); ${missing} queued for tagging`);
      } else if (cmd === "backfill") {
        const n = enqueueBackfill(s, { excludeId: sessionId });
        runner?.kick();
        say(`queued ${n} sessions for digests`);
      } else if (cmd === "enrich") {
        const missing = enqueueEnrichAll(s);
        runner?.kick();
        say(`queued ${missing} memories for tagging`);
      } else {
        say("usage: /mnemo off | on | stats | search <q> | show <id> | forget <id> | import-hermes [enrichment.json] | backfill | enrich");
      }
    },
  });
}
