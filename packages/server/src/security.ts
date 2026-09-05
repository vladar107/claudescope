/**
 * HTTP security headers for the served SPA.
 *
 * The one real attacker surface for this read-only, loopback-only viewer is a
 * poisoned/shared transcript whose content makes the browser fetch a remote URL
 * (a tracking pixel / read-receipt, or a blind intranet probe). The
 * `img-src`/`connect-src 'self' data:` directives below close that at the network
 * layer for every rendering path at once (structured image blocks AND markdown
 * `![](http://…)`). `style-src 'unsafe-inline'` is required by Shiki, Recharts,
 * and React inline styles; scripts stay `'self'` so an injected inline script
 * still cannot execute.
 */

import type { FastifyInstance } from 'fastify';

/**
 * SHA-256 of the one inline `<script>` in `packages/web/index.html` (the
 * pre-paint theme bootstrap that avoids a flash of the wrong theme). Allowlisting
 * its hash lets that exact script run while keeping `script-src` otherwise strict
 * — no `'unsafe-inline'`, so an injected inline script still can't execute. If you
 * edit that script, update this hash; `security.test.ts` enforces the two match.
 */
export const THEME_BOOTSTRAP_SCRIPT_HASH = 'sha256-uVROy6kj/mNKownEAGZUVCYdHA4TIZ4PGgQn1EWD74Y=';

/** The Content-Security-Policy applied to every response. */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  // 'wasm-unsafe-eval' lets Shiki instantiate its WebAssembly regex engine
  // (oniguruma) for syntax highlighting. It permits WASM compilation only — NOT
  // general eval() or new Function() — so the anti-XSS guarantee is unchanged.
  `script-src 'self' 'wasm-unsafe-eval' '${THEME_BOOTSTRAP_SCRIPT_HASH}'`,
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  // form-action is a NAVIGATION directive: unlike the fetch directives it does
  // not inherit from default-src, so without this a form could post anywhere.
  "form-action 'self'",
].join('; ');

/**
 * Attach the CSP to every response. It's harmless on the JSON API (browsers only
 * enforce CSP on documents); what matters is that it rides the served HTML.
 */
export function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    // Stops a browser from MIME-sniffing a response into an executable type
    // (e.g. treating a transcript-derived download as HTML/JS).
    reply.header('X-Content-Type-Options', 'nosniff');
    // Never leak this app's URLs (session ids, search queries) to an external
    // site a rendered link points at.
    reply.header('Referrer-Policy', 'no-referrer');
    return payload;
  });
}

/**
 * Hostnames a request's `Host` header may carry. The server binds to loopback
 * only, but that alone does NOT stop a malicious website from reaching it via
 * DNS rebinding: the page rebinds its OWN hostname to `127.0.0.1`, so the browser
 * treats the cross-origin read as same-origin and the loopback bind becomes moot
 * (CORS doesn't help — there's no cross-origin from the browser's view). Refusing
 * any non-loopback Host closes that hole, since a rebinding request arrives as
 * `Host: attacker.com:<port>`.
 *
 * The PORT is intentionally ignored: the dev proxy (Vite on :5317) and a custom
 * PORT both forward a loopback *hostname*, and the port never changes the security
 * property. Override the set with `CLAUDESCOPE_ALLOWED_HOSTS` (comma-separated
 * hostnames) for non-standard local setups, e.g. a custom `/etc/hosts` alias.
 */
export const ALLOWED_HOSTNAMES = new Set(
  (process.env.CLAUDESCOPE_ALLOWED_HOSTS ?? 'localhost,127.0.0.1,::1')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
);

/**
 * Extract the hostname from a `Host` header, dropping the optional port and IPv6
 * brackets (`[::1]:4317` → `::1`, `localhost:5317` → `localhost`).
 */
export function hostnameFromHeader(host: string): string {
  const h = host.trim();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return (end >= 0 ? h.slice(1, end) : h).toLowerCase();
  }
  const colon = h.indexOf(':');
  return (colon >= 0 ? h.slice(0, colon) : h).toLowerCase();
}

/** True only if the `Host` header names a permitted loopback host. */
export function isAllowedHost(host: string | undefined): boolean {
  if (!host) return false;
  return ALLOWED_HOSTNAMES.has(hostnameFromHeader(host));
}

/**
 * Reject any request whose `Host` header isn't a loopback host — the standard
 * defense against DNS-rebinding attacks on a localhost server (see
 * {@link ALLOWED_HOSTNAMES}). Runs at `onRequest`, before routing, so a rebinding
 * page never reaches a route and can read nothing.
 */
export function registerHostGuard(app: FastifyInstance): void {
  app.addHook('onRequest', async (req, reply) => {
    if (!isAllowedHost(req.headers.host)) {
      reply.code(403).send({ error: 'Forbidden: invalid Host header' });
      return reply; // halt the request — do not route it
    }
  });
}

/** Request methods that can never mutate state and skip the mutation guard. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Guard every mutating request (POST/PUT/…) against cross-origin CSRF. The
 * host guard stops DNS rebinding but NOT same-`Host` cross-origin side
 * effects: any website can fire `fetch('http://localhost:4317/…', {method:
 * 'POST', mode: 'no-cors'})` and it arrives with a loopback Host header. That
 * was harmless while `/api/reindex` was the only mutation; not once settings
 * writes and index rebuilds exist. Two independent checks:
 *
 * - `Sec-Fetch-Site`: every evergreen browser sends it; anything other than
 *   `same-origin`/`none` (direct navigation) is rejected. curl / the CLI /
 *   `app.inject()` don't send it and pass. The Vite dev proxy forwards the
 *   browser's `same-origin` value.
 * - `Origin`: browsers have sent it on cross-origin POSTs since ~2011, so it
 *   covers legacy browsers that predate Fetch Metadata even for BODY-LESS
 *   mutations (which the content-type check below can't see). A non-loopback
 *   (or `null`) origin is rejected; curl/CLI omit the header and pass.
 * - Content type: a no-cors cross-origin request can only carry simple types
 *   (text/plain & co) — `application/json` forces a CORS preflight, which
 *   fails because this server serves no CORS headers.
 */
export function registerMutationGuard(app: FastifyInstance): void {
  app.addHook('onRequest', async (req, reply) => {
    if (SAFE_METHODS.has(req.method)) return;
    const site = req.headers['sec-fetch-site'];
    if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') {
      reply.code(403).send({ error: 'Forbidden: cross-site request' });
      return reply;
    }
    const origin = req.headers.origin;
    if (typeof origin === 'string' && !isAllowedOrigin(origin)) {
      reply.code(403).send({ error: 'Forbidden: cross-origin request' });
      return reply;
    }
    const contentType = req.headers['content-type'];
    if (contentType !== undefined && !contentType.toLowerCase().startsWith('application/json')) {
      reply.code(415).send({ error: 'Unsupported content type — use application/json' });
      return reply;
    }
  });
}

/** True when an `Origin` header names a permitted loopback host. Opaque
 *  (`null`) or unparsable origins fail — only real loopback pages pass. */
export function isAllowedOrigin(origin: string): boolean {
  try {
    return ALLOWED_HOSTNAMES.has(new URL(origin).hostname.replace(/^\[|\]$/g, '').toLowerCase());
  } catch {
    return false;
  }
}
