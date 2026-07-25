# Architecture

Claudescope drawn as [C4 model](https://c4model.com) diagrams — level 1 (system
context), level 2 (containers), and level 3 (components of the server package).
[`CLAUDE.md`](../CLAUDE.md) stays the prose source of truth for the
architecture, the runtime-state rules, and the per-connector quirks; this file
only visualizes it. For the dev loop and the connector checklist see
[`CONTRIBUTING.md`](../CONTRIBUTING.md).

The diagrams keep C4's element kinds and colors — person, system, container,
component, external system, datastore — but are drawn as Mermaid **flowcharts**
rather than Mermaid's native `C4*` syntax, which overlaps relationship labels
with boxes once a diagram has more than a handful of elements.

## Level 1 — System context

Claudescope is a local, single-user tool: one developer, one machine. It reads
the on-disk transcript stores of eight coding agents **read-only**, indexes them
into its own cache, and serves a browser UI plus a JSON API on one port. Coding
agents can query the same read paths over MCP. Outbound network traffic is
limited to the daily model-rate refresh used to estimate cost, plus a
once-a-day update-availability check against the npm registry (omitted from
the diagram).

```mermaid
flowchart TB
    dev(["<b>Developer</b><br/><i>person</i><br/>works with AI coding agents"]):::person
    cs["<b>Claudescope</b><br/><i>software system — local and read-only</i><br/>merges every agent's transcripts into one<br/>browsable searchable index per project"]:::sys
    stores["<b>Agent transcript stores</b><br/><i>external system — read-only sources</i><br/>Claude Code · Codex · Junie · pi · opencode<br/>Copilot CLI · Antigravity · Grok"]:::ext
    litellm["<b>LiteLLM pricing data</b><br/><i>external system</i><br/>public model rate table"]:::ext
    agents["<b>MCP clients and coding agents</b><br/><i>external system</i><br/>query their own past sessions"]:::ext

    dev -- "browses reads searches analyzes<br/>[browser on localhost 4317]" --> cs
    dev -- "runs commands<br/>[claudescope CLI in a terminal]" --> cs
    agents -- "searches sessions projects analytics memory<br/>[MCP over stdio]" --> cs
    cs -- "discovers and reads transcripts — never writes<br/>[JSONL and SQLite files]" --> stores
    cs -- "refreshes model rates once a day<br/>[HTTPS]" --> litellm

    classDef person fill:#08427b,stroke:#052e56,color:#ffffff
    classDef sys fill:#1168bd,stroke:#0b4884,color:#ffffff
    classDef ext fill:#8a8a8a,stroke:#5c5c5c,color:#ffffff
```

## Level 2 — Containers

The daemon is one Fastify process serving **both** the JSON API and the built
SPA on port 4317; the CLI spawns and controls that process. The indexer is drawn
as its own container for clarity but runs **in-process inside the daemon**
(`indexer-lifecycle.ts`) — the web Settings page's Start/Stop/Restart control
that poller, never the HTTP process, which stays terminal-only. The DuckDB index
is a derived cache: fully rebuildable from the transcripts, discarded and
rebuilt if corrupt. All app-owned state lives in `~/.claudescope/`, where env
vars always win over `settings.json`.

```mermaid
flowchart TB
    dev(["<b>Developer</b><br/><i>person</i><br/>browser plus terminal"]):::person

    subgraph cs["Claudescope — one machine, one user"]
        direction TB
        cli["<b>CLI</b><br/><i>Node ESM bundle</i><br/>start · stop · status · logs · query subcommands<br/>spawns and controls the daemon"]:::sys
        spa["<b>Web UI</b><br/><i>React and Vite SPA</i><br/>runs in the browser"]:::sys
        daemon["<b>Daemon</b><br/><i>Fastify on Node</i><br/>serves the JSON API AND the built SPA<br/>on one port 4317"]:::sys
        indexer["<b>Indexer</b><br/><i>reindex poller — in the daemon process</i><br/>start · stop · restart from the Settings page"]:::sys
        mcp["<b>MCP server</b><br/><i>claudescope mcp — stdio JSON-RPC</i><br/>proxies the running daemon"]:::sys
        idx[("<b>DuckDB index</b><br/><i>~/.claudescope</i><br/>derived cache — rebuilt if corrupt")]:::db
        state[("<b>State dir</b><br/><i>~/.claudescope</i><br/>settings.json · pricing.json<br/>pricing.fetched.json · daemon.json · logs")]:::db
    end

    stores["<b>Agent transcript stores</b><br/><i>8 agents — JSONL and SQLite</i>"]:::ext
    litellm["<b>LiteLLM pricing data</b><br/><i>public model rate table</i>"]:::ext
    client["<b>MCP client or coding agent</b><br/><i>asks about its own history</i>"]:::ext

    dev -- "reads and searches<br/>[browser]" --> spa
    dev -- "runs commands<br/>[terminal]" --> cli
    cli -- "spawns stops queries<br/>[child process · loopback HTTP]" --> daemon
    spa -- "loads assets and calls /api<br/>[JSON over HTTP]" --> daemon
    client -- "tool calls<br/>[MCP over stdio]" --> mcp
    mcp -- "proxies every read<br/>[loopback HTTP]" --> daemon
    daemon -- "start stop pause<br/>[in-process]" --> indexer
    daemon -- "lists searches aggregates<br/>[DuckDB]" --> idx
    daemon -- "session transcript and memory<br/>[read-only]" --> stores
    daemon -- "settings and pricing layers" --> state
    daemon -- "daily rate refresh<br/>[HTTPS]" --> litellm
    indexer -- "discovers changed files<br/>[read-only]" --> stores
    indexer -- "upserts events · rebuilds FTS" --> idx

    classDef person fill:#08427b,stroke:#052e56,color:#ffffff
    classDef sys fill:#1168bd,stroke:#0b4884,color:#ffffff
    classDef db fill:#2e7cbf,stroke:#0b4884,color:#ffffff
    classDef ext fill:#8a8a8a,stroke:#5c5c5c,color:#ffffff
    style cs fill:none,stroke:#8a8a8a,stroke-dasharray: 6 4
```

