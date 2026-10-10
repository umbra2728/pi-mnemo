import os from "node:os";
import path from "node:path";
import { enqueueBackfill, enqueueEnrichAll, importHermes } from "../src/importer.ts";
import { Store } from "../src/store.ts";

const root = process.env.MNEMO_DIR ?? path.join(os.homedir(), ".pi/agent/mnemo");
const store = new Store(path.join(root, "mnemo.db"), path.join(root, "model"));
const [cmd, arg] = process.argv.slice(2);

if (cmd === "import-hermes") {
  console.log(importHermes(store, { enrichmentFile: arg }));
  console.log({ queuedForTags: enqueueEnrichAll(store) });
} else if (cmd === "backfill") {
  console.log({ queuedSessions: enqueueBackfill(store, { excludeId: arg }) });
} else if (cmd === "search") {
  for (const h of store.searchMemories([arg], { limit: 8 })) console.log(`#${h.id} cos=${h.cos.toFixed(2)} fts=${h.ftsRank ?? "-"} ${h.text.slice(0, 140).replace(/\s+/g, " ")}`);
} else if (cmd === "stats") {
  console.log(store.countMemories(), store.jobStats());
} else {
  console.log("usage: admin.ts import-hermes [enrichment.json] | backfill [excludeSessionId] | search <q> | stats");
}
store.close();
