# 0093 — Extensions page

- **Status:** done
- **Date:** 2026-10-03
- **PR:** <https://github.com/vladar107/claudescope/pull/122>

## Context

The Skills area (plan 0088) shows what each agent can load from its home dir.
Skills are one of four ways people extend a coding agent; the other three —
**MCP servers**, **hooks**, and **plugins** — are configured just as
scattered across `~/.claude.json`, `~/.codex/config.toml`, `~/.junie/`,
`~/.copilot/`, `~/.grok/`, and `~/.config/opencode/`, and nothing shows them
side by side.

Usage is deliberately out of scope. MCP usage is recoverable for most agents
(Claude Code tool names, Codex `mcp_tool_call_end`), but hook runs are only
partly recorded (Claude Code persists async hook responses and Stop summaries,
not silent synchronous hooks), so a hook count would be a fabrication. This
plan is the installed inventory only; existing skill usage stays as it is.

Where each agent keeps them (user/global scope only):

| Agent | MCP servers | Hooks | Plugins |
|---|---|---|---|
| Claude Code | `~/.claude.json` `mcpServers` (+ `projects.<cwd>.mcpServers`) | `~/.claude/settings.json` `hooks` | `plugins/installed_plugins.json`; bundles `hooks/hooks.json`, `.mcp.json` |
| Codex | `config.toml` `[mcp_servers.*]` | `~/.codex/hooks.json` + `[[hooks.<Event>]]` in `config.toml` | `plugins/cache/` (+ `[plugins."x@mkt"] enabled`) |
| Junie | `~/.junie/mcp/mcp.json` | `~/.junie/config.json` `hooks` | `~/.junie/extensions/extensions.json` + install dirs |
| Copilot | `~/.copilot/mcp-config.json` | `~/.copilot/hooks/*.json` (camelCase events) | `~/.copilot/installed-plugins/<mkt>/<plugin>/` |
| Grok | `~/.grok/config.toml` `[mcp_servers.*]` | `~/.grok/hooks/*.json` | `~/.grok/plugins/` |
| opencode | `opencode.json(c)` `mcp` | — (code inside plugins) | `plugin` npm list + `plugins/*.{js,ts}` |
| pi | — (no built-in MCP) | — (code inside extensions) | `settings.json` `packages` + `extensions/` |
| Antigravity | — (undocumented) | — | — |

## Goal

Rename **Skills** to **Extensions**: one card per detected agent summarising
its skills, MCP servers, hooks, and plugins, drilling into a per-agent page with
a section per kind. Kinds an agent has no concept of read "not supported",
never an empty list.

## Decisions

- **Name: "Extensions"** — the umbrella term the agents' own docs use for
  skills/hooks/MCP/plugins; "Customizations" reads like settings, "Add-ons"
  like plugins only, "Capabilities" collides with `agent-capabilities.ts`.
  `/skills` and `/skills/:id` redirect to `/extensions…` so old links survive.
- **Read live, never indexed** — same as skills and memory. No index or
  schema change, no reindex.
- **Supported = the connector implements the hook** (`mcpServers?()`,
  `hooks?()`, `plugins?()` on `AgentConnector`), mirroring `skills?()`. An
  agent whose format has no such concept omits the method.
- **Global scope only** — agent home dirs, never project dirs (`.mcp.json`,
  `.claude/settings.json`, …), matching the skills invariant. Claude Code's
  per-project `mcpServers` live in the home-dir `~/.claude.json`, so they are
  in scope and carry the project path.
- **`~/.claude.json` is read for `mcpServers` only.** It also holds OAuth
  account data and machine ids; only the `mcpServers` subtrees are picked out,
  and neither the parsed object nor a parse error message is ever logged. It
  lives at `<claudeHome>/.claude.json` under `CLAUDE_CONFIG_DIR`, else beside
  `claudeHome()` — the reader checks both, in that order.
- **Codex `[hooks.state.*]` is trust state, not hooks** — only `trusted_hash`.
  Definitions are `[[hooks.<Event>]]` arrays (and `hooks.json`); `state` is
  skipped. The plugin cache is the plugin inventory (config lists only some);
  `[plugins."x"] enabled` and Claude Code's `enabledPlugins` only set an
  enabled flag, shown as a "disabled" chip.
- **Detection changes stay local.** `data/extensions.ts` counts an agent's own
  MCP/hook/plugin config as evidence it is installed; Memory and Skills keep
  their own detection. Supported-ness comes from method presence only, never
  a connector-id literal (`architecture-rules.test.ts`).
- **Secrets never leave the server.** MCP entries and hook commands routinely
  carry tokens. The API returns: server name, transport, `command` and
  redacted `args`, URL scheme+host+path (no query, no userinfo), and `env` /
  header KEY names only — never values. An arg is redacted when it follows or
  embeds a secret-looking flag (`--token`, `--api-key`, `*secret*`,
  `*password*`, `Authorization`, …) or looks like a credential (long
  high-entropy run, `Bearer …`, known key prefixes). Hook commands go through
  the same arg redaction. Redaction happens in the connector layer, so no raw
  value ever reaches `data/` or the route.
