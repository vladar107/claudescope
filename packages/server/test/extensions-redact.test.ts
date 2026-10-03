/**
 * Redaction of extension config (MCP servers, hooks) before it reaches the
 * Extensions page. Every case plants a credential in a shape real configs use
 * and asserts it does not survive; the few "kept" cases pin that ordinary
 * commands stay readable, so the rules cannot be "fixed" by redacting all.
 */

import { describe, expect, it } from 'vitest';
import { claudeStyleHooks, copilotHooks } from '../src/connectors/extensions/hooks.js';
import { mcpServersFrom } from '../src/connectors/extensions/mcp.js';
import { stripJsonc } from '../src/connectors/extensions/config-files.js';
import { redactArgs, redactCommandLine, sanitizeUrl } from '../src/connectors/extensions/redact.js';

const SECRET = 'S3cr3tValue9f8e7d6c5b4a3210zz';

describe('redactArgs', () => {
  it.each([
    [['--token', SECRET]],
    [['--api-key', SECRET]],
    [['-p', 'x', '--password', SECRET]],
    [[`--access-token=${SECRET}`]],
    [[`--header=Authorization: Bearer ${SECRET}`]],
    [[`API_KEY=${SECRET}`]],
    [[`FOO=${SECRET}`]],
    [[`sk-ant-${SECRET}`]],
    [[`ghp_${SECRET}`]],
    [[SECRET]],
    [[`https://user:${SECRET}@example.com/mcp`]],
    [[`https://example.com/mcp?key=${SECRET}`]],
    [['@mcp/server-postgres', 'postgresql://admin:hunter2pw@db.local/app']],
    [['redis://:hunter2pw@cache.local:6379']],
    [['wss://h.example.com/ws?token=hunter2pw']],
    [['-u', 'admin:hunter2pw']],
    [['--user', 'admin:hunter2pw']],
    [['-phunter2pw']],
    [['--pat', 'hunter2pw']],
    [[`{"apiKey":"hunter2pw","name":"x"}`]],
    [[`{"config":{"key":"sk-ant-api03-${SECRET}"}}`]],
    [[`x"https://h.example.com/?t=hunter2pw"`]],
    [['--secret-key', 'hunter2pw']],
    [['--passphrase', 'hunter2pw']],
    [['"--token"', 'hunter2pw']],
    [['x-api-key=hunter2pw']],
    [[`{"SECRET_KEY":"hunter2pw"}`]],
    [['-H', 'X-Api-Token: hunter2pw']],
    [['git+https://user:hunter2pw@github.com/o/p.git']],
  ])('drops the secret from %j', (args) => {
    const out = JSON.stringify(redactArgs(args));
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain('hunter2pw');
  });

  it('keeps ordinary launch args readable', () => {
    const args = [
      '-y',
      '@modelcontextprotocol/server-filesystem@1.2.3',
      '/Users/me/src',
      '--read-only',
      '--user-data-dir',
      '/tmp/profile',
      'run',
    ];
    expect(redactArgs(args)).toEqual(args);
  });
});

describe('redactCommandLine', () => {
  it.each([
    `curl -H "Authorization: Bearer ${SECRET}" https://hooks.example.com/x`,
    `curl -H 'X-Api-Key: ${SECRET}' https://example.com`,
    `TOKEN=${SECRET} ./notify.sh`,
    `GH_TOKEN="${SECRET} more" gh pr view`,
    `notify --token ${SECRET} --quiet`,
    `notify --secret="${SECRET}"`,
    `curl https://hooks.slack.com/services/T0ABC123/B0DEF456/${SECRET}`,
  ])('drops the secret from %s', (cmd) => {
    expect(redactCommandLine(cmd)).not.toContain(SECRET);
  });

  it('keeps the header readable around a redacted bearer token', () => {
    expect(redactCommandLine(`curl -H "Authorization: Bearer ${SECRET}"`)).toBe('curl -H "Authorization: Bearer •••"');
  });

  it('keeps a plugin hook command and its spacing intact', () => {
    const cmd = '${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.sh  Stop';
    expect(redactCommandLine(cmd)).toBe(cmd);
  });

  it('survives an unbalanced quote without dropping text', () => {
    expect(redactCommandLine(`echo it's done`)).toBe(`echo it's done`);
  });
});

