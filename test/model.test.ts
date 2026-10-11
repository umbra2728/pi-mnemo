import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { ensureModel, modelReady, quantize } from "../src/model.ts";

function safetensors(rows: number, dims: number): Buffer {
  const header = JSON.stringify({ "embedding.weight": { dtype: "F32", shape: [rows, dims], data_offsets: [0, rows * dims * 4] } });
  const headerBuf = Buffer.from(header, "utf8");
  const data = Buffer.alloc(rows * dims * 4);
  for (let r = 0; r < rows; r++) for (let d = 0; d < dims; d++) data.writeFloatLE((r + 1) * (d % 2 ? -0.5 : 0.25), (r * dims + d) * 4);
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(headerBuf.length));
  return Buffer.concat([len, headerBuf, data]);
}

describe("model provisioning", () => {
  it("quantizes rows to int8 with a per-row scale", () => {
    const { table, rows, rowBytes } = quantize(safetensors(3, 4), 2);
    assert.equal(rows, 3);
    assert.equal(rowBytes, 6);
    assert.ok(Math.abs(table.readFloatLE(0) - 0.5 / 127) < 1e-9);
    assert.equal(table.readInt8(4), 64);
    assert.equal(table.readInt8(5), -127);
  });

  it("refuses to truncate beyond the model dimension", () => {
    assert.throws(() => quantize(safetensors(2, 2), 4), /model has 2/);
  });

  it("downloads once, then reports ready without touching the network", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-model-"));
    const target = path.join(dir, "model");
    const vocab = ["[PAD]", "[UNK]", "a"];
    const files: Record<string, Buffer> = {
      "tokenizer.json": Buffer.from(JSON.stringify({ model: { vocab: { "[PAD]": 0, "[UNK]": 1, a: 2 } } })),
      "model.safetensors": safetensors(3, 4),
    };
    let calls = 0;
    const fetcher = async (url: string) => {
      calls++;
      const name = url.split("/").pop()!;
      return files[name];
    };
    assert.equal(await ensureModel(target, { fetcher, dims: 4 }), "downloaded");
    assert.equal(modelReady(target), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(target, "vocab.json"), "utf8")).length, vocab.length);
    const before = calls;
    assert.equal(await ensureModel(target, { fetcher, dims: 4 }), "ready");
    assert.equal(calls, before);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reports busy while another process holds the lock", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-lock-"));
    const target = path.join(dir, "model");
    fs.mkdirSync(`${target}.lock`, { recursive: true });
    assert.equal(await ensureModel(target, { fetcher: async () => Buffer.alloc(0), dims: 4 }), "busy");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
