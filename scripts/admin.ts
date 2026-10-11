import os from "node:os";
import path from "node:path";
import { enqueueBackfill, enqueueEnrichAll, importHermes } from "../src/importer.ts";
import { ensureModel } from "../src/model.ts";
import { Store } from "../src/store.ts";

const root = process.env.MNEMO_DIR ?? path.join(os.homedir(), ".pi/agent/mnemo");
const modelDir = process.env.MNEMO_MODEL_DIR ?? path.join(root, "model");
const [cmd, arg] = process.argv.slice(2);

function withStore<T>(fn: (store: Store) => T): T {
  const store = new Store(path.join(root, "mnemo.db"), modelDir);
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

if (cmd === "fetch-model") {
  console.log(`${modelDir}: ${await ensureModel(modelDir)}`);
} else if (cmd === "import-hermes") {
  withStore((store) => {
    console.log(importHermes(store, { enrichmentFile: arg }));
    console.log({ queuedForTags: enqueueEnrichAll(store) });
  });
} else if (cmd === "backfill") {
  withStore((store) => console.log({ queuedSessions: enqueueBackfill(store, { excludeId: arg }) }));
} else if (cmd === "search" && arg) {
  withStore((store) => {
    for (const h of store.searchMemories([arg], { limit: 8 })) console.log(`#${h.id} cos=${h.cos.toFixed(2)} fts=${h.ftsRank ?? "-"} ${h.text.slice(0, 140).replace(/\s+/g, " ")}`);
  });
} else if (cmd === "stats") {
  withStore((store) => console.log(store.countMemories(), store.jobStats()));
} else {
  console.log("usage: pi-mnemo fetch-model | import-hermes [enrichment.json] | backfill [excludeSessionId] | search <q> | stats");
  process.exitCode = cmd ? 1 : 0;
}
