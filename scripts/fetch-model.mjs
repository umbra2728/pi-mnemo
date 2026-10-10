import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repo = "sentence-transformers/static-similarity-mrl-multilingual-v1";
const base = `https://huggingface.co/${repo}/resolve/main/0_StaticEmbedding`;
const dims = Number(process.env.MNEMO_DIMS ?? 512);
const outDir = process.env.MNEMO_MODEL_DIR ?? path.join(os.homedir(), ".pi/agent/mnemo/model");
fs.mkdirSync(outDir, { recursive: true });

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const tokenizer = JSON.parse((await download(`${base}/tokenizer.json`)).toString("utf8"));
const vocab = Object.entries(tokenizer.model.vocab).sort((a, b) => a[1] - b[1]).map(([token]) => token);
fs.writeFileSync(path.join(outDir, "vocab.json"), JSON.stringify(vocab));

const local = process.env.MNEMO_SAFETENSORS;
const weights = local ? fs.readFileSync(local) : await download(`${base}/model.safetensors`);
const headerLength = Number(weights.readBigUInt64LE(0));
const header = JSON.parse(weights.subarray(8, 8 + headerLength).toString("utf8"));
const tensor = header["embedding.weight"];
const [rows, fullDims] = tensor.shape;
if (rows !== vocab.length) throw new Error(`vocab ${vocab.length} != rows ${rows}`);
const dataStart = 8 + headerLength + tensor.data_offsets[0];
const rowBytes = 4 + dims;
const out = Buffer.alloc(rows * rowBytes);
for (let r = 0; r < rows; r++) {
  const offset = dataStart + r * fullDims * 4;
  let maxAbs = 0;
  for (let d = 0; d < dims; d++) maxAbs = Math.max(maxAbs, Math.abs(weights.readFloatLE(offset + d * 4)));
  const scale = maxAbs / 127 || 1;
  out.writeFloatLE(scale, r * rowBytes);
  for (let d = 0; d < dims; d++) {
    out.writeInt8(Math.round(weights.readFloatLE(offset + d * 4) / scale), r * rowBytes + 4 + d);
  }
}
fs.writeFileSync(path.join(outDir, "table.bin"), out);
fs.writeFileSync(path.join(outDir, "meta.json"), JSON.stringify({ repo, dims, rows, rowBytes }));
console.log(`wrote ${outDir} (${rows} x ${dims}, ${(out.length / 1e6).toFixed(1)} MB)`);
