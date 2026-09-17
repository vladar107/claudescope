/**
 * End-to-end test for `GET /api/skills`: a sandboxed `~/.claude` holding a user
 * skill and a plugin-shipped one, indexed alongside a Claude Code session that
 * invokes `foo`, `myplug:bar` and a third skill installed nowhere — plus a FORK
 * copy of that whole session, which must contribute no calls.
 *
 * This is the only place the Claude Code `skill_names` projection (derived in
 * SQL, so unreachable from `connector-skill-signal.test.ts`) meets the live
 * home-dir read and the usage join. The edges it pins down: a plugin skill
 * joins usage under its `plugin:skill` name, an invoked-but-uninstalled name
 * lands in `unlocated` rather than being dropped, an installed-but-unused skill
 * counts as never-used, and fork copies are excluded exactly as they are from
 * every other per-row count.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AgentSkills, SkillsConnectorOverview, SkillsResponse } from '@claudescope/shared';

// --- temp locations (decided before any server module is imported) ----------
const work = realpathSync(mkdtempSync(join(tmpdir(), 'claudescope-skillsapi-')));
const claudeHome = join(work, 'claude');
const projectsDir = join(claudeHome, 'projects');
const pluginCache = join(work, 'plugin-cache', 'myplug');

process.env.CLAUDE_PROJECTS_DIR = projectsDir;
// Isolate from every real agent home so this Claude-only suite stays deterministic.
process.env.CODEX_SESSIONS_DIR = join(work, 'codex-empty', 'sessions');
process.env.JUNIE_SESSIONS_DIR = join(work, 'junie-empty', 'sessions');
process.env.PI_SESSIONS_DIR = join(work, 'pi-empty', 'sessions');
process.env.OPENCODE_DATA_DIR = join(work, 'opencode-empty');
process.env.OPENCODE_CONFIG_DIR = join(work, 'opencode-config-empty');
process.env.COPILOT_SESSIONS_DIR = join(work, 'copilot-empty', 'sessions');
process.env.ANTIGRAVITY_CLI_DIR = join(work, 'antigravity-empty');
process.env.ANTIGRAVITY_DIR = join(work, 'antigravity-desktop-empty');
process.env.GROK_SESSIONS_DIR = join(work, 'grok-empty', 'sessions');
process.env.DUCKDB_PATH = join(work, 'index.duckdb');
process.env.CLAUDESCOPE_HOME = join(work, 'home');
process.env.REINDEX_INTERVAL_MS = '0';

const jsonl = (events: unknown[]): string => events.map((e) => JSON.stringify(e)).join('\n') + '\n';

const MODEL = 'claude-opus-4-8';
const CWD = '/tmp/skillsapi';
const MAIN = 'skillsMain';
const FORK = 'skillsFork';

type Fork = { sessionId: string; messageUuid: string };

/** Timestamp of the last Skill call — what `lastUsedAt` must come back as. */
const LAST_CALL_TS = '2026-01-01T10:00:05.000Z';

