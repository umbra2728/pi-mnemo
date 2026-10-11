import fs from "node:fs";
import path from "node:path";

export const MODEL_REPO = "sentence-transformers/static-similarity-mrl-multilingual-v1";
const DEFAULT_BASE = `https://huggingface.co/${MODEL_REPO}/resolve/main/0_StaticEmbedding`;
export const MODEL_DIMS = 512;
const LOCK_STALE_MS = 15 * 60_000;

export type Fetcher = (url: string) => Promise<Buffer>;

export interface FetchOptions {
  fetcher?: Fetcher;
  base?: string;
  dims?: number;
}

export type ProvisionStatus = "ready" | "downloaded" | "busy";

const httpGet: Fetcher = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
};

export function modelReady(dir: string): boolean {
  return ["meta.json", "table.bin", "vocab.json"].every((file) => fs.existsSync(path.join(dir, file)));
}

export function quantize(weights: Buffer, dims: number): { table: Buffer; rows: number; rowBytes: number } {
  const headerLength = Number(weights.readBigUInt64LE(0));
  const header = JSON.parse(weights.subarray(8, 8 + headerLength).toString("utf8"));
  const tensor = header["embedding.weight"];
  if (!tensor) throw new Error("embedding.weight is missing from model.safetensors");
  const [rows, fullDims] = tensor.shape;
  if (dims > fullDims) throw new Error(`requested ${dims} dims, model has ${fullDims}`);
  const dataStart = 8 + headerLength + tensor.data_offsets[0];
  const rowBytes = 4 + dims;
  const table = Buffer.alloc(rows * rowBytes);
  for (let r = 0; r < rows; r++) {
    const offset = dataStart + r * fullDims * 4;
    let maxAbs = 0;
    for (let d = 0; d < dims; d++) maxAbs = Math.max(maxAbs, Math.abs(weights.readFloatLE(offset + d * 4)));
    const scale = maxAbs / 127 || 1;
    table.writeFloatLE(scale, r * rowBytes);
    for (let d = 0; d < dims; d++) {
      table.writeInt8(Math.round(weights.readFloatLE(offset + d * 4) / scale), r * rowBytes + 4 + d);
    }
  }
  return { table, rows, rowBytes };
}

export async function fetchModel(dir: string, opts: FetchOptions = {}): Promise<void> {
  const get = opts.fetcher ?? httpGet;
  const base = opts.base ?? DEFAULT_BASE;
  const dims = opts.dims ?? MODEL_DIMS;
  const tokenizer = JSON.parse((await get(`${base}/tokenizer.json`)).toString("utf8"));
  const vocab = Object.entries(tokenizer.model.vocab as Record<string, number>)
    .sort((a, b) => a[1] - b[1])
    .map(([token]) => token);
  const { table, rows, rowBytes } = quantize(await get(`${base}/model.safetensors`), dims);
  if (rows !== vocab.length) throw new Error(`vocabulary has ${vocab.length} tokens, weights have ${rows} rows`);
  const staging = `${dir}.staging-${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(staging, "vocab.json"), JSON.stringify(vocab));
  fs.writeFileSync(path.join(staging, "table.bin"), table);
  fs.writeFileSync(path.join(staging, "meta.json"), JSON.stringify({ repo: MODEL_REPO, dims, rows, rowBytes }));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(staging, dir);
}

function acquireLock(lock: string): boolean {
  try {
    fs.mkdirSync(lock);
    return true;
  } catch {
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs < LOCK_STALE_MS) return false;
      fs.rmSync(lock, { recursive: true, force: true });
      fs.mkdirSync(lock);
      return true;
    } catch {
      return false;
    }
  }
}

export async function ensureModel(dir: string, opts: FetchOptions = {}): Promise<ProvisionStatus> {
  if (modelReady(dir)) return "ready";
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const lock = `${dir}.lock`;
  if (!acquireLock(lock)) return "busy";
  try {
    if (modelReady(dir)) return "ready";
    await fetchModel(dir, opts);
    return "downloaded";
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}
