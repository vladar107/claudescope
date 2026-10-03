/**
 * Fitness function for the Extensions page's no-secrets rule.
 *
 * MCP server, hook, and plugin configs routinely carry credentials: `env` and
 * header values, `--token X` args, passwords in connection URLs, bearer tokens
 * in hook command lines, webhook tokens in URL paths. `GET /api/extensions`
 * must never echo one, from ANY agent or ANY source file (a plugin bundle's
 * `.mcp.json` and `hooks/hooks.json` included). The shared redaction helpers
 * have their own unit tests (`extensions-redact.test.ts`); what no unit test
 * can see is a connector that reads a new field, or a new connector that
 * bypasses the shared parsers, and copies a secret straight into the response.
 *
 * So this test builds one throwaway home holding a config for EVERY connector's
 * EVERY supported source, plants a unique secret in every shape the format
 * allows, points every getter at it, and asserts the serialized
 * `collectExtensions()` result contains none of them — while also asserting
 * each supported agent/kind yielded entries, so it cannot pass vacuously.
 *
 * It also walks the real registry: every connector must have a fixture here
 * (adding a connector forces adding one) and the `null` (unsupported) versus
 * array (supported) shape of each kind must match an explicit expectation.
 * Finally: malformed configs and a throwing connector degrade to `[]`, never
 * an exception.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { connectors } from '../src/connectors/registry.js';
import { collectExtensions } from '../src/data/extensions.js';

type Kind = 'mcpServers' | 'hooks' | 'plugins';

interface Ctx {
  root: string;
  /** Plant a unique secret; its value must never reach the response. */
  secret: (label: string) => string;
  /** Write a file (creating parents); non-bundle configs are tracked for the malformed test. */
  file: (path: string, content: string | object, opts?: { bundle?: boolean }) => string;
}

const ENV_VARS = [
  'CLAUDE_PROJECTS_DIR',
  'CODEX_SESSIONS_DIR',
  'JUNIE_SESSIONS_DIR',
  'PI_SESSIONS_DIR',
  'COPILOT_SESSIONS_DIR',
  'GROK_SESSIONS_DIR',
  'OPENCODE_CONFIG_DIR',
  'OPENCODE_DATA_DIR',
  'OPENCODE_DB_PATH',
  'ANTIGRAVITY_CLI_DIR',
  'ANTIGRAVITY_DIR',
];

/** A plugin bundle with a secret in its `.mcp.json` env/args and its hook command. */
function bundle(ctx: Ctx, dir: string, tag: string): void {
  ctx.file(
    join(dir, '.mcp.json'),
    {
      mcpServers: {
        bundled: {
          command: 'npx',
          args: ['--token', ctx.secret(`${tag}bundletokenarg`)],
          env: { BUNDLE_KEY: ctx.secret(`${tag}bundleenv`) },
          headers: { 'X-Key': ctx.secret(`${tag}bundleheader`) },
        },
      },
    },
    { bundle: true },
  );
  ctx.file(
    join(dir, 'hooks', 'hooks.json'),
    {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              { type: 'command', command: `curl -H "Authorization: Bearer ${ctx.secret(`${tag}bundlehook`)}" https://x.test` },
            ],
          },
        ],
      },
    },
    { bundle: true },
  );
}

/** MCP server map entries (Claude-shaped) covering every JSON secret shape. */
function jsonServers(ctx: Ctx, tag: string): Record<string, unknown> {
  return {
    stdio: {
      type: 'stdio',
      command: 'npx',
      args: [
        '--token',
        ctx.secret(`${tag}flagtoken`),
        `--api-key=${ctx.secret(`${tag}flagapikey`)}`,
        `postgresql://user:${ctx.secret(`${tag}pgpass`)}@db.test/app`,
      ],
      env: { API_KEY: ctx.secret(`${tag}envvalue`) },
    },
    remote: {
      type: 'http',
      url: `https://user:${ctx.secret(`${tag}userinfo`)}@api.test/v1?key=${ctx.secret(`${tag}query`)}`,
      headers: { Authorization: `Bearer ${ctx.secret(`${tag}headerbearer`)}` },
    },
    webhook: {
      type: 'sse',
      url: `https://hooks.test/services/${ctx.secret(`${tag}pathtoken`)}`,
    },
  };
}

