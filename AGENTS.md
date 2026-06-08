# Agent guide

The full guidance for working in this repository — architecture, commands,
conventions, and gotchas — lives in [`CLAUDE.md`](./CLAUDE.md).

**Read `CLAUDE.md` first.** It is the single source of truth; this file exists so
agents that look for `AGENTS.md` are pointed there.

Quick essentials (see `CLAUDE.md` for the rest):

- Never write to `~/.claude` — it's the read-only data source. App state lives in
  `~/.claudescope/`.
- Run `npm test` and `npm run typecheck` after changes.
- Conventional Commits; no AI co-author trailers; keep linear history.
- When you do non-trivial work, commit a plan under `docs/plans/` and link it in
  the PR (see `docs/plans/README.md`).
