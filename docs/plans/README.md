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
