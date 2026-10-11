# pi-mnemo

Token-frugal long-term memory for [pi](https://pi.dev). Adds ~600 input tokens per request (two tools + one guideline) instead of ~10k for heavier memory extensions.

## Install

```bash
pi install npm:pi-mnemo
```

On the first interactive start pi downloads the search model (~55 MB) in the background. Until it arrives, memory still works with text search only.

## How it works

- **Storage**: `~/.pi/agent/mnemo/mnemo.db` (built-in `node:sqlite`, WAL, shared by all pi processes).
- **Memories** are English notes (`fact`, `preference`, `decision`, `pitfall`, `procedure`), global or per project (git root name). Each has English tags and a hidden Russian search field (`ru`) so Russian prompts still match English memories.
- **Search**: FTS5 over Russian/English Snowball stems + static multilingual embeddings (`static-similarity-mrl-multilingual-v1`, 512 dims, int8) read row-by-row from disk, fused with reciprocal rank fusion. ~2 ms per query, no resident model.
- **Auto-recall**: on every non-trivial user prompt, up to 3 memories that pass a calibrated gate are injected as a `<memory>` message. Memories already shown in a session are not repeated.
- **Error hints**: when a tool fails, the error is matched against stored memories (stricter gate, at most once per 10 tool calls) and a hint is appended to the tool result.
- **Background writer**: checkpoints after each agent run, every 25 tool calls or ~60k chars during long runs (at most every 5 min), before compaction and at shutdown. A job reads the new slice of the session file, shows `claude-haiku-5-5` (fallback `gpt-6-luna`) the slice plus related memories, and applies `add` / `update` / `supersede` operations and a rolling session digest. Jobs live in SQLite with leases, so they survive restarts and run in any interactive pi process.
- **Tools**: `recall({queries[], scope?, kinds?, sessions?, limit?})` and `remember({text, kind, scope?, replaces?})`. Both return `structuredContent`, so codemode scripts get plain objects; usage notes live in the `mnemo` namespace instructions (`describeNamespace("mnemo")`).
- **Secrets** are redacted before anything is sent to a model or stored.

## Commands

`/mnemo stats | search <q> | show <id> | forget <id> | import-hermes [enrichment.json] | backfill | enrich`

CLI (works from the installed package too): `npx pi-mnemo fetch-model | import-hermes | backfill | search <q> | stats`. Inside pi's package directory: `node ~/.pi/agent/npm/node_modules/pi-mnemo/bin/pi-mnemo.mjs <command>`.

## Environment

| Variable | Meaning |
|---|---|
| `MNEMO_DIR` | data directory (default `~/.pi/agent/mnemo`) |
| `MNEMO_RUNNER=1` | run background jobs in print mode too |
| `MNEMO_CONCURRENCY` | parallel background jobs per process (default 2) |

Subagent children (`PI_SUBAGENT_CHILD`) can recall but never run the background writer.

## Development

```bash
npm ci
npm run fetch-model
npm test
```

`eval/bench.ts` replays the retrieval benchmark. Its data (real memories and queries) is local only and not committed.

## Releasing

CI (`.github/workflows/publish.yml`) publishes to npm when a `v*` tag is pushed. Publishing uses npm trusted publishing, so no token is stored in GitHub.

```bash
npm version patch        # bumps package.json, commits, creates tag vX.Y.Z
git push --follow-tags   # the workflow tests, checks the tag matches, publishes
```
