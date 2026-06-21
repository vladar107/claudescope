# 0029 — Localhost host guard (anti DNS-rebinding)

- **Status:** done <!-- proposed | in-progress | done | superseded | abandoned -->
- **Date:** 2026-06-21
- **PR:** https://github.com/vladar107/claudescope/pull/40

## Context

Claudescope is a local, read-only viewer whose API returns **high-value data** —
full transcripts (source code, prompts, memory files, paths, possibly secrets). The
server binds to `127.0.0.1` only and the security posture has been *"loopback bind =
safe"* (stated in README and SECURITY.md).

That bind stops the LAN/internet, but **not a malicious website the user visits**.
Via **DNS rebinding**, a page on `evil.com` lowers its DNS TTL, then re-resolves
`evil.com` to `127.0.0.1`. It fetches `http://evil.com:4317/api/sessions/...`; the
browser now treats this as *same-origin* (page origin `evil.com` == request host
`evil.com`), connects to the loopback server, and reads the response. CORS doesn't
help (no cross-origin from the browser's view) and the existing CSP doesn't apply
(CSP guards *our* origin's content from phoning out — it can't stop a *different*
origin reading the API).

Evaluated full FE↔BE auth and rejected it: the SPA and API are one app, one origin,
one local user — there's no second party to authenticate, and a login/token layer
would add friction for no real-world gain. The fitting, standard defense (Jupyter,
Vite, webpack-dev-server all do it) is **Host-header validation**.

## Goal

Reject any request whose `Host` header isn't a loopback host, closing the
DNS-rebinding hole with zero UX cost and no auth. A rebinding request arrives as
`Host: evil.com:4317` → `403`.

## Decisions

- **Host allowlist, not auth** — validate the `Host` *hostname* against
  `{localhost, 127.0.0.1, ::1}`. Rejected FE↔BE auth (no second party) and a
  per-session token (only warranted if a non-loopback `--host` is ever added —
  noted as the future guardrail).
- **Ignore the port** — the dev proxy (Vite on `:5317`) and a custom `PORT` both
  forward a loopback *hostname*; the port never changes the security property.
  Checking hostname-only avoids breaking dev/proxied/custom-port setups.
- **Env escape hatch** — `CLAUDESCOPE_ALLOWED_HOSTS` (comma-separated) for
  non-standard local setups (e.g. a custom `/etc/hosts` alias).
- **`onRequest` hook, before routing** — a rebinding page never reaches a route.

## Approach

1. `packages/server/src/security.ts` — add `ALLOWED_HOSTNAMES` (env-overridable),
   `hostnameFromHeader()` (strips port + IPv6 brackets, lowercases),
   `isAllowedHost()`, and `registerHostGuard(app)` (an `onRequest` hook → `403` on a
   non-loopback Host).
2. `packages/server/src/index.ts` — call `registerHostGuard(app)` alongside
   `registerSecurityHeaders(app)`.
3. `packages/server/test/security.test.ts` — allow loopback hosts incl. the Vite
   `:5317` proxy and `[::1]`; reject `evil.com`, the `localhost.evil.com` prefix
   trick, etc.; unit-test the parser/predicate for missing/bracketed/cased values.
4. `SECURITY.md` — document the guard and the `CLAUDESCOPE_ALLOWED_HOSTS` override.

## Files affected

- `packages/server/src/security.ts` — host guard + helpers (new exports).
- `packages/server/src/index.ts` — wire the guard.
- `packages/server/test/security.test.ts` — coverage.
- `SECURITY.md` — Network section wording.

## Testing

`npm run typecheck` (clean) and `npm test` (250/250). The security suite covers
loopback-allow, rebinding-reject, the prefix trick, and parser edges. Manual: the
daemon health check hits `127.0.0.1:<port>` and still passes; the Vite dev proxy
(`localhost:5317`) passes.

## Risks / open questions

- A user fronting claudescope with a custom local hostname (reverse proxy,
  `/etc/hosts` alias) must set `CLAUDESCOPE_ALLOWED_HOSTS` — documented.
- If a remote/shared/`--host` mode is ever added, the host allowlist is **not**
  sufficient on its own — a per-session token (or real auth) becomes mandatory.
  This plan deliberately scopes to the localhost threat model only.
