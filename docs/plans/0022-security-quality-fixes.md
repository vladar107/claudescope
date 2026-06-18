# 0022 — Security & quality fixes: image CSP, Junie path containment, deterministic PR link, memory/search logging, Windows support

- **Status:** done <!-- proposed | in-progress | done | superseded | abandoned -->
  - PR 1 (F3, F4, C7, C8) merged (#26; CSP/WASM + collapse-chevron follow-up #27).
  - PR 2 (C6 — Windows support + `windows-latest` CI runner) merged (#28). The
    runner ran green; its two surfaced issues (CRLF checkout breaking the CSP hash
    and shebang'd scripts; parallel-vitest DuckDB extension-install races on
    Windows) were fixed on-branch (`.gitattributes` LF pin; `fileParallelism: false`
    on win32 only).
- **Date:** 2026-06-16
- **PR:** #26, #27 (PR 1), #28 (PR 2)

## Context

Two reviews (a security pass and a non-security quality pass) were triaged
against the actual code. After verification + adversarial challenge, the
actionable set is five items. The rest of both reviews was dismissed as
out-of-model, premature optimization, or already-mitigated (see the triage notes
below for what was rejected and why).

Threat model reminder: Claudescope is a local, single-user, read-only viewer
bound to `127.0.0.1`. The only realistic adversarial surfaces are **(A)** a
malicious webpage making cross-origin requests to the loopback server and
**(B)** a poisoned/shared transcript the user opens. Home-dir tampering is out of
model. Both security items below are surface-(B) bugs.

The five items:

| ID | What | Why it's real |
| -- | ---- | ------------- |
| **F3** | Remote image URLs render directly; no CSP | Surface (B): opening a shared transcript silently fires GETs to attacker/intranet URLs (tracking pixel / blind probe). `image.ts:26` returns the URL verbatim → `<img src>`; `Markdown.tsx` has no `urlTransform`; no CSP exists anywhere. |
| **F4** | Junie connector reads arbitrary local files | Surface (B): a poisoned `events.jsonl` with `customAttachments:["/Users/you/.ssh/id_rsa"]` is `readFileSync`'d, base64'd, and rendered. Fires at index time too (`prepare()→parseSession`). No containment, no extension gate. |
| **C7** | PR-link extraction is nondeterministic | `claude-code.ts:150` uses three independent unordered `last()` aggregates; on rare multi-PR sessions the displayed link can flip across reindexes and the three fields can come from different rows. |
| **C8** | Two blind `catch → []` swallows | `memory.ts:30-44` and `search.ts:185-186` swallow with no log — a genuine memory/FTS regression surfaces as an undebuggable empty "no data" state. |
| **C6** | Windows path handling + no Windows CI | Display-only today, but the maintainer expects Windows users. `displayNameFromCwd` splits on `/` only; `contractHome` matches only `~/`; CI has no Windows runner so nothing else is validated on Windows. |

## Goal

- F3/F4: a poisoned or shared transcript can no longer (F3) cause the browser to
  fetch attacker-controlled remote URLs, nor (F4) coax the server into reading
  files outside the Junie session directory.
- C7: the PR link shown for a session is stable across reindexes and its fields
  always come from a single record.
- C8: a real failure in memory collection or session search leaves a log line
  instead of a silent empty result. Behavior is otherwise unchanged (still `[]`,
  still never 500s).
- C6: native-Windows path display is correct, and a Windows CI runner validates
  the full index/query pipeline so Windows is a supported target rather than an
  untested hope.

## Decisions

- **F3 — CSP is the primary fix, not per-component sanitizing.** A single
  `Content-Security-Policy` response header (`img-src 'self' data:; connect-src
  'self'`) closes *both* the structured-image path (`image.ts`) and the markdown
  path (`![](http://…)`) at once. A fix in `image.ts` alone would leave the
  markdown vector open (verified: `Markdown.tsx` sets no `urlTransform` and no
  rehype-sanitize). We add a markdown `urlTransform` as cheap defense-in-depth so
  the markdown path is closed at the source even if the CSP is later relaxed.
  **Implementation note:** the policy + hook live in a dedicated, testable
  `packages/server/src/security.ts`; `main()` calls `registerSecurityHeaders(app)`
  (an `onSend` hook — verified to ride `@fastify/static` responses). `index.html`
  has one deliberate inline script (pre-paint theme bootstrap); rather than weaken
  `script-src` to `'unsafe-inline'`, we allowlist that exact script by its SHA-256
  hash, and a `security.test.ts` case fails if the script and hash ever drift.
- **F3 — keep the CSP permissive enough to not break the SPA.** Shiki, Recharts,
  and React inline styles require `style-src 'unsafe-inline'`. The directive set
  must be validated against the *built* app, not just unit tests, before merge.
- **F4 — containment under `JUNIE_HOME` (`~/.junie`), plus an extension
  whitelist.** Resolve the candidate with `realpathSync` and refuse anything that
  escapes Junie's home dir; gate on an image extension. **Implementation note:**
  the plan originally said "under the session dir," but the Junie fixture shows
  legitimate pasted images live at `<sessions>/clipboard-images/<id>/…` — a
  *sibling* of the session dir, not under it. Session-dir containment would break
  real images. `JUNIE_HOME` is the correct boundary: it's exactly the tree the
  connector already declares it confines itself to ("STRICTLY READ-ONLY with
  respect to ~/.junie"), so it allows clipboard images wherever Junie puts them
  while still blocking `~/.ssh`, `/etc`, and sibling projects. No signature
  threading needed — `normalize.ts` imports the constant. Also guard `discover()`
  against a `sessionId` containing `..` or path separators (secondary, cheap).
- **C7 — atomic, deterministic pick keyed on `prUrl`.** pr-link records carry no
  `timestamp` (confirmed in the fixture), so there's no time order to use.
  Final approach: `arg_max(prNumber, prUrl)`, `arg_max(prRepository, prUrl)`,
  `max(prUrl)` — all three resolve to the single row with the maximum `prUrl`
  (always present per the `WHERE`), so the fields always come from one record, the
  choice is stable across reindexes, and a valid link is never dropped. Avoids
  relying on `max`/`arg_max` over a STRUCT (DuckDB-version sensitivity) — keeps the
  4-column contract `(session_id, pr_number, pr_repository, pr_url)` from
  `types.ts:55`.
- **C8 — warn, don't throw, don't change return shape.** One `console.warn`
  (memory.ts, `c.id` in scope) and one `req.log.warn({ err }, …)` (search.ts,
  `req.log` available). Still returns `[]`. **Do not touch** the other swallows:
  `index.ts:369/444` already log, and the `discover()` / `parseJsonl()` /
  pricing / normalize catches are documented "expected, not a bug" cases.
- **C6 — fix display + add the runner; let the runner find the rest.** The two
  display fixes are known. The bigger value is the Windows CI runner: it exercises
  the real DuckDB path-interpolation, globbing, and fixture paths on Windows and
  will surface anything else that breaks. Treat newly-surfaced Windows failures as
  in-scope for this item. **Implementation note:** beyond the two display helpers,
  the Junie connector also assumed POSIX paths (`startsWith('/')`, `split('/')`, a
  `@/…`-only mention regex) — switched to `path.isAbsolute` + both-separator splits
  + a Windows-aware mention regex (best-effort pending real Windows-Junie data).
  DuckDB reads use exact file paths (no globs), so a backslash in the SQL string
  literal should be fine; the runner is the real confirmation.
  **What the `windows-latest` runner surfaced** (DuckDB *did* read backslash paths
  fine — Junie/api/codex/pi/opencode integration suites passed on Windows; these
  were the unanticipated ones, all fixed on-branch):
  1. The pinned CSP hash and the shebang'd `scripts/*.mjs` broke under git's CRLF
     checkout (Windows-only `SyntaxError` / hash mismatch) → repo-wide
     `.gitattributes` (`* text=auto eol=lf`) pins LF on every platform.
  2. Parallel vitest workers race to `INSTALL` DuckDB extensions into the shared
     `~/.duckdb` dir, which Windows file-locking rejects. Production is
     single-process, so this is a test-only artifact → `fileParallelism: false`
     on win32 only (Linux/macOS keep full parallelism).
- **PR split (recommended):** ship **F3 + F4 + C7 + C8 as one focused PR** (all
  small, security + correctness, low-risk, easy to review) and **C6 as a separate
  PR** (exploratory — a new CI runner may surface follow-on path bugs and
  shouldn't gate the security fixes). One plan doc, two PRs.

## Approach

Ordered, reviewable steps.

### PR 1 — security + correctness (F3, F4, C7, C8)

1. **C8 (warm-up, lowest risk):** add `console.warn` to `safeGlobal`/`safeProject`
   in `data/memory.ts:30-44`; add `req.log.warn({ err }, 'session search failed')`
   / `'memory search failed'` to the two `.catch(() => [])` in `routes/search.ts:185-186`.
2. **F3:** add a `Content-Security-Policy` header to the SPA response in
   `packages/server/src/index.ts` (a Fastify hook around the static/SPA serving at
   `:113-123`). Start from `default-src 'self'; img-src 'self' data:; connect-src
   'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'
   data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`. Then add a
   `urlTransform` to `ReactMarkdown` in `packages/web/src/components/Markdown.tsx`
   that allows only relative / `data:` image URLs. **Verify the built app renders**
   (Shiki code blocks, Recharts analytics, markdown images, syntax themes) — adjust
   `script-src`/`style-src` only as far as needed to keep it working.
3. **F4:** in `packages/server/src/connectors/junie/normalize.ts`, change
   `imageBlockFromPath` to take the session dir, `realpathSync` the candidate, and
   return `null` unless it resolves under that dir *and* has an allowed image
   extension. Thread the session dir through `attachmentImages` and
   `extractPromptImages` (and their call sites in `parseSession`). Guard the
   `sessionId` used to build paths in `junie.ts` `discover()` and
   `readIndexMeta` against `..` / path separators.
4. **C7:** rewrite the `prLinks` projection in
   `packages/server/src/connectors/claude-code/claude-code.ts:149-153` to
   `arg_max(struct_pack(prNumber, prRepository, prUrl), <order_key>)`, unpacking to
   the 4-column contract. Add `timestamp` to the aux `read_ndjson` column set if
   used as the order key.
5. **Tests** (focused on the weird stuff, per repo convention):
   - C7: a Claude fixture with two out-of-order `pr-link` records → assert a
     stable, mutually-consistent pick. (Also closes the one real gap C11 named.)
   - F4: a Junie fixture whose `customAttachments` / `@`-mention names an absolute
     path *outside* the session dir → assert it is **not** read (no `ImageBlock`),
     and a path *inside* the session dir with an image extension → assert it is.
   - F3: a small assertion that the SPA response carries the CSP header (and,
     optionally, that `urlTransform` drops a remote markdown image).
6. `npm run typecheck && npm test`; manually run the built app for F3.

### PR 2 — Windows support (C6)

7. `displayNameFromCwd` (`data/project-id.ts:26`): split on `/[/\\]/` instead of
   `/`. `contractHome` (`util/paths.ts:9`): accept a backslash home boundary
   (e.g. compare with `path.sep`, or match `${home}[/\\]`).
8. Add a `windows-latest` entry to the `test` job matrix in
   `.github/workflows/ci.yml` (node 22 + 24).
9. Run CI; triage whatever the Windows runner surfaces — likely candidates:
   backslash paths interpolated into DuckDB `read_ndjson(...)`, glob patterns in
   connector `discover()`, and any fixture/test that hardcodes POSIX paths. Fix
   each, keeping changes minimal and Windows-specific where possible.
10. Extend `packages/server/test/util.test.ts` with backslash-path cases for the
    two helpers.

## Files affected

- `packages/server/src/security.ts` — F3: new module — CSP string + `registerSecurityHeaders`.
- `packages/server/src/index.ts` — F3: call `registerSecurityHeaders(app)`.
- `packages/web/index.html` — F3: note the inline theme script is CSP-hash-pinned.
- `packages/web/src/components/Markdown.tsx` — F3: `urlTransform` (defense-in-depth).
- `packages/server/src/connectors/junie/normalize.ts` — F4: realpath containment +
  extension gate; thread session dir through image helpers.
- `packages/server/src/connectors/junie/junie.ts` — F4: guard `sessionId` in
  `discover()` / `readIndexMeta`.
- `packages/server/src/connectors/claude-code/claude-code.ts` — C7: atomic,
  ordered `prLinks` projection.
- `packages/server/src/data/memory.ts` — C8: warn in `safeGlobal`/`safeProject`.
- `packages/server/src/routes/search.ts` — C8: warn in the two `.catch(() => [])`.
- `packages/server/src/data/project-id.ts` — C6: separator-agnostic `displayNameFromCwd`.
- `packages/server/src/util/paths.ts` — C6: backslash-aware `contractHome`.
- `.github/workflows/ci.yml` — C6: add `windows-latest` to the test matrix.
- `packages/server/test/*` — new fixtures/cases for C7, F4, F3, and C6 helpers.

## Testing

- `npm run typecheck` and `npm test` green on every platform in the matrix
  (incl. the new Windows runner for PR 2).
- F3: launch the built app (`npm start`) and confirm code blocks, analytics
  charts, markdown, and themes still render with the CSP active; confirm a
  transcript carrying a remote image URL no longer triggers an outbound request
  (DevTools network tab shows it blocked by CSP).
- F4: the new Junie fixtures assert out-of-dir paths are not read and in-dir image
  paths are.
- C7: the new Claude fixture asserts a deterministic PR pick across record order.
- C8: behavior unchanged (`[]` on failure) plus a warning is emitted — assert the
  log call fires on a forced error, or verify by inspection.

## Risks / open questions

- **F3 CSP breaking the UI** — the main risk. Shiki/Recharts/React inline styles
  need `style-src 'unsafe-inline'`; a Vite module-preload inline snippet *might*
  need a `script-src` allowance. Mitigation: verify against the built app and
  widen only as needed. The security-critical directives (`img-src`,
  `connect-src`) are unaffected by style/script relaxations.
- **C7 order key** — if Claude `pr-link` records carry no usable `timestamp`, the
  fallback to physical scan order must be made explicit (a generated ordinal);
  this is no worse than today's `last()` and removes the cross-field-mixing bug
  regardless. Settle the exact key in step 4.
- **C6 scope creep** — the Windows runner may surface DuckDB path-interpolation or
  globbing bugs that are larger than the two display one-liners. This is exactly
  why C6 is its own PR: it must not block or bloat the security fixes. If the
  pipeline work turns out large, it can spin into its own follow-up plan.
- **F4 legitimate paths** — confirm the containment check doesn't reject genuine
  Junie attachment paths (Junie stores clipboard images under the session dir, so
  containment should hold; verify against a real session if available).

## Triage appendix — what was rejected (and why)

Security review: **F1** (reindex CSRF) → harden-only (DoS collapses behind the
`inFlight` lock + no-op fast path); **F2** (PID kill) → robustness-only, no
in-model attack path; **F5** (pricing SQL) → not injectable in-model, only a
robustness wedge on a hand-edit typo; **F6** (export redaction) → wording-only.
These may be worth small follow-ups but are not in this plan.

Quality review: **C1** (project lookup) O(tens) behind a filter — premature;
**C2** (session re-parse) correct simple design, already benchmarked; **C3**
(reindex poll) already mitigated; **C4** (FTS rebuild) DuckDB has no incremental
mode; **C5** (search/memory rescan) search hits the index, memory-live is
intentional; **C9** (indexer module) cohesive pipeline, splitting is speculative;
**C10** (normalizer dup) only boilerplate, logic is correctly per-format; **C11**
(test gaps) mostly covered — its one real gap (PR-link tie) is folded into C7;
**C12** (global caches) every named hazard already mitigated.