/** Claude-shaped hook events covering command-line secret shapes and an http hook. */
function claudeHooks(ctx: Ctx, tag: string): Record<string, unknown> {
  return {
    PreToolUse: [
      {
        matcher: 'Bash',
        hooks: [
          { type: 'command', command: `curl -H "Authorization: Bearer ${ctx.secret(`${tag}hookbearer`)}" https://x.test` },
          { type: 'command', command: `TOKEN=${ctx.secret(`${tag}hookprefix`)} ./run.sh` },
          { type: 'http', url: `https://hooks.test/${ctx.secret(`${tag}hookurlpath`)}?k=${ctx.secret(`${tag}hookurlquery`)}` },
        ],
      },
    ],
  };
}

function tomlServers(ctx: Ctx, tag: string): string {
  return `
[mcp_servers.local]
command = "npx"
args = ["--token", "${ctx.secret(`${tag}tomlflag`)}", "--api-key=${ctx.secret(`${tag}tomlapikey`)}", "postgresql://u:${ctx.secret(`${tag}tomlpg`)}@db.test/app"]

[mcp_servers.local.env]
API_KEY = "${ctx.secret(`${tag}tomlenv`)}"

[mcp_servers.remote]
url = "https://user:${ctx.secret(`${tag}tomluserinfo`)}@api.test/x/${ctx.secret(`${tag}tomlpath`)}?key=${ctx.secret(`${tag}tomlquery`)}"
bearer_token_env_var = "REMOTE_TOKEN"

[mcp_servers.remote.http_headers]
X-Api-Key = "${ctx.secret(`${tag}tomlheader`)}"
`;
}

interface AgentFixture {
  supports: Record<Kind, boolean>;
  /** Env vars pointing this agent's home (and sources) into `root`. */
  env: (root: string) => Record<string, string>;
  build: (ctx: Ctx) => void;
}