/** One assistant line: a single content block, the message-level usage repeated. */
function asst(opts: {
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  timestamp: string;
  messageId: string;
  content: Record<string, unknown>;
  forkedFrom?: Fork;
}): Record<string, unknown> {
  const line: Record<string, unknown> = {
    type: 'assistant',
    uuid: opts.uuid,
    parentUuid: opts.parentUuid,
    sessionId: opts.sessionId,
    timestamp: opts.timestamp,
    cwd: CWD,
    isSidechain: false,
    requestId: `req_${opts.uuid}`,
    message: {
      id: opts.messageId,
      role: 'assistant',
      model: MODEL,
      content: [opts.content],
      usage: {
        input_tokens: 100,
        output_tokens: 10,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  };
  if (opts.forkedFrom) line.forkedFrom = opts.forkedFrom;
  return line;
}

const skillCall = (id: string, skill: string) => ({
  type: 'tool_use',
  id,
  name: 'Skill',
  input: { skill },
});

/** The session's lines; `forkedFrom` is stamped on EVERY line of a fork copy. */
function lines(sessionId: string, forkedFrom?: Fork): unknown[] {
  const ff = forkedFrom ? { forkedFrom } : {};
  return [
    { type: 'ai-title', sessionId, aiTitle: `Session ${sessionId}` },
    {
      type: 'user',
      uuid: 'm-u1',
      parentUuid: null,
      sessionId,
      timestamp: '2026-01-01T10:00:00.000Z',
      cwd: CWD,
      isSidechain: false,
      message: { role: 'user', content: 'use the skills' },
      ...ff,
    },
    // One billed response written the REAL way: a text row plus two tool_use
    // rows sharing `message.id`. The tool rows lose the usage election, so a
    // count filtered on it would miss both skills.
    asst({ uuid: 'm-a1', parentUuid: 'm-u1', sessionId, timestamp: '2026-01-01T10:00:01.000Z', messageId: 'msg_1', content: { type: 'text', text: 'on it' }, ...ff }),
    asst({ uuid: 'm-a2', parentUuid: 'm-u1', sessionId, timestamp: '2026-01-01T10:00:01.100Z', messageId: 'msg_1', content: skillCall('tu_foo', 'foo'), ...ff }),
    asst({ uuid: 'm-a3', parentUuid: 'm-u1', sessionId, timestamp: '2026-01-01T10:00:01.200Z', messageId: 'msg_1', content: skillCall('tu_bar', 'myplug:bar'), ...ff }),
    // The same plugin skill recorded by its bare directory name (a SKILL.md read
    // outside a recognisable plugin layout) — must fold into `myplug:bar`.
    asst({ uuid: 'm-a5', parentUuid: 'm-u1', sessionId, timestamp: '2026-01-01T10:00:01.300Z', messageId: 'msg_5', content: skillCall('tu_bar2', 'bar'), ...ff }),
    {
      type: 'user',
      uuid: 'm-u2',
      parentUuid: 'm-a3',
      sessionId,
      timestamp: '2026-01-01T10:00:02.000Z',
      cwd: CWD,
      isSidechain: false,
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_foo', content: 'foo loaded' },
          { type: 'tool_result', tool_use_id: 'tu_bar', content: 'bar loaded' },
        ],
      },
      ...ff,
    },
    // A skill that is invoked but installed nowhere the home dir reaches.
    asst({ uuid: 'm-a4', parentUuid: 'm-u2', sessionId, timestamp: LAST_CALL_TS, messageId: 'msg_2', content: skillCall('tu_gone', 'gone'), ...ff }),
  ];
}

function writeSkill(dir: string, name: string, description: string): void {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(
    join(dir, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
  );
}

function writeFixtures(): void {
  // ~/.claude/skills — one used, one never used.
  const userSkills = join(claudeHome, 'skills');
  writeSkill(userSkills, 'foo', 'The used user skill');
  writeSkill(userSkills, 'unused', 'Installed but never invoked');

  // A plugin cache plus the manifest that points at it (schema version 2).
  writeSkill(join(pluginCache, 'skills'), 'bar', 'A plugin-shipped skill');
  mkdirSync(join(claudeHome, 'plugins'), { recursive: true });
  writeFileSync(
    join(claudeHome, 'plugins', 'installed_plugins.json'),
    JSON.stringify({
      version: 2,
      plugins: {
        'myplug@marketplace-x': [{ scope: 'user', installPath: pluginCache, version: '1.2.3' }],
      },
    }),
  );

  const proj = join(projectsDir, 'enc-skillsapi');
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, `${MAIN}.jsonl`), jsonl(lines(MAIN)));
  // The same history copied under a new sessionId, every line marked forked.
  writeFileSync(
    join(proj, `${FORK}.jsonl`),
    jsonl(lines(FORK, { sessionId: MAIN, messageUuid: 'm-a4' })),
  );
}

let app: FastifyInstance;
let closeConnection: () => Promise<void>;
let body: SkillsResponse;
let claude: AgentSkills;
let overview: SkillsConnectorOverview;

