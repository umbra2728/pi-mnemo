import type { Registry } from "./llm.ts";
import type { Store } from "./store.ts";
import { runCheckpoint, runDigest, runEnrich } from "./writer.ts";

const LEASE_MS = 6 * 60_000;
const MAX_ATTEMPTS = 6;

export class JobRunner {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active = 0;
  private stopped = true;
  private readonly abort = new AbortController();
  private readonly claimed = new Set<number>();
  lastError: string | undefined;
  lastResult: string | undefined;

  constructor(
    private readonly store: Store,
    private readonly registry: Registry,
    private readonly concurrency = 2,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(1500);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.abort.abort();
    for (const id of this.claimed) {
      try {
        this.store.failJob(id, "interrupted", 0);
      } catch {}
    }
    this.claimed.clear();
  }

  kick(): void {
    if (!this.stopped) this.schedule(50);
  }

  get busy(): number {
    return this.active;
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), ms);
    (this.timer as { unref?: () => void }).unref?.();
  }

  private tick(): void {
    this.timer = undefined;
    if (this.stopped) return;
    let started = 0;
    while (this.active < this.concurrency) {
      let job;
      try {
        job = this.store.claimJob(LEASE_MS);
      } catch (e) {
        this.lastError = (e as Error).message;
        break;
      }
      if (!job) break;
      started++;
      this.active++;
      this.claimed.add(job.id);
      const id = job.id;
      this.run(job).finally(() => {
        this.claimed.delete(id);
        this.active--;
        this.schedule(200);
      });
    }
    if (!started && this.active === 0) this.schedule(5000);
  }

  private async run(job: { id: number; kind: string; payload: any; attempts: number }): Promise<void> {
    const w = { store: this.store, registry: this.registry, signal: this.abort.signal, log: this.log };
    try {
      let result: string;
      if (job.kind === "checkpoint") result = await runCheckpoint(w, job.payload);
      else if (job.kind === "digest") result = await runDigest(w, job.payload);
      else if (job.kind === "enrich") result = await runEnrich(w, job.payload);
      else result = `unknown job kind ${job.kind}`;
      this.store.finishJob(job.id);
      this.lastResult = `${job.kind}: ${result}`;
      this.log(this.lastResult);
    } catch (e) {
      if (this.stopped) return;
      const msg = (e as Error).message ?? String(e);
      this.lastError = `${job.kind}: ${msg}`;
      this.log(`job ${job.id} failed: ${this.lastError}`);
      try {
        this.store.failJob(job.id, msg, job.attempts >= MAX_ATTEMPTS ? null : Math.min(30 * 60_000, 30_000 * 2 ** job.attempts));
      } catch {}
    }
  }
}
