# Command line

## Commands

```bash
claudescope            # = claudescope start
claudescope start      # start in the background (idempotent), open the browser
claudescope stop       # stop the background server
claudescope restart    # restart it
claudescope status     # is it running? is an update available?
claudescope open       # start if needed, then open the app in your browser
claudescope open --session <id> [--around <uuid>]  # open an exact session/message
claudescope logs -f    # tail the server log
claudescope update          # upgrade to the latest published version and restart
claudescope pricing update  # fetch current model prices (LiteLLM) into the local rate table
claudescope help            # full usage

# options: --port <n>   (default 4317, or $PORT)
#          --no-open    (don't open the browser on start)
```

Updating later is just `claudescope update` (or `npm i -g @vladar107/claudescope@latest`).

## Scripting

The same lookups work from the terminal — read-only query subcommands that
start the background server on first use and print tables (or raw JSON with
`--json`, handy with `jq`):

```bash
claudescope search "duckdb lock" --limit 5      # where did I hit this before?
claudescope search --literal "ENOENT: no such file" --limit 5  # exact string, no ranking
claudescope sessions --agent codex --sort cost  # priciest Codex sessions
claudescope sessions --cwd "$PWD" --branch "$(git rev-parse --abbrev-ref HEAD)" # this project + branch
claudescope session <id> --around <uuid>        # open a search hit, windowed
claudescope session <id> --tail 20              # last 20 turns
claudescope open --session <id> --around <uuid> # open that hit in the web app
claudescope analytics --group-by day --timezone Europe/Amsterdam --json | jq '.rows[] | [.key, .costUsd]'
claudescope digest --from 2026-06-23 --to 2026-06-29 --timezone Europe/Amsterdam
claudescope live --window 5                     # what each agent is doing right now
```

`live` is the one query that never starts the server: when it is not running it
prints an error and exits with code 3, so a poller can't undo `claudescope stop`.
A server that is running but not answering exits with code 4 instead.
`--full` keeps the last assistant text's newlines and returns up to 4000
characters of it and of each open tool call's input.

`--literal` matches the query as one case-insensitive substring over transcript
text, failed tool-result bodies, tool names and skill names (newest first, no
ranking) — the way to find an error message the agent never restated in prose.

`sessions --cwd <path>` resolves to the project for that working directory
locally, without a separate `projects` lookup, and is exclusive with
`--project`; `--branch <name>` filters to that git branch; `--q <text>` matches
the title, branch, id, or model; `--limit/--offset` page the list (20 rows by
default). `session` prints a
pageable window of turns as Markdown (`--offset/--limit`, `--redact` to mask
paths/secrets); `--tail N` prints only the last N turns and is exclusive with
`--offset/--limit/--around`. `--json` returns the raw API response unredacted.
`open` starts the daemon lazily and preserves its configured port; session ids
and message anchors are URL-encoded before the browser opens. See
`claudescope help` for the full flag list.

Analytics and digest date-only bounds are inclusive calendar days in the
selected IANA time zone. The CLI defaults to the machine's time zone (falling
back to UTC); use `--timezone UTC` or another zone to make a script explicit.
ISO timestamps with `Z` or an offset always identify exact instants, while the
time zone still controls day grouping and streaks. The MCP `get_analytics` tool
accepts the equivalent optional `timeZone` input and has the same local default.
Claudescope keeps indexed timestamps UTC-normalized; the selected zone changes
query interpretation, not stored transcript data.
