import fs from "node:fs";
import path from "node:path";

interface Meta {
  dims: number;
  rows: number;
  rowBytes: number;
}

const PUNCT = /[\p{P}\p{S}]/u;
const CJK = /[\u4E00-\u9FFF\u3400-\u4DBF\u{20000}-\u{2A6DF}\u{2A700}-\u{2B73F}\u{2B740}-\u{2B81F}\u{2B820}-\u{2CEAF}\uF900-\uFAFF\u{2F800}-\u{2FA1F}]/u;
const MAX_TOKENS = 512;

function isAsciiPunct(cp: number): boolean {
  return (cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126);
}

export function bertPreTokenize(text: string): string[] {
  let cleaned = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0 || cp === 0xfffd) continue;
    if (/\s/u.test(ch)) {
      cleaned += " ";
      continue;
    }
    if (/\p{Cc}|\p{Cf}/u.test(ch)) continue;
    cleaned += CJK.test(ch) ? ` ${ch} ` : ch;
  }
  const normalized = cleaned.normalize("NFD").replace(/\p{Mn}/gu, "").toLowerCase();
  const out: string[] = [];
  for (const chunk of normalized.split(" ")) {
    if (!chunk) continue;
    let current = "";
    for (const ch of chunk) {
      if (isAsciiPunct(ch.codePointAt(0)!) || PUNCT.test(ch)) {
        if (current) out.push(current);
        out.push(ch);
        current = "";
      } else {
        current += ch;
      }
    }
    if (current) out.push(current);
  }
  return out;
}

export class StaticEmbedder {
  readonly dims: number;
  private readonly vocab: Map<string, number>;
  private readonly unk: number;
  private readonly fd: number;
  private readonly meta: Meta;
  private readonly cache = new Map<number, Float32Array>();
  private readonly rowBuffer: Buffer;

  constructor(modelDir: string) {
    this.meta = JSON.parse(fs.readFileSync(path.join(modelDir, "meta.json"), "utf8"));
    this.dims = this.meta.dims;
    const list: string[] = JSON.parse(fs.readFileSync(path.join(modelDir, "vocab.json"), "utf8"));
    this.vocab = new Map(list.map((t, i) => [t, i]));
    this.unk = this.vocab.get("[UNK]") ?? 100;
    this.fd = fs.openSync(path.join(modelDir, "table.bin"), "r");
    this.rowBuffer = Buffer.alloc(this.meta.rowBytes);
  }

  static tryLoad(modelDir: string): StaticEmbedder | undefined {
    try {
      return new StaticEmbedder(modelDir);
    } catch {
      return undefined;
    }
  }

  tokenize(text: string): number[] {
    const ids: number[] = [];
    for (const word of bertPreTokenize(text)) {
      if (ids.length >= MAX_TOKENS) break;
      const chars = [...word];
      if (chars.length > 100) {
        ids.push(this.unk);
        continue;
      }
      const pieces: number[] = [];
      let start = 0;
      let bad = false;
      while (start < chars.length) {
        let end = chars.length;
        let found: number | undefined;
        while (start < end) {
          const sub = (start > 0 ? "##" : "") + chars.slice(start, end).join("");
          const id = this.vocab.get(sub);
          if (id !== undefined) {
            found = id;
            break;
          }
          end--;
        }
        if (found === undefined) {
          bad = true;
          break;
        }
        pieces.push(found);
        start = end;
      }
      if (bad) ids.push(this.unk);
      else ids.push(...pieces);
    }
    return ids.slice(0, MAX_TOKENS);
  }

  private row(id: number): Float32Array {
    const hit = this.cache.get(id);
    if (hit) return hit;
    fs.readSync(this.fd, this.rowBuffer, 0, this.meta.rowBytes, id * this.meta.rowBytes);
    const scale = this.rowBuffer.readFloatLE(0);
    const vec = new Float32Array(this.dims);
    for (let d = 0; d < this.dims; d++) vec[d] = this.rowBuffer.readInt8(4 + d) * scale;
    if (this.cache.size > 20000) this.cache.clear();
    this.cache.set(id, vec);
    return vec;
  }

  embed(text: string): Float32Array {
    const ids = this.tokenize(text);
    const out = new Float32Array(this.dims);
    if (ids.length === 0) return out;
    for (const id of ids) {
      const v = this.row(id);
      for (let d = 0; d < this.dims; d++) out[d] += v[d];
    }
    let norm = 0;
    for (let d = 0; d < this.dims; d++) norm += out[d] * out[d];
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < this.dims; d++) out[d] /= norm;
    return out;
  }

  close(): void {
    try {
      fs.closeSync(this.fd);
    } catch {}
  }
}

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function toBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

export function fromBlob(b: Uint8Array): Float32Array {
  const copy = new Uint8Array(b.byteLength);
  copy.set(b);
  return new Float32Array(copy.buffer);
}
