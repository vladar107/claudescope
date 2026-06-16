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
    // script-src must stay strict — no blanket inline allowance.
    expect(csp).not.toContain("'unsafe-inline' 'unsafe-inline'");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);

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
