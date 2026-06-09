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