describe('sanitizeUrl', () => {
  it('keeps scheme, host, and path only', () => {
    expect(sanitizeUrl('https://u:p@mcp.example.com:8443/v1/mcp?token=abc#frag')).toBe(
      'https://mcp.example.com:8443/v1/mcp',
    );
  });

  it('redacts a token carried as a path segment', () => {
    expect(sanitizeUrl(`https://mcp.zapier.com/api/mcp/s/${SECRET}/mcp`)).not.toContain(SECRET);
  });

  it('survives a malformed percent escape', () => {
    expect(sanitizeUrl('https://h.example.com/%zz%/a%E0%A4%A')).toMatch(/^https:\/\/h\.example\.com\//);
  });

  it('is undefined for a non-URL', () => {
    expect(sanitizeUrl('not a url')).toBeUndefined();
  });
});

describe('mcpServersFrom', () => {
  const src = { scope: 'user' as const, sourcePath: '/h/.claude.json' };

  it('keeps env/header key names, never values, across every alias', () => {
    const servers = mcpServersFrom(
      {
        a: { command: 'npx', args: ['-y', 'pkg'], env: { API_TOKEN: SECRET } },
        b: { type: 'http', url: 'https://x.example.com/mcp', headers: { Authorization: `Bearer ${SECRET}` } },
        c: { url: 'https://y.example.com/mcp', http_headers: { 'X-Key': SECRET }, env_http_headers: { 'X-Other': 'VAR' } },
        d: { type: 'local', command: ['bunx', 'srv', '--api-key', SECRET], environment: { KEY: SECRET } },
        e: { type: 'remote', url: 'https://z.example.com', oauth: { clientSecret: SECRET }, bearerToken: SECRET },
      },
      src,
    );
    expect(JSON.stringify(servers)).not.toContain(SECRET);
    expect(servers.find((s) => s.name === 'a')?.envKeys).toEqual(['API_TOKEN']);
    expect(servers.find((s) => s.name === 'c')?.headerKeys).toEqual(['X-Key', 'X-Other']);
    expect(servers.find((s) => s.name === 'd')).toMatchObject({ transport: 'stdio', command: 'bunx', envKeys: ['KEY'] });
  });

  it('marks a disabled server and tolerates junk entries', () => {
    const servers = mcpServersFrom({ off: { command: 'x', enabled: false }, junk: 'nope', arr: [] }, src);
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({ name: 'off', enabled: false });
  });
});

describe('hook parsers', () => {
  const src = { scope: 'user' as const, sourcePath: '/h/settings.json' };

  it('skips non-list event keys such as Codex hooks.state', () => {
    const hooks = claudeStyleHooks(
      {
        state: { 'x:hooks.json:stop:0:0': { trusted_hash: 'abc' } },
        Stop: [{ hooks: [{ type: 'command', command: `TOKEN=${SECRET} ./stop.sh`, timeout: 10 }] }],
      },
      src,
    );
    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toMatchObject({ event: 'Stop', type: 'command', timeoutSec: 10 });
    expect(JSON.stringify(hooks)).not.toContain(SECRET);
  });

  it('reads Copilot camelCase hooks without their env or headers', () => {
    const hooks = copilotHooks(
      {
        version: 1,
        hooks: {
          preToolUse: [{ type: 'command', bash: './check.sh', env: { K: SECRET }, timeoutSec: 5 }],
          sessionEnd: [{ type: 'http', url: `https://h.example.com/end?sig=${SECRET}`, headers: { A: SECRET } }],
        },
      },
      src,
    );
    expect(hooks.map((h) => h.event)).toEqual(['preToolUse', 'sessionEnd']);
    expect(JSON.stringify(hooks)).not.toContain(SECRET);
  });
});

describe('stripJsonc', () => {
  it('leaves commas inside strings alone', () => {
    expect(JSON.parse(stripJsonc('{"args":["a, ]","b,}",],}'))).toEqual({ args: ['a, ]', 'b,}'] });
  });

  it('drops comments and trailing commas but not URL slashes in strings', () => {
    const text = '{\n  // c\n  "url": "https://a.example.com/x", /* b */\n  "list": [1, 2,],\n}';
    expect(JSON.parse(stripJsonc(text))).toEqual({ url: 'https://a.example.com/x', list: [1, 2] });
  });
});
