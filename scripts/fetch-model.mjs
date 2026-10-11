import os from "node:os";
import path from "node:path";
import { ensureModel } from "../src/model.ts";

const dir = process.env.MNEMO_MODEL_DIR ?? path.join(process.env.MNEMO_DIR ?? path.join(os.homedir(), ".pi/agent/mnemo"), "model");
console.log(`${dir}: ${await ensureModel(dir)}`);
