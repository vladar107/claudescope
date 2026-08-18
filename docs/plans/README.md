# Plans

Implementation plans for non-trivial work live here, committed alongside the code
they describe. The goal: when work is planned (especially by an agent), the
reasoning and decisions are recorded in the repo — not lost in a chat.

## When to write one

Write a plan for anything non-trivial: work touching 2+ files, an architectural
decision, or a change worth explaining before doing. Skip it for one-line fixes.

**If an agent did the work, committing the plan is required** (see
`CONTRIBUTING.md`). Link the plan from the PR.

## Convention

- One file per plan: `NNNN-kebab-title.md`, zero-padded sequential (`0001-…`,
  `0002-…`). The number is a stable reference.
- Start from [`TEMPLATE.md`](./TEMPLATE.md).
- Keep the `Status` field current: `proposed` → `in-progress` → `done`
  (or `superseded` / `abandoned`).
- Update a plan as the approach changes; plans are living records, not frozen.

## Index

| #    | Title                                            | Status |
| ---- | ------------------------------------------------ | ------ |
| 0001 | [npm distribution](./0001-npm-distribution.md)   | done   |
| 0002 | [in-place session refresh](./0002-session-refresh.md) | done |
| 0003 | [performance test suite](./0003-performance-test-suite.md) | done |
| 0004 | [connector seam](./0004-connector-seam.md) | done |
| 0005 | [codex connector](./0005-codex-connector.md) | done |
| 0006 | [multi-agent UX](./0006-multi-agent-ux.md) | done |
| 0007 | [UI redesign: multi-agent, light/dark, responsive nav](./0007-ui-redesign-multi-agent.md) | done |
| 0008 | [Junie connector](./0008-junie-connector.md) | done |
| 0009 | [Homebrew + Nix distribution](./0009-homebrew-nix-distribution.md) | done |
| 0010 | [runtime pricing refresh](./0010-runtime-pricing-refresh.md) | done |
| 0011 | [performance: search, scrolling, bench](./0011-performance-search-scroll-bench.md) | done |
| 0012 | [cost dedup: billed API calls](./0012-cost-dedup-billed-api-calls.md) | done |
| 0013 | [Codex review fixes: project ids, aux rows, images](./0013-codex-review-fixes.md) | done |
| 0014 | [Memory viewer (instruction files + per-agent memory)](./0014-memory-viewer.md) | done   |
| 0015 | [Shared project header (nested layout route)](./0015-shared-project-header.md) | done   |
| 0016 | [Dep upgrades: vite 8 / vitest 4 / shiki 4 (clear Dependabot)](./0016-dep-upgrades-vite8-shiki4.md) | done   |
| 0017 | [Maintainer review fixes: resiliency tests, daemon hardening, render & contract guards](./0017-maintainer-review-fixes.md) | done |
| 0018 | [Analytics breakdown by cost (Metric + Sort toggles)](./0018-analytics-breakdown-cost.md) | done |
| 0019 | [pi connector](./0019-pi-connector.md) | done |
| 0020 | [opencode connector](./0020-opencode-connector.md) | done |
| 0021 | [GitHub Copilot CLI connector](./0021-copilot-connector.md) | done |
| 0022 | [Security & quality fixes: image CSP, Junie path containment, deterministic PR link, memory/search logging, Windows support](./0022-security-quality-fixes.md) | done |
| 0023 | [Structured rendering for command turns (slash/bash tags)](./0023-command-turn-rendering.md) | done |
| 0024 | [Continue session from transcript (terminal auto-open)](./0024-continue-session.md) | abandoned |
| 0025 | [Continue session: copy the command](./0025-continue-session-copy-command.md) | done |
| 0026 | [UI/UX review: hierarchy pass across all screens](./0026-ui-ux-review-batches.md) | done |
| 0027 | [Session-efficiency analytics (per-session ratios table)](./0027-session-efficiency-analytics.md) | done |
| 0028 | [CI/CD segmentation & reusable workflows](./0028-ci-segmentation-and-reuse.md) | done |
| 0029 | [Localhost host guard (anti DNS-rebinding)](./0029-localhost-host-guard.md) | done |
| 0030 | [Analyze tab: activity heatmap + tool-usage breakdown](./0030-analyze-activity-heatmap-tool-usage.md) | done |
| 0031 | [Google Antigravity connector](./0031-antigravity-connector.md) | done |
| 0032 | [Subagent embedding for Codex, pi, opencode, Copilot](./0032-subagent-embedding-connectors.md) | done |
| 0033 | [Symlink-safe image resolution](./0033-symlink-safe-image-resolution.md) | done |
| 0034 | [Restore reader's place after a full reload (Safari ⌘R)](./0034-safari-reload-scroll-restore.md) | done |
| 0035 | [Roadmap: agent-facing access (MCP + CLI) & analytics depth](./0035-agent-access-and-analytics-roadmap.md) | done |
| 0036 | [API seams for agent consumers (windowing, limits, plain snippets, shared redact/markdown)](./0036-agent-api-seams.md) | done |
| 0037 | [Cross-agent comparison analytics](./0037-cross-agent-comparison.md) | done |
| 0038 | [`claudescope mcp`: agent-facing MCP server](./0038-mcp-server.md) | done |
| 0039 | [Code-impact index: file_edits + tool_error_count (schema v10)](./0039-file-edits-index.md) | done |
| 0040 | [CLI query subcommands (search/sessions/session/projects/analytics)](./0040-cli-query-subcommands.md) | done |
| 0041 | [Error & interrupt analytics](./0041-error-interrupt-analytics.md) | done |
| 0042 | [Week-in-review digest (page + copy-md + CLI)](./0042-digest.md) | done |
| 0043 | [Retire the Activity tab: redistribute its pieces](./0043-activity-tab-redistribution.md) | done |
| 0044 | [Provider-aware cost: local vs remote model sessions](./0044-provider-aware-cost.md) | done |
| 0045 | [Indexing UX + post-update self-healing](./0045-indexing-ux-and-self-healing-updates.md) | done |
| 0046 | [Live session updates (fingerprint polling + stick-to-bottom)](./0046-live-session-updates.md) | done |
| 0047 | [List freshness: dataVersion idle polling](./0047-list-freshness-dataversion.md) | done |
| 0048 | [xAI Grok CLI connector](./0048-grok-connector.md) | done |
| 0049 | [Dependabot #6: brace-expansion DoS remediation](./0049-dependabot-brace-expansion.md) | done |
| 0050 | [Dependabot alerts #7–#10 remediation](./0050-dependabot-alerts-7-10.md) | done |
| 0051 | [Settings page: indexer lifecycle + settings.json layer](./0051-settings-page.md) | done |
| 0052 | [Indexer durability + state-dir permissions](./0052-indexer-durability-and-state-perms.md) | done |
| 0053 | [Validate query params before they reach SQL](./0053-validate-query-params.md) | done |
| 0054 | [Don't SIGTERM a PID we don't own; validate the port](./0054-daemon-pid-ownership-and-port.md) | done |
| 0055 | [One canonical connector contract instead of sixteen](./0055-canonical-connector-contract.md) | done |
| 0056 | [Prune the normalize cache when its source is gone](./0056-prune-normalize-cache.md) | done |
| 0057 | [Untrusted-content hardening](./0057-untrusted-content-hardening.md) | done |
| 0058 | [Consolidate the analytics duplication](./0058-analytics-duplication.md) | done |
| 0059 | [Three small cleanups from the review](./0059-small-cleanups.md) | done |
| 0060 | [Dependabot alerts #13–#19](./0060-dependabot-alerts-13-19.md) | done |
| 0061 | [Markdown source view and Mermaid rendering](./0061-markdown-mermaid-rendering.md) | done |
| 0062 | [Codex title and metadata rendering](./0062-codex-title-and-metadata-rendering.md) | done |
| 0063 | [Show detected agents in Memory](./0063-detected-agents-memory.md) | done |
| 0064 | [MCP SDK v2 and `2026-07-28` stdio support](./0064-mcp-sdk-v2.md) | done |
| 0065 | [Shared fallback-title selection](./0065-shared-fallback-title-selection.md) | done |
| 0066 | [Dependabot Mermaid and DOMPurify remediation](./0066-dependabot-mermaid-dompurify.md) | done |
| 0067 | [Claude Code plugin and marketplace](./0067-claude-code-plugin-marketplace.md) | done |
| 0068 | [Raycast extension and deep-link CLI seam](./0068-raycast-extension.md) | in-progress |
| 0069 | [Shared Claude Code and Codex plugin](./0069-shared-claude-codex-plugin.md) | done |
| 0070 | [Reliable update status and identifier search](./0070-update-status-and-identifier-search.md) | done |
| 0071 | [Runtime and query validation fixes](./0071-runtime-and-query-validation.md) | in-progress |