## Level 3 — Components of the server package

The interesting seam is the connector pipeline. Each agent is one connector
implementing the `AgentConnector` port; Claude Code JSONL is projected per row,
while every other agent runs a `prepare()` pass that normalizes a session to
**canonical NDJSON** first. Everything below that boundary — the canonical
schema, indexing, full-text search, cost, threading, and the UI — is
agent-agnostic and shared, so **adding an agent means adding a connector and the
shared paths stay untouched**. DuckDB reads the NDJSON natively via
`read_ndjson`, which keeps indexing, search, and analytics in the database;
only the threaded view of a single session is assembled in TypeScript.

```mermaid
flowchart TB
    spa["<b>Web UI</b><br/><i>React SPA in the browser</i>"]:::sys
    client["<b>MCP client or coding agent</b><br/><i>external</i>"]:::ext

    subgraph server["packages/server — the daemon process"]
        direction TB
        subgraph surface["HTTP and MCP surface"]
            direction LR
            routes["<b>routes/</b><br/><i>Fastify route modules</i><br/>projects · sessions · search · analytics<br/>memory · pricing · settings · indexer · sources · system"]:::sys
            agentapi["<b>agent/</b><br/><i>MCP stdio server</i><br/>mcp · query · shape · api-client"]:::sys
        end
        subgraph proc["Process and configuration"]
            direction LR
            entry["<b>cli.ts · daemon.ts</b><br/><i>entry points</i><br/>commands plus detached daemon lifecycle"]:::sys
            lifecycle["<b>indexer-lifecycle.ts</b><br/><i>owns the reindex poller</i><br/>start · stop · pause · restart<br/>never the HTTP process"]:::sys
            settings["<b>settings.ts · config.ts</b><br/><i>resolved per call</i><br/>env then settings.json then default"]:::sys
        end
        subgraph domain["data/ — agent-agnostic domain"]
            direction LR
            dataindex["<b>index.ts</b><br/><i>incremental indexer</i><br/>skips files unchanged by mtime and size<br/>derived tables · FTS · cost per event"]:::sys
            loader["<b>parser.ts · session-loader.ts</b><br/><i>threaded view of one session</i><br/>subagent nesting · file edits"]:::sys
            pricing["<b>pricing.ts · pricing-refresh.ts</b><br/><i>rates and cost estimate</i><br/>fetched snapshot over shipped defaults"]:::sys
            memory["<b>memory.ts</b><br/><i>agent memory</i><br/>global and project scope"]:::sys
        end
        subgraph seam["connectors/ — the only per-agent code"]
            direction LR
            registry["<b>registry.ts · types.ts</b><br/><i>AgentConnector port</i><br/>discover · prepare · projection SQL<br/>loadSession · memory"]:::sys
            conns["<b>one connector per agent — 8 of them</b><br/>Claude Code projects per row<br/>the others prepare canonical NDJSON first"]:::sys
        end
        db["<b>db/</b><br/><i>DuckDB access — duckdb · schema · row</i><br/>read_ndjson reads the NDJSON natively"]:::sys
    end

    stores["<b>Agent transcript stores</b><br/><i>read-only JSONL and SQLite</i>"]:::ext
    litellm["<b>LiteLLM pricing data</b><br/><i>external</i>"]:::ext
    idx[("<b>DuckDB index</b><br/>events · sessions · FTS · cost")]:::db
    state[("<b>~/.claudescope</b><br/>settings and pricing files")]:::db

    spa -- "fetches data [JSON over HTTP]" --> routes
    client -- "tool calls [MCP over stdio]" --> agentapi
    agentapi -- "proxies every read [loopback HTTP]" --> routes
    entry -- "registers the API and the SPA" --> routes
    entry -- "starts the indexer at boot" --> lifecycle
    routes -- "start stop restart status" --> lifecycle
    routes -- "one threaded session" --> loader
    routes -- "memory per agent" --> memory
    routes -- "lists searches aggregates [SQL]" --> db
    routes -- "reads and writes settings" --> settings
    lifecycle -- "runs a pass on an interval" --> dataindex
    dataindex -- "discovery and projection SQL per agent" --> registry
    dataindex -- "upserts canonical events · rebuilds FTS" --> db
    dataindex -- "stamps cost at index time" --> pricing
    registry -- "delegates to the matching connector" --> conns
    loader -- "loadSession per agent" --> conns
    memory -- "globalMemory and projectMemory" --> conns
    conns -- "reads and normalizes [read-only]" --> stores
    db -- "reads and writes" --> idx
    pricing -- "daily rate refresh [HTTPS]" --> litellm
    pricing -- "overrides and fetched snapshot" --> state
    settings -- "settings.json" --> state

    classDef sys fill:#1168bd,stroke:#0b4884,color:#ffffff
    classDef db fill:#2e7cbf,stroke:#0b4884,color:#ffffff
    classDef ext fill:#8a8a8a,stroke:#5c5c5c,color:#ffffff
    style server fill:none,stroke:#8a8a8a,stroke-dasharray: 6 4
    style surface fill:#f4f7fa,stroke:#c8d3de
    style proc fill:#f4f7fa,stroke:#c8d3de
    style domain fill:#f4f7fa,stroke:#c8d3de
    style seam fill:#f4f7fa,stroke:#c8d3de
```