- **Plugin contents are attributed, not duplicated.** A plugin's MCP servers
  and hooks appear in their own sections tagged with the plugin; the plugin
  row shows counts of what it ships (skills, MCP servers, hooks, commands).
  Code plugins (opencode npm/local files, pi packages/extensions) are listed
  by name/file only — their contents are not knowable without executing them.
- **Antigravity stays unsupported** for all three kinds: no official docs and
  no local data to verify against; revisit when either exists.
- **pi MCP stays unsupported** — pi has no built-in MCP; the community
  adapter's `mcp.json` is a third-party convention.
- **TOML** (Codex, Grok) is parsed with `smol-toml` (zero-dependency, inlined by
  esbuild — only `@duckdb/node-api` stays external). A hand-rolled table
  scanner would mis-read inline tables and multi-line arrays, both common in
  `mcp_servers`. The lockfile change moves the `flake.nix` npm-deps hash.
- **JSONC** (opencode) uses a small string-aware comment/trailing-comma
  stripper — not worth a dependency.

## Approach

1. **Contract + shared parsers** — shared types (`McpServerEntry`,
   `HookEntry`, `PluginEntry`, `ExtensionsResponse`), the three optional
   connector methods, and `connectors/extensions/`: redaction, a Claude-shaped
   `mcpServers` normalizer (field aliases for the TOML and opencode shapes),
   a Claude-shaped hooks parser plus Copilot's variant, a plugin-contents
   reader (manifest `hooks`/`mcpServers`, defaults `hooks/hooks.json`,
   `.mcp.json`, `mcp.json`), JSONC stripper, TOML loader.
2. **Connectors** — Claude Code, Codex, Junie (Claude-shaped); Copilot, Grok,
   opencode, pi. Home dirs come from the existing `settings.ts` getters;
   `~/.claude.json` is derived beside `claudeHome()`.
3. **Data + route** — `data/extensions.ts` + `GET /api/extensions`: per
   detected agent, the three lists with `supported` flags, home dirs
   contracted. Agent detection also counts an own MCP/hook/plugin config as
   evidence. `/api/skills` is unchanged.
4. **Web** — rename to Extensions (nav, routes, redirects, `pages/extensions/`),
   landing cards with per-kind counts, agent page with Skills / MCP servers /
   Hooks / Plugins tabs (open tab kept in `?tab=`) reusing the skills table
   styling.
5. **Tests** — the weird stuff only: a fitness test that plants secrets in
   every connector's fixture config and asserts none reaches the response;
   malformed/missing configs yield `[]`; registry conformance (a connector
   with config files of a kind must declare it or be listed as unsupported).

## Files affected

- `packages/shared/src/api.ts` — new inventory types.
- `packages/server/src/connectors/types.ts` — `mcpServers?`, `hooks?`, `plugins?`.
- `packages/server/src/connectors/extensions/*` — shared parsers, redaction.
- `packages/server/src/connectors/<agent>/extensions.ts` — per-agent readers.
- `packages/server/src/data/extensions.ts`, `routes/extensions.ts`,
  `routes/index.ts`.
- `packages/web/src/pages/extensions/*` (moved from `pages/skills/`),
  `App.tsx`, `api/client.ts`.
- `packages/server/package.json`, `package-lock.json` — `smol-toml`.
- `flake.nix` — npm-deps hash for the new lockfile.
- `packages/server/test/extensions-*.test.ts` — redaction fitness, parsers.

## Testing

- A secret planted in every source shape — `env`/`environment` value, header
  value, `--token X`, `--api-key=X`, `Bearer …`, `sk-…`/`ghp_…`, URL
  query/userinfo/path token, hook `FOO=secret cmd`, plugin `.mcp.json`, the
  `~/.claude.json` OAuth block — appears nowhere in the serialized
  `/api/extensions` response.
- A missing or malformed file of every kind yields `[]`; a throwing connector
  never blocks the other agents.
- Antigravity reads "not supported" for all three kinds; pi for MCP and hooks.
- `/skills` and `/skills/:id` redirect; `/api/skills` and its tests are unchanged.
- `npm test`, `npm run typecheck`, `npm run bundle`, CI `nix` job green.
- `/verify` sandbox with fixture configs for every agent: screenshots of the
  landing and an agent page.

## Risks / open questions

- Undocumented corners (Copilot plugin hook declaration, Grok plugin manifest
  name, Junie extension manifest fields) are read best-effort with the
  Claude-plugin layout; a miss shows fewer items, never an error.
- Redaction is heuristic for free-form args and hook commands; the fitness test
  pins the known shapes, and values in `env`/`headers` are never read out at all.
- Follow-up: Junie extensions also ship skills, which the Skills section does
  not list yet.
- Each request reads every plugin bundle once per kind (three passes); fine
  at today's plugin counts, a per-request memo if that changes.
