# Cost methodology

Cost is an **estimate computed locally** from token usage — Claudescope has no
access to your real billing. For every **assistant** event (the events that carry
`usage`), it sums each token type times its per-million-token rate:

```
cost = ( input_tokens          × input_rate
       + output_tokens         × output_rate
       + cache_creation_tokens × cache_write_rate
       + cache_read_tokens     × cache_read_rate ) ÷ 1,000,000
```

The per-event cost is computed once at index time and stored, so analytics is
just a `SUM` over events; a project/session total is the sum of its events.

Rates are resolved in a layered lookup:

1. **Provider override** — if the agent recorded which model *provider* served
   the response (pi, Codex, and opencode do) and it matches an entry in
   `pricing.json`'s `providers` map (matched case-insensitively), that entry's
   rates apply outright and the steps below are skipped — this is how local
   runtimes are zero-rated regardless of what model id they report. The
   shipped default zero-rates nine known local-runtime ids: `ollama`,
   `lmstudio`, `lm-studio`, `llama.cpp`, `llamacpp`, `vllm`, `oss`, `local`,
   `mlx`. Add your own id to `providers` (e.g. a custom Ollama gateway key) to
   zero-rate it too.
2. **Fetched exact id** — `~/.claudescope/pricing.fetched.json` (auto-refreshed
   daily from [LiteLLM's community price table](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json),
   covering Anthropic, OpenAI, Gemini, xAI, Mistral, and DeepSeek models).
3. **Local exact id** — `~/.claudescope/pricing.json` (seeded on first run from
   the shipped default; user-editable; takes precedence over the fetched snapshot
   for any id it defines explicitly).
4. **Family match** — `opus` / `sonnet` / `haiku` / `gemini` / `gpt` substring in
   the model id → the matching family rate from `pricing.json`.
5. **Default** — the `default` entry in `pricing.json`.

The family step means version- or date-suffixed ids (e.g. `claude-haiku-4-5-20251001`,
`gpt-5.x-codex`, `gemini-2.5-flash`) still price correctly. `pricing.json` is the
user-editable fallback and override layer for families and the default rate; the
fetched snapshot provides exact per-model rates for all known models.

Claude Code, Junie, Copilot CLI, Antigravity, and Grok CLI record no model provider in
their transcripts, so a local run there can't be auto-detected via step 1 — the
escape hatch is pinning the exact model id to a zero rate in `pricing.json`'s
`models` section.

Shipped fallback rates (USD per 1M tokens):

| family / model      | input | output | cache write (5m) | cache read |
| ------------------- | ----- | ------ | ---------------- | ---------- |
| Opus 4.5–4.8        | $5    | $25    | $6.25            | $0.50      |
| Opus 4.1 / 4        | $15   | $75    | $18.75           | $1.50      |
| Sonnet 4.x          | $3    | $15    | $3.75            | $0.30      |
| Haiku 4.5           | $1    | $5     | $1.25            | $0.10      |
| Gemini 2.5 Pro-class| $1.25 | $10    | —                | $0.31      |
| Grok 4.5-class      | $2    | $6     | —                | $0.50      |
| GPT-5               | $0.63 | $5     | —                | $0.13      |
| GPT-5.4             | $2.50 | $15    | —                | $0.50      |
| GPT-5.5             | $5    | $30    | —                | $0.50      |
| `<synthetic>`       | $0    | $0     | $0               | $0         |

- Rates **auto-refresh daily** in the background while the server runs. Run
  `claudescope pricing update` to force a refresh at any time. New rates apply
  to newly indexed events; existing indexed costs are unchanged.
- Edit `~/.claudescope/pricing.json` to override families, the default rate,
  specific model prices, or the `providers` map. Pricing changes apply
  **prospectively**: cost is stamped per event at index time, so an edit only
  affects events indexed *after* the change — re-indexing (`POST /api/reindex`
  or `claudescope restart`) picks up new/changed files at the new rates but
  does not recompute costs already stored for unchanged files. A full re-price
  of your whole history happens only when the index itself is rebuilt from
  scratch — an app upgrade that bumps the schema, corruption recovery, or
  manually deleting `~/.claudescope/index.duckdb*` (it's a derived cache, safe
  to delete; it rebuilds from your transcripts).
- `pricing.json` carries a `schemaVersion`. When an upgrade ships a newer default
  (new families/models or a changed default rate), the app **reconciles your copy
  on startup**: it backs the old file up to `pricing.json.bak`, adds the new
  shipped keys, and **keeps every value you customized**. Your edits are never
  discarded; a copy you've left current is not rewritten.
- The `opus`/`sonnet`/`haiku`/`gemini`/`gpt` family rules use **current**
  pricing; the deprecated Opus 4 / 4.1 ($15/$75) and specific GPT-5 versions are
  pinned via exact `models` entries. Add an exact entry to override any model.

> **Caveat:** these are **list-price estimates** — they ignore any discounts,
> service tier, or batch pricing, and the cache-write rate assumes the 5-minute
> TTL. Treat totals as approximate and best for *relative* comparison
> (project vs project, day vs day), not as an invoice.

The **"Input from cache"** stat is a separate metric:
`cache_read ÷ (cache_read + cache_creation + input)` — the share of prompt tokens
served from cache (legitimately high for Claude Code, which re-reads cached context each turn).