const AGENTS: Record<string, AgentFixture> = {
  'claude-code': {
    supports: { mcpServers: true, hooks: true, plugins: true },
    env: (r) => ({ CLAUDE_PROJECTS_DIR: join(r, 'claude', 'projects') }),
    build: (ctx) => {
      const home = join(ctx.root, 'claude');
      ctx.file(join(home, 'projects', '.keep'), '', { bundle: true });
      ctx.file(join(home, '.claude.json'), {
        mcpServers: jsonServers(ctx, 'cc'),
        projects: {
          '/work/proj': {
            mcpServers: {
              scoped: {
                type: 'http',
                url: `https://api.test/${ctx.secret('ccprojpath')}`,
                headers: { 'X-Key': ctx.secret('ccprojheader') },
                env: { K: ctx.secret('ccprojenv') },
              },
            },
            history: [{ display: ctx.secret('cchistory') }],
          },
        },
        oauthAccount: { emailAddress: 'a@b.test', accessToken: ctx.secret('ccoauth') },
        customApiKeyResponses: { approved: [ctx.secret('ccapikeyresp')] },
        userID: ctx.secret('ccuserid'),
      });
      ctx.file(join(home, 'settings.json'), { hooks: claudeHooks(ctx, 'cc'), enabledPlugins: { 'pl@mk': true } });
      const installPath = join(home, 'plugins', 'cache', 'mk', 'pl', '1.0');
      bundle(ctx, installPath, 'cc');
      ctx.file(join(home, 'plugins', 'installed_plugins.json'), {
        version: 2,
        plugins: { 'pl@mk': [{ scope: 'user', installPath, version: '1.0' }] },
      });
    },
  },
  codex: {
    supports: { mcpServers: true, hooks: true, plugins: true },
    env: (r) => ({ CODEX_SESSIONS_DIR: join(r, 'codex', 'sessions') }),
    build: (ctx) => {
      const home = join(ctx.root, 'codex');
      ctx.file(
        join(home, 'config.toml'),
        `${tomlServers(ctx, 'cx')}
[[hooks.Stop]]
matcher = "x"

[[hooks.Stop.hooks]]
type = "command"
command = "TOKEN=${ctx.secret('cxhookprefix')} ./stop.sh --password ${ctx.secret('cxhookflag')}"
`,
      );
      ctx.file(join(home, 'hooks.json'), { hooks: claudeHooks(ctx, 'cxjson') });
      bundle(ctx, join(home, 'plugins', 'cache', 'mk', 'pl', '1.0'), 'cx');
    },
  },
  junie: {
    supports: { mcpServers: true, hooks: true, plugins: true },
    env: (r) => ({ JUNIE_SESSIONS_DIR: join(r, 'junie', 'sessions') }),
    build: (ctx) => {
      const home = join(ctx.root, 'junie');
      ctx.file(join(home, 'mcp', 'mcp.json'), { mcpServers: jsonServers(ctx, 'jn') });
      ctx.file(join(home, 'config.json'), { hooks: claudeHooks(ctx, 'jn') });
      ctx.file(join(home, 'extensions', 'extensions.json'), { mk: { extensions: ['pl'] } });
      bundle(ctx, join(home, 'extensions', 'mk', 'pl'), 'jn');
    },
  },
  copilot: {
    supports: { mcpServers: true, hooks: true, plugins: true },
    env: (r) => ({ COPILOT_SESSIONS_DIR: join(r, 'copilot', 'session-state') }),
    build: (ctx) => {
      const home = join(ctx.root, 'copilot');
      ctx.file(join(home, 'mcp-config.json'), { mcpServers: jsonServers(ctx, 'cp') });
      const copilotHooks = (tag: string) => ({
        version: 1,
        hooks: {
          preToolUse: [
            {
              type: 'command',
              bash: `curl -H "Authorization: Bearer ${ctx.secret(`${tag}bearer`)}" https://x.test`,
              env: { HOOK_KEY: ctx.secret(`${tag}env`) },
              timeoutSec: 5,
            },
            {
              type: 'http',
              url: `https://hooks.test/${ctx.secret(`${tag}urlpath`)}`,
              headers: { Authorization: ctx.secret(`${tag}headers`) },
            },
            { type: 'command', command: `TOKEN=${ctx.secret(`${tag}prefix`)} ./run.sh` },
          ],
        },
      });
      ctx.file(join(home, 'hooks', 'h.json'), copilotHooks('cphookfile'));
      ctx.file(join(home, 'settings.json'), { hooks: copilotHooks('cphooksettings').hooks });
      bundle(ctx, join(home, 'installed-plugins', 'mk', 'pl'), 'cp');
      bundle(ctx, join(home, 'installed-plugins', '_direct', 'dpl'), 'cpd');
    },
  },
  grok: {
    supports: { mcpServers: true, hooks: true, plugins: true },
    env: (r) => ({ GROK_SESSIONS_DIR: join(r, 'grok', 'sessions') }),
    build: (ctx) => {
      const home = join(ctx.root, 'grok');
      ctx.file(join(home, 'config.toml'), tomlServers(ctx, 'gk'));
      ctx.file(join(home, 'hooks', 'h.json'), { hooks: claudeHooks(ctx, 'gk') });
      bundle(ctx, join(home, 'plugins', 'pl'), 'gk');
    },
  },
  opencode: {
    supports: { mcpServers: true, hooks: false, plugins: true },
    env: (r) => ({
      OPENCODE_CONFIG_DIR: join(r, 'opencode-config'),
      OPENCODE_DATA_DIR: join(r, 'opencode-data'),
      OPENCODE_DB_PATH: join(r, 'opencode-data', 'opencode.db'),
    }),
    build: (ctx) => {
      const dir = join(ctx.root, 'opencode-config');
      ctx.file(join(dir, 'opencode.json'), {
        mcp: {
          local: {
            type: 'local',
            command: ['npx', '--token', ctx.secret('ocargtoken'), `--api-key=${ctx.secret('ocapikey')}`],
            environment: { API_KEY: ctx.secret('ocenv') },
          },
          remote: {
            type: 'remote',
            url: `https://api.test/${ctx.secret('ocpath')}?key=${ctx.secret('ocquery')}`,
            headers: { Authorization: `Bearer ${ctx.secret('ocheader')}` },
            oauth: { clientId: ctx.secret('occlientid'), clientSecret: ctx.secret('occlientsecret') },
          },
        },
        plugin: [
          'some-plugin@1.2.3',
          `git+https://user:${ctx.secret('ocspecpw')}@github.test/o/p.git`,
          `https://${ctx.secret('ocspectok')}@pkgs.test/p.tgz`,
        ],
      });
      ctx.file(join(dir, 'plugins', 'local.ts'), 'export default {}');
    },
  },
  pi: {
    supports: { mcpServers: false, hooks: false, plugins: true },
    env: (r) => ({ PI_SESSIONS_DIR: join(r, 'pi', 'sessions') }),
    build: (ctx) => {
      const home = join(ctx.root, 'pi');
      ctx.file(join(home, 'settings.json'), {
        packages: [
          `git:https://user:${ctx.secret('pigit')}@git.test/org/repo`,
          { source: `https://user:${ctx.secret('piobj')}@git.test/org/other.git` },
          'npm:left-pad',
        ],
      });
      ctx.file(join(home, 'extensions', 'local.ts'), 'export default {}', { bundle: true });
    },
  },
  antigravity: {
    supports: { mcpServers: false, hooks: false, plugins: false },
    env: (r) => ({
      ANTIGRAVITY_CLI_DIR: join(r, 'gemini', 'antigravity-cli'),
      ANTIGRAVITY_DIR: join(r, 'gemini', 'antigravity'),
    }),
    build: (ctx) => {
      mkdirSync(join(ctx.root, 'gemini', 'antigravity-cli'), { recursive: true });
      mkdirSync(join(ctx.root, 'gemini', 'antigravity'), { recursive: true });
    },
  },
};

