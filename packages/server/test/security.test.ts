/**
 * Security-headers test: the served SPA must carry a Content-Security-Policy that
 * blocks remote image/connect sources, so a poisoned/shared transcript can't make
 * the browser fetch an attacker URL (tracking pixel / intranet probe). Also guards
 * that the inline theme-bootstrap script's CSP hash stays in sync with the script.
 */

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import {
  CONTENT_SECURITY_POLICY,
  THEME_BOOTSTRAP_SCRIPT_HASH,
  hostnameFromHeader,
  isAllowedHost,
  registerHostGuard,
  registerMutationGuard,
  registerSecurityHeaders,
} from '../src/security.js';

describe('security headers', () => {
  it('sets a CSP that confines images and connections to self/data:', async () => {
    const app = Fastify();
    registerSecurityHeaders(app);
    app.get('/anything', async () => ({ ok: true }));

    const res = await app.inject({ method: 'GET', url: '/anything' });
    const csp = res.headers['content-security-policy'];

    expect(csp).toBe(CONTENT_SECURITY_POLICY);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("img-src 'self' data:");
    expect(csp).toContain("connect-src 'self'");
    // Remote http(s) image/connect sources must NOT be allowlisted anywhere.
    expect(csp).not.toContain('http://');
    expect(csp).not.toContain('https://');
    // script-src stays strict: WASM (for Shiki) is allowed, but NOT inline
    // scripts or general eval — so an injected script still can't execute.
    expect(csp).toContain("'wasm-unsafe-eval'");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(csp).not.toContain("'unsafe-eval'"); // bare unsafe-eval (note: != wasm-unsafe-eval)

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');

    await app.close();
  });

  it('allowlists exactly the inline theme-bootstrap script in web/index.html', () => {
    const htmlPath = fileURLToPath(new URL('../../web/index.html', import.meta.url));
    const html = readFileSync(htmlPath, 'utf8');
    // The pre-paint theme bootstrap is the only attribute-less `<script>` (the app
    // bundle is `<script type="module" src=…>`). Locate it with plain string ops,
    // not an HTML-filtering regexp (which CodeQL rightly distrusts).
    const OPEN = '<script>';
    const start = html.indexOf(OPEN);
    const end = html.indexOf('</script>', start);
    expect(start, 'expected an inline <script> in web/index.html').toBeGreaterThanOrEqual(0);
    const inline = html.slice(start + OPEN.length, end);
    const hash = 'sha256-' + createHash('sha256').update(inline, 'utf8').digest('base64');
    // If this fails after editing the inline script, update THEME_BOOTSTRAP_SCRIPT_HASH.
    expect(hash).toBe(THEME_BOOTSTRAP_SCRIPT_HASH);
    expect(CONTENT_SECURITY_POLICY).toContain(`'${THEME_BOOTSTRAP_SCRIPT_HASH}'`);
  });
});

describe('host guard (anti DNS-rebinding)', () => {
  function appWithGuard() {
    const app = Fastify();
    registerHostGuard(app);
    app.get('/api/health', async () => ({ ok: true }));
    return app;
  }

  // Loopback hosts the daemon and the dev proxy actually send. Port varies (4317
  // prod, 5317 the Vite proxy, or a custom PORT) and must NOT matter.
  it.each(['localhost', 'localhost:4317', '127.0.0.1:4317', '[::1]:4317', 'localhost:5317'])(
    'allows loopback host %s',
    async (host) => {
      const app = appWithGuard();
      const res = await app.inject({ method: 'GET', url: '/api/health', headers: { host } });
      expect(res.statusCode).toBe(200);
      await app.close();
    },
  );

  // A DNS-rebinding page reaches the loopback socket but carries its own hostname
  // in Host — including the `localhost.evil.com` prefix trick, which must NOT pass.
  it.each(['evil.com', 'evil.com:4317', 'attacker.example:4317', 'localhost.evil.com'])(
    'rejects non-loopback host %s with 403',
    async (host) => {
      const app = appWithGuard();
      const res = await app.inject({ method: 'GET', url: '/api/health', headers: { host } });
      expect(res.statusCode).toBe(403);
      await app.close();
    },
  );

  // A missing Host can't be exercised through inject (light-my-request fills in a
  // default), so assert the defensive branch and the parser directly.
  it('isAllowedHost/hostnameFromHeader handle missing values, ports, brackets, and casing', () => {
    expect(isAllowedHost(undefined)).toBe(false);
    expect(isAllowedHost('')).toBe(false);
    expect(isAllowedHost('localhost:4317')).toBe(true);
    expect(isAllowedHost('127.0.0.1')).toBe(true);
    expect(isAllowedHost('[::1]:4317')).toBe(true);
    expect(isAllowedHost('evil.com:4317')).toBe(false);
    expect(isAllowedHost('localhost.evil.com')).toBe(false);
    expect(hostnameFromHeader('[::1]:4317')).toBe('::1');
    expect(hostnameFromHeader('LocalHost:5317')).toBe('localhost');
  });
});

describe('mutation guard (anti-CSRF on mutating routes)', () => {
  function appWithGuard() {
    const app = Fastify();
    registerMutationGuard(app);
    app.post('/api/mutate', async () => ({ ok: true }));
    app.get('/api/read', async () => ({ ok: true }));
    return app;
  }

  // A cross-origin no-cors fetch from any website arrives with a loopback Host
  // but a non-same-origin Sec-Fetch-Site — every such mutation must be refused.
  // `same-site` covers the subdomain variant; both are attacker-reachable.
  it.each(['cross-site', 'same-site'])(
    'rejects a POST with Sec-Fetch-Site: %s (403)',
    async (site) => {
      const app = appWithGuard();
      const res = await app.inject({
        method: 'POST',
        url: '/api/mutate',
        headers: { 'sec-fetch-site': site },
        payload: { a: 1 },
      });
      expect(res.statusCode).toBe(403);
      await app.close();
    },
  );

  // Legit callers: the SPA (same-origin), a direct navigation (none), and
  // curl / the CLI / app.inject (no Sec-Fetch-Site at all).
  it.each(['same-origin', 'none'])('allows a POST with Sec-Fetch-Site: %s', async (site) => {
    const app = appWithGuard();
    const res = await app.inject({
      method: 'POST',
      url: '/api/mutate',
      headers: { 'sec-fetch-site': site },
      payload: { a: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await app.close();
  });

  it('allows a POST with no Sec-Fetch-Site header and a JSON body (curl / CLI)', async () => {
    const app = appWithGuard();
    const res = await app.inject({ method: 'POST', url: '/api/mutate', payload: { a: 1 } });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  // Legacy-browser fallback: a no-cors cross-origin POST can only carry simple
  // content types (text/plain & co) — requiring JSON closes that path too.
  it('rejects a non-JSON content type on a mutating request (415)', async () => {
    const app = appWithGuard();
    const res = await app.inject({
      method: 'POST',
      url: '/api/mutate',
      headers: { 'content-type': 'text/plain' },
      payload: 'a=1',
    });
    expect(res.statusCode).toBe(415);
    await app.close();
  });

  it('accepts application/json with a charset parameter', async () => {
    const app = appWithGuard();
    const res = await app.inject({
      method: 'POST',
      url: '/api/mutate',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      payload: JSON.stringify({ a: 1 }),
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('skips safe methods: a GET passes even with Sec-Fetch-Site: cross-site', async () => {
    const app = appWithGuard();
    const res = await app.inject({
      method: 'GET',
      url: '/api/read',
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
