import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.ts";

const dir = process.argv[2] ?? new URL("./data", import.meta.url).pathname;
const docs = JSON.parse(fs.readFileSync(path.join(dir, "docs_enr.json"), "utf8"));
const queries = JSON.parse(fs.readFileSync(path.join(dir, "queries.json"), "utf8"));
const enRaw = fs.readFileSync(path.join(dir, "en.out"), "utf8");
const en = new Map<number, { natural_en: string; para_en: string }>(
  JSON.parse(enRaw.slice(enRaw.indexOf("["), enRaw.lastIndexOf("]") + 1)).map((x: any) => [x.id, x]),
);
const negatives: string[] = fs.existsSync(path.join(dir, "negatives.json")) ? JSON.parse(fs.readFileSync(path.join(dir, "negatives.json"), "utf8")) : [];

const dbPath = path.join(os.tmpdir(), `mnemo-bench-${process.pid}.db`);
const store = new Store(dbPath, process.env.MNEMO_MODEL_DIR ?? path.join(os.homedir(), ".pi/agent/mnemo/model"));
const cyr = /[а-яё]/i;
const idMap = new Map<number, number>();
let t = performance.now();
store.tx(() => {
  docs.forEach((d: any, i: number) => {
    const tags: string[] = d.tags ?? [];
    const id = store.addMemory({
      text: d.text.slice(0, 2000),
      kind: "fact",
      scope: "global",
      tags: tags.filter((x) => !cyr.test(x)).join(", "),
      ru: [d.summary ?? "", tags.filter((x) => cyr.test(x)).join(", ")].join("\n"),
      enriched: true,
    });
    idMap.set(i, id);
  });
});
console.log(`indexed ${docs.length} in ${Math.round(performance.now() - t)}ms`);

const top1: { kind: string; cos: number; fts: number | null; gold: boolean }[] = [];
for (const [label, get] of [
  ["ru natural", (q: any) => q.natural],
  ["ru vague", (q: any) => q.para],
  ["en natural", (q: any) => en.get(q.id)?.natural_en],
  ["en vague", (q: any) => en.get(q.id)?.para_en],
] as const) {
  let hit = 0;
  let ms = 0;
  for (const q of queries) {
    const text = get(q);
    if (!text) continue;
    const s = performance.now();
    const res = store.searchMemories([text], { limit: 5 });
    ms += performance.now() - s;
    const gold = idMap.get(q.id);
    if (res.some((r) => r.id === gold)) hit++;
    if (label.startsWith("ru") && res[0]) top1.push({ kind: label, cos: res[0].cos, fts: res[0].ftsRank, gold: res[0].id === gold });
  }
  console.log(`${label.padEnd(12)} R@5=${(hit / queries.length).toFixed(2)}  avg ${(ms / queries.length).toFixed(1)}ms`);
}
for (const n of negatives) {
  const res = store.searchMemories([n], { limit: 1 });
  if (res[0]) top1.push({ kind: "negative", cos: res[0].cos, fts: res[0].ftsRank, gold: false });
}
fs.writeFileSync(path.join(dir, "top1.json"), JSON.stringify(top1));
store.close();
fs.rmSync(dbPath, { force: true });
fs.rmSync(`${dbPath}-wal`, { force: true });
fs.rmSync(`${dbPath}-shm`, { force: true });