const KINDS: Kind[] = ['mcpServers', 'hooks', 'plugins'];

let work: string;
let saved: Record<string, string | undefined>;
let configFiles: string[];
let secrets: string[];

function makeCtx(root: string): Ctx {
  return {
    root,
    secret: (label) => {
      const value = `sek${secrets.length}${label}Zx9Qv4Wm`;
      secrets.push(value);
      return value;
    },
    file: (path, content, opts) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
      if (!opts?.bundle) configFiles.push(path);
      return path;
    },
  };
}

function pointEnvAt(root: string): void {
  for (const a of Object.values(AGENTS)) Object.assign(process.env, a.env(root));
}

function buildFixture(): Ctx {
  const ctx = makeCtx(work);
  pointEnvAt(work);
  for (const a of Object.values(AGENTS)) a.build(ctx);
  return ctx;
}

function agent(res: ReturnType<typeof collectExtensions>, id: string) {
  const a = res.agents.find((x) => x.connectorId === id);
  if (!a) throw new Error(`agent ${id} missing from the response`);
  return a;
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'claudescope-ext-secrets-'));
  saved = Object.fromEntries(ENV_VARS.map((k) => [k, process.env[k]]));
  configFiles = [];
  secrets = [];
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ENV_VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(work, { recursive: true, force: true });
});

