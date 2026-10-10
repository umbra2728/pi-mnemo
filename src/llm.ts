export interface ModelRef {
  provider: string;
  id: string;
}

export const DEFAULT_MODELS: ModelRef[] = [
  { provider: "anthropic", id: "claude-haiku-5-5" },
  { provider: "openai", id: "gpt-6-luna" },
];

export interface Registry {
  find(provider: string, id: string): unknown;
  streamSimple(model: any, context: any, options?: any): { result(): Promise<any> };
}

export interface LlmResult<T> {
  value: T;
  model: string;
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };
}

export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const starts = [body.indexOf("{"), body.indexOf("[")].filter((i) => i >= 0);
  if (starts.length === 0) throw new Error("no JSON in model output");
  const start = Math.min(...starts);
  const open = body[start];
  const close = open === "{" ? "}" : "]";
  const end = body.lastIndexOf(close);
  if (end <= start) throw new Error("unterminated JSON in model output");
  return JSON.parse(body.slice(start, end + 1));
}

export async function completeJson<T>(
  registry: Registry,
  system: string,
  user: string,
  opts: { models?: ModelRef[]; maxTokens?: number; signal?: AbortSignal; validate?: (v: unknown) => T } = {},
): Promise<LlmResult<T>> {
  const errors: string[] = [];
  for (const ref of opts.models ?? DEFAULT_MODELS) {
    const model = registry.find(ref.provider, ref.id);
    if (!model) {
      errors.push(`${ref.provider}/${ref.id}: not found`);
      continue;
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const msg = await registry
          .streamSimple(
            model,
            { systemPrompt: system, messages: [{ role: "user", content: user, timestamp: Date.now() }] },
            { maxTokens: opts.maxTokens ?? 8000, signal: opts.signal },
          )
          .result();
        if (msg.stopReason === "error" || msg.stopReason === "aborted") throw new Error(msg.errorMessage ?? msg.stopReason);
        const text = (msg.content ?? [])
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("");
        const parsed = extractJson(text);
        const value = opts.validate ? opts.validate(parsed) : (parsed as T);
        return { value, model: `${ref.provider}/${ref.id}`, usage: msg.usage };
      } catch (e) {
        if (opts.signal?.aborted) throw e;
        errors.push(`${ref.provider}/${ref.id}#${attempt + 1}: ${(e as Error).message}`);
      }
    }
  }
  throw new Error(`all models failed: ${errors.join(" | ")}`);
}
