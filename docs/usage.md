# Usage notes

- **First launch** builds the app and indexes your transcripts in the background
  (a few seconds). The browse/search/analytics views populate once indexing
  finishes — `/api/health` reports `{"ready":true}` when it's done.
- **New sessions appear automatically.** The app re-scans on an interval
  (`REINDEX_INTERVAL_MS`, default 15s) and incrementally picks up new or updated
  transcripts — including the session you're currently running — without a
  restart. In an open session, hit **⟳ Refresh** (or ⌘R / Ctrl+R) to pull the
  latest messages in place without losing your scroll position. Each scan is
  near-free when nothing changed; you can also force one with `POST /api/reindex`.
- **Ranked search trails a live session by up to a minute.** Rebuilding the
  full-text index is the expensive part of a scan, so while a session keeps
  changing it is rebuilt at most every `FTS_REBUILD_MIN_INTERVAL_MS` and the
  first quiet scan (or `POST /api/reindex`) catches up. Session lists and
  analytics update on every scan, and **Exact** search is always current.
- **Live states are inferred from the transcript**, never from the agent
  process (which Claudescope never sees). A session is *idle* when its last
  turn ends in text, *working* or *running a tool* otherwise, and *possibly
  stuck* when it has written nothing for the threshold you pick — a long
  command and a pending approval look the same. What each agent cannot record
  shows as "not recorded" rather than zero: Copilot's cost lands only at session
  end, Antigravity records no tokens, mid-run messages between agents exist only
  for Claude Code and Codex, and Junie records no subagent linkage at all.