describe('extensions never leak secrets', () => {
  it('serializes none of the planted secrets, and the fixture is not vacuous', () => {
    buildFixture();
    const res = collectExtensions();

    for (const [id, fx] of Object.entries(AGENTS)) {
      const a = agent(res, id);
      for (const kind of KINDS) {
        if (fx.supports[kind]) expect(a[kind]?.length, `${id} ${kind}`).toBeGreaterThan(0);
      }
    }
    const cc = agent(res, 'claude-code');
    expect(cc.mcpServers!.some((s) => s.scope === 'project')).toBe(true);
    for (const id of ['claude-code', 'codex', 'junie', 'copilot', 'grok']) {
      const a = agent(res, id);
      expect(a.mcpServers!.some((s) => s.scope === 'plugin'), `${id} bundled mcp`).toBe(true);
      expect(a.hooks!.some((h) => h.scope === 'plugin'), `${id} bundled hook`).toBe(true);
      expect(a.plugins!.some((p) => p.kind === 'bundle'), `${id} bundle plugin`).toBe(true);
    }
    expect(agent(res, 'pi').plugins!.some((p) => p.kind === 'package')).toBe(true);

    const body = JSON.stringify(res);
    expect(secrets.length).toBeGreaterThan(80);
    expect(secrets.filter((s) => body.includes(s))).toEqual([]);
  });
});

describe('extensions registry conformance', () => {
  it('has a fixture for every connector and no stale ones', () => {
    expect(connectors.map((c) => c.id).sort()).toEqual(Object.keys(AGENTS).sort());
  });

  it('reports each kind as supported (array) or unsupported (null) exactly as expected', () => {
    buildFixture();
    const res = collectExtensions();
    for (const c of connectors) {
      const a = agent(res, c.id);
      for (const kind of KINDS) {
        const supported = AGENTS[c.id]!.supports[kind];
        expect(a[kind] === null, `${c.id} ${kind}`).toBe(!supported);
        expect(typeof c[kind] === 'function', `${c.id}.${kind}() declared`).toBe(supported);
      }
    }
  });
});

describe('extensions robustness', () => {
  it('survives malformed config files, leaving no user-scope entries', () => {
    buildFixture();
    for (const f of configFiles) writeFileSync(f, f.endsWith('.toml') ? '= = =' : '{ bad');

    let res: ReturnType<typeof collectExtensions> | undefined;
    expect(() => (res = collectExtensions())).not.toThrow();
    for (const a of res!.agents) {
      expect(a.mcpServers?.filter((s) => s.scope === 'user') ?? [], `${a.connectorId} mcp`).toEqual([]);
      expect(a.hooks?.filter((h) => h.scope === 'user') ?? [], `${a.connectorId} hooks`).toEqual([]);
    }
  });

  it('isolates a throwing connector to that kind of that agent', () => {
    buildFixture();
    const baseline = collectExtensions();

    const target = connectors.find((c) => c.id === 'claude-code')!;
    vi.spyOn(target, 'mcpServers').mockImplementation(() => {
      throw new Error('boom');
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = collectExtensions();
    expect(agent(res, 'claude-code').mcpServers).toEqual([]);
    expect(agent(res, 'claude-code').hooks).toEqual(agent(baseline, 'claude-code').hooks);
    expect(agent(res, 'claude-code').plugins).toEqual(agent(baseline, 'claude-code').plugins);
    for (const other of res.agents.filter((a) => a.connectorId !== 'claude-code')) {
      expect(other).toEqual(agent(baseline, other.connectorId));
    }
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('boom');
  });

  it('skips Codex hooks.state trust records and keeps the one real hook', () => {
    const ctx = makeCtx(work);
    pointEnvAt(work);
    ctx.file(
      join(work, 'codex', 'config.toml'),
      `[hooks.state."x:hooks.json:stop:0:0"]
trusted_hash = "sha256:abc"

[[hooks.Stop]]
matcher = "x"

[[hooks.Stop.hooks]]
type = "command"
command = "./stop.sh"
`,
    );
    const hooks = agent(collectExtensions(), 'codex').hooks!;
    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toMatchObject({ event: 'Stop', command: './stop.sh', scope: 'user' });
  });
});
