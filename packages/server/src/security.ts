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
].join('; ');

/**
 * Attach the CSP to every response. It's harmless on the JSON API (browsers only
 * enforce CSP on documents); what matters is that it rides the served HTML.
 */
export function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    return payload;
  });
}