beforeAll(async () => {
  writeFixtures();

  const Fastify = (await import('fastify')).default;
  const { registerRoutes } = await import('../src/routes/index.js');
  const { reindex } = await import('../src/data/index.js');
  ({ closeConnection } = await import('../src/db/duckdb.js'));

  app = Fastify();
  await registerRoutes(app);
  await reindex();
  await app.ready();

  body = (await app.inject({ method: 'GET', url: '/api/skills' })).json() as SkillsResponse;
  claude = body.agents.find((a) => a.connectorId === 'claude-code')!;
  overview = body.connectors.find((c) => c.connectorId === 'claude-code')!;
});

afterAll(async () => {
  await app?.close();
  await closeConnection?.();
  rmSync(work, { recursive: true, force: true });
});

describe('GET /api/skills', () => {
  it('does not detect an agent that merely reads another agent\'s skills dir', () => {
    // opencode's hook reads `~/.claude/skills` too, but only its OWN store is
    // evidence it is installed — this sandbox never ran it.
    expect(body.connectors.map((c) => c.connectorId)).not.toContain('opencode');
    expect(body.agents.map((a) => a.connectorId)).not.toContain('opencode');
  });

  it('lists the user and plugin skills the sandboxed home dir holds', () => {
    expect(claude.usageSignal).toBe(true);
    expect(claude.skills.map((s) => s.name)).toEqual(['foo', 'myplug:bar', 'unused']);

    const bar = claude.skills.find((s) => s.name === 'myplug:bar')!;
    expect(bar.origin).toBe('plugin');
    expect(bar.plugin).toEqual({ name: 'myplug', marketplace: 'marketplace-x', version: '1.2.3' });
    expect(bar.description).toBe('A plugin-shipped skill');
    expect(bar.sourcePath).toBe(join(pluginCache, 'skills', 'bar'));
  });

  it('joins indexed usage by name, including the plugin:skill form', () => {
    const byName = new Map(claude.skills.map((s) => [s.name, s]));
    expect(byName.get('foo')!.usage).toMatchObject({ calls: 1, sessions: 1 });
    // Two calls, one native `myplug:bar` and one bare `bar`, folded — and the
    // session is counted once because the fold happens before the DISTINCT.
    expect(byName.get('myplug:bar')!.usage).toMatchObject({ calls: 2, sessions: 1 });
    expect(claude.unlocated.map((u) => u.name)).not.toContain('bar');
    // Installed but never invoked: no usage at all, not a zeroed one.
    expect(byName.get('unused')!.usage).toBeUndefined();

    const lastUsedAt = byName.get('foo')!.usage!.lastUsedAt!;
    expect(typeof lastUsedAt).toBe('string');
    expect(new Date(lastUsedAt).toISOString()).toBe(lastUsedAt);
  });

  it('excludes the fork copy from the call counts', () => {
    // Both files carry the same three Skill calls; only the original counts.
    const byName = new Map(claude.skills.map((s) => [s.name, s]));
    expect(byName.get('foo')!.usage!.calls).toBe(1);
    expect(byName.get('foo')!.usage!.sessions).toBe(1);
    expect(claude.unlocated[0]!.usage.calls).toBe(1);
    expect(claude.unlocated[0]!.usage.sessions).toBe(1);
  });

  it('reports an invoked-but-uninstalled skill as unlocated, with its last use', () => {
    expect(claude.unlocated.map((u) => u.name)).toEqual(['gone']);
    expect(claude.unlocated[0]!.usage.lastUsedAt).toBe(LAST_CALL_TS);
  });

  it('folds the bare directory name into the plugin skill on the analytics chart too', async () => {
    const res = (await app.inject({ method: 'GET', url: '/api/analytics/tools?kind=skill' })).json() as {
      rows: { tool: string; agent: string; count: number }[];
    };
    const names = res.rows.map((r) => r.tool);
    expect(names).not.toContain('bar');
    expect(res.rows.find((r) => r.tool === 'myplug:bar')).toMatchObject({ agent: 'claude-code', count: 2 });
  });

  it('rolls the same figures up into the landing card', () => {
    expect(overview.supported).toBe(true);
    expect(overview.usageSignal).toBe(true);
    expect(overview.installed).toBe(3);
    expect(overview.used).toBe(2); // foo + myplug:bar
    expect(overview.neverUsed).toBe(1); // unused
    expect(overview.unlocated).toBe(1); // gone
  });
});
