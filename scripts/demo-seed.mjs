#!/usr/bin/env node
/**
 * Write a synthetic MULTI-AGENT dataset for screenshots/demos — one source per
 * supported agent, all fabricated (no real names/paths/content). Everything is
 * laid out under a single base dir (default ./.demo) so the screenshot pipeline
 * and a manual `npm start` can point every connector at the same demo tree:
 *
 *   node scripts/demo-seed.mjs [baseDir]      # defaults to ./.demo
 *
 * Each agent gets its OWN home subdir under <base> — mirroring the real separate
 * ~/.claude, ~/.codex, ~/.junie homes — so every connector's memory file resolves
 * to a distinct location (a connector's home is the PARENT of its sessions dir):
 *   claude/projects/                 CLAUDE_PROJECTS_DIR    (CLAUDE_HOME  = <base>/claude)
 *   claude/CLAUDE.md                 Claude global memory
 *   claude/projects/-home-dev-acme-web/memory/*.md  Claude per-project facts
 *   codex/sessions/                  CODEX_SESSIONS_DIR     (CODEX_HOME   = <base>/codex)
 *   codex/AGENTS.md                  Codex global memory
 *   junie/sessions/                  JUNIE_SESSIONS_DIR     (JUNIE_HOME   = <base>/junie)
 *   junie/AGENTS.md                  Junie global memory
 *   pi/sessions/                     PI_SESSIONS_DIR        (pi has no memory)
 *   opencode/opencode.db             OPENCODE_DATA_DIR      (SQLite; no memory)
 *   copilot/session-state/           COPILOT_SESSIONS_DIR   (COPILOT_HOME = <base>/copilot)
 *   copilot/copilot-instructions.md  Copilot global memory
 *   gemini/antigravity-cli/          ANTIGRAVITY_CLI_DIR    (memory: gemini/config/agents/AGENTS.md)
 *   gemini/antigravity/              ANTIGRAVITY_DIR        (desktop app dir; left empty)
 *   grok/sessions/                   GROK_SESSIONS_DIR      (no memory)
 *
 * Run the app against it (all eight sources; memory homes derive from the dirs):
 *   base=.demo \
 *   CLAUDE_PROJECTS_DIR=$base/claude/projects CODEX_SESSIONS_DIR=$base/codex/sessions \
 *   JUNIE_SESSIONS_DIR=$base/junie/sessions PI_SESSIONS_DIR=$base/pi/sessions \
 *   OPENCODE_DATA_DIR=$base/opencode COPILOT_SESSIONS_DIR=$base/copilot/session-state \
 *   ANTIGRAVITY_CLI_DIR=$base/gemini/antigravity-cli ANTIGRAVITY_DIR=$base/gemini/antigravity \
 *   GROK_SESSIONS_DIR=$base/grok/sessions \
 *   npm start
 *
 * `acme-web` is deliberately shared by ALL EIGHT agents (same cwd) so its project
 * card shows every agent tag and the agent filter; the other projects are
 * single-agent. The per-source layout below is kept IN SYNC with
 * scripts/screenshots.mjs, which seeds into a temp <base> and sets these vars.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedLive } from './demo-seed-live.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const baseDir = process.argv[2] ?? join(root, '.demo');

// Per-agent home subdirs under <base>. KEEP IN SYNC with scripts/screenshots.mjs.
// A connector's home is the PARENT of its sessions dir, so the sessions dir is
// nested one level inside each agent's home (where its memory file lives).
const claudeHome = join(baseDir, 'claude');
const codexHome = join(baseDir, 'codex');
const junieHome = join(baseDir, 'junie');
const copilotHome = join(baseDir, 'copilot');
const outDir = join(claudeHome, 'projects'); //  CLAUDE_PROJECTS_DIR
const codexDir = join(codexHome, 'sessions'); //  CODEX_SESSIONS_DIR
const junieDir = join(junieHome, 'sessions'); //  JUNIE_SESSIONS_DIR
const piDir = join(baseDir, 'pi', 'sessions'); // PI_SESSIONS_DIR
const opencodeDir = join(baseDir, 'opencode'); // OPENCODE_DATA_DIR (db at /opencode.db)
const copilotSessionsDir = join(copilotHome, 'session-state'); // COPILOT_SESSIONS_DIR
const geminiHome = join(baseDir, 'gemini');
const antigravityCliDir = join(geminiHome, 'antigravity-cli'); // ANTIGRAVITY_CLI_DIR
const grokHome = join(baseDir, 'grok');
const grokDir = join(grokHome, 'sessions'); // GROK_SESSIONS_DIR

// Wipe prior output (each agent's whole home) so reseeding is deterministic.
for (const dir of [claudeHome, codexHome, junieHome, join(baseDir, 'pi'), opencodeDir, copilotHome, geminiHome, grokHome]) {
  rmSync(dir, { recursive: true, force: true });
}

const jsonl = (events) => events.map((e) => JSON.stringify(e)).join('\n') + '\n';
function write(rel, events) {
  const full = join(outDir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, jsonl(events));
}
function writeMeta(rel, meta) {
  const full = join(outDir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, JSON.stringify(meta));
}

const OPUS = 'claude-opus-4-8';
const SONNET = 'claude-sonnet-4-6';
const HAIKU = 'claude-haiku-4-5-20251001';

// Usage helper with healthy cache numbers so analytics looks realistic.
const usage = (input, output, read, write_) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write_,
});

let uuidN = 0;
const uid = (s) => `${s}-${String(++uuidN).padStart(4, '0')}`;

function user(sid, ts, content, extra = {}) {
  return {
    type: 'user',
    sessionId: sid,
    uuid: uid('u'),
    parentUuid: null,
    cwd: extra.cwd,
    gitBranch: extra.gitBranch,
    timestamp: ts,
    isSidechain: extra.isSidechain ?? false,
    ...(extra.agentId ? { agentId: extra.agentId } : {}),
    message: { role: 'user', content },
  };
}
function asst(sid, ts, content, model, u, extra = {}) {
  return {
    type: 'assistant',
    sessionId: sid,
    uuid: uid('a'),
    parentUuid: null,
    cwd: extra.cwd,
    gitBranch: extra.gitBranch,
    timestamp: ts,
    isSidechain: extra.isSidechain ?? false,
    ...(extra.agentId ? { agentId: extra.agentId } : {}),
    message: { role: 'assistant', model, content, usage: u },
  };
}

// ── Project A: acme-web ────────────────────────────────────────────────────
const A = { cwd: '/home/dev/acme-web', gitBranch: 'feat/dark-mode' };

const OLD_SETTINGS = `export function Settings() {
  return (
    <div className="settings">
      <h1>Settings</h1>
    </div>
  );
}`;
const NEW_SETTINGS = `export function Settings() {
  const { theme, toggle } = useTheme();
  return (
    <div className="settings">
      <h1>Settings</h1>
      <ThemeToggle theme={theme} onToggle={toggle} />
    </div>
  );
}`;

write('home-dev-acme-web/sess-darkmode.jsonl', [
  { type: 'ai-title', sessionId: 'sess-darkmode', aiTitle: 'Add a dark-mode toggle' },
  user('sess-darkmode', '2026-05-26T09:00:00.000Z', 'Add a dark-mode toggle to the settings page and persist the choice in localStorage.', A),
  asst('sess-darkmode', '2026-05-26T09:00:08.000Z', [
    { type: 'thinking', thinking: '', signature: 'sig' },
    { type: 'text', text: "I'll add a `useTheme` hook and a `ThemeToggle`. First let me read the current settings page." },
    { type: 'tool_use', id: 'tu-read', name: 'Read', input: { file_path: 'src/settings.tsx' } },
  ], OPUS, usage(1800, 240, 95000, 12000), A),
  user('sess-darkmode', '2026-05-26T09:00:20.000Z', [
    { type: 'tool_result', tool_use_id: 'tu-read', content: `     1\t${OLD_SETTINGS.split('\n').join('\n     2\t')}` },
  ], A),
  asst('sess-darkmode', '2026-05-26T09:00:35.000Z', [
    { type: 'text', text: 'Now I will wire in the theme toggle.' },
    { type: 'tool_use', id: 'tu-edit', name: 'Edit', input: { file_path: 'src/settings.tsx', old_string: OLD_SETTINGS, new_string: NEW_SETTINGS } },
  ], OPUS, usage(900, 320, 110000, 4000), A),
  user('sess-darkmode', '2026-05-26T09:00:55.000Z', [
    { type: 'tool_result', tool_use_id: 'tu-edit', content: 'The file src/settings.tsx has been updated.' },
  ], A),
  asst('sess-darkmode', '2026-05-26T09:01:10.000Z', [
    { type: 'text', text: 'Let me delegate a quick audit of the existing theme system.' },
    { type: 'tool_use', id: 'tu-agent', name: 'Agent', input: { description: 'Map the theme system', subagent_type: 'Explore' } },
  ], OPUS, usage(700, 180, 120000, 2000), A),
  user('sess-darkmode', '2026-05-26T09:02:30.000Z', [
    { type: 'tool_result', tool_use_id: 'tu-agent', content: 'Theme is read from a ThemeContext provider at the app root; no persistence today.' },
  ], A),
  asst('sess-darkmode', '2026-05-26T09:02:45.000Z', [
    { type: 'text', text: 'Running the settings tests.' },
    { type: 'tool_use', id: 'tu-bash', name: 'Bash', input: { command: 'npm test -- settings', description: 'Run the settings test suite' } },
  ], OPUS, usage(600, 90, 121000, 800), A),
  user('sess-darkmode', '2026-05-26T09:03:05.000Z', [
    { type: 'tool_result', tool_use_id: 'tu-bash', content: 'PASS  src/settings.test.tsx\n  ✓ renders a theme toggle (24 ms)\n  ✓ persists the choice (11 ms)\n\nTests: 2 passed, 2 total' },
  ], A),
  asst('sess-darkmode', '2026-05-26T09:03:20.000Z', [
    { type: 'text', text: '**Done.** Dark mode now persists via `localStorage` and the toggle lives on the settings page.' },
  ], OPUS, usage(500, 140, 122000, 600), A),
  { type: 'pr-link', sessionId: 'sess-darkmode', prNumber: 142, prRepository: 'acme/acme-web', prUrl: 'https://example.com/acme/acme-web/pull/142' },
]);

// Subagent transcript for the Explore agent above.
const SUB = { cwd: '/home/dev/acme-web', isSidechain: true, agentId: 'theme1' };
write('home-dev-acme-web/sess-darkmode/subagents/agent-theme1.jsonl', [
  user('sess-darkmode', '2026-05-26T09:01:15.000Z', 'Map the theme system: where is the theme stored and how is it applied?', SUB),
  asst('sess-darkmode', '2026-05-26T09:01:40.000Z', [
    { type: 'text', text: 'Searching for the theme provider.' },
    { type: 'tool_use', id: 'sa-grep', name: 'Grep', input: { pattern: 'ThemeContext' } },
  ], HAIKU, usage(400, 60, 30000, 1500), SUB),
  user('sess-darkmode', '2026-05-26T09:01:55.000Z', [
    { type: 'tool_result', tool_use_id: 'sa-grep', content: 'src/theme/ThemeContext.tsx: export const ThemeContext = createContext(...)' },
  ], SUB),
  asst('sess-darkmode', '2026-05-26T09:02:20.000Z', [
    { type: 'text', text: 'Theme lives in `ThemeContext` at the app root and is applied via a `data-theme` attribute. No persistence is wired up yet.' },
  ], HAIKU, usage(500, 120, 31000, 0), SUB),
]);
writeMeta('home-dev-acme-web/sess-darkmode/subagents/agent-theme1.meta.json', {
  agentType: 'Explore',
  description: 'Map the theme system',
});

write('home-dev-acme-web/sess-checkout.jsonl', [
  { type: 'ai-title', sessionId: 'sess-checkout', aiTitle: 'Fix the flaky checkout test' },
  user('sess-checkout', '2026-05-28T14:10:00.000Z', 'The checkout integration test is flaky in CI. Can you stabilize it?', { cwd: '/home/dev/acme-web', gitBranch: 'main' }),
  asst('sess-checkout', '2026-05-28T14:10:12.000Z', [
    { type: 'text', text: 'Likely a timing race on the async cart update. I will await the network idle instead of a fixed timeout.' },
  ], SONNET, usage(2200, 360, 88000, 9000), { cwd: '/home/dev/acme-web', gitBranch: 'main' }),
]);

// ── Project B: data-pipeline ───────────────────────────────────────────────
const B = { cwd: '/home/dev/data-pipeline', gitBranch: 'main' };
write('home-dev-data-pipeline/sess-etl.jsonl', [
  { type: 'ai-title', sessionId: 'sess-etl', aiTitle: 'Speed up the nightly ETL' },
  user('sess-etl', '2026-06-01T22:00:00.000Z', 'The nightly ETL takes 3 hours. Profile it and suggest where to parallelize.', B),
  asst('sess-etl', '2026-06-01T22:00:15.000Z', [
    { type: 'text', text: 'The join step is single-threaded. Partitioning by `customer_id` lets us fan out across workers.' },
    { type: 'tool_use', id: 'tu-bash2', name: 'Bash', input: { command: 'python -m cProfile -s tottime etl/run.py --dry-run', description: 'Profile the ETL run' } },
  ], OPUS, usage(3100, 540, 175000, 21000), B),
  user('sess-etl', '2026-06-01T22:02:00.000Z', [
    { type: 'tool_result', tool_use_id: 'tu-bash2', content: 'ncalls  tottime  cumtime\n  1     5421.0   9800.0  join_customers\n  1      210.0    640.0  load_orders' },
  ], B),
  asst('sess-etl', '2026-06-02T22:05:00.000Z', [
    { type: 'text', text: '`join_customers` dominates (5,421s). Partitioning the join should cut wall-clock by ~4× on an 8-core box.' },
  ], OPUS, usage(900, 220, 178000, 1200), B),
]);

// ── Bulk sessions to populate the analytics charts ─────────────────────────
// Deterministic (seeded) so screenshots are reproducible. These are intentionally
// terse (generic titles, short content) so they don't pollute Browse/Search.
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(1337);
const pick = (a) => a[Math.floor(rand() * a.length)];
const span = (lo, hi) => Math.floor(lo + rand() * (hi - lo));

const PROJECTS = [
  { dir: 'home-dev-acme-web', cwd: '/home/dev/acme-web' },
  { dir: 'home-dev-data-pipeline', cwd: '/home/dev/data-pipeline' },
  { dir: 'home-dev-billing-service', cwd: '/home/dev/billing-service' },
  { dir: 'home-dev-mobile-app', cwd: '/home/dev/mobile-app' },
];
const MODELS = [OPUS, SONNET, HAIKU, 'claude-opus-4-7'];
const TITLES = [
  'Refactor the auth middleware', 'Add webhook retries', 'Migrate tests to Vitest',
  'Fix an N+1 query', 'Tune the cache TTLs', 'Add cursor pagination',
  'Profile a slow endpoint', 'Add feature flags', 'Harden the CSP headers',
  'Batch the importer', 'Wire up request tracing', 'Dedupe the job queue',
];

const BASE = Date.parse('2026-05-15T10:00:00.000Z');
let bn = 0;
for (let d = 0; d < 20; d++) {
  const perDay = span(1, 4);
  for (let s = 0; s < perDay; s++) {
    const proj = pick(PROJECTS);
    const model = pick(MODELS);
    const sid = `bulk-${++bn}`;
    const start = BASE + d * 86_400_000 + span(0, 9) * 3_600_000;
    const events = [
      { type: 'ai-title', sessionId: sid, aiTitle: pick(TITLES) },
      user(sid, new Date(start).toISOString(), 'Working on the task.', { cwd: proj.cwd, gitBranch: 'main' }),
    ];
    const turns = span(2, 6);
    for (let t = 0; t < turns; t++) {
      events.push(
        asst(
          sid,
          new Date(start + (t + 1) * 120_000).toISOString(),
          [{ type: 'text', text: 'Making progress.' }],
          model,
          usage(span(800, 5000), span(400, 3000), span(40_000, 900_000), span(4000, 70_000)),
          { cwd: proj.cwd, gitBranch: 'main' },
        ),
      );
    }
    write(`${proj.dir}/${sid}.jsonl`, events);
  }
}

// ── Codex sessions (separate source dir; pointed at by CODEX_SESSIONS_DIR) ──
// Codex spreads a session across record types under YYYY/MM/DD/rollout-*.jsonl.
// `acme-web` deliberately shares a cwd with the Claude project above so its card
// shows BOTH agent tags and the agent filter; `infra-scripts` is Codex-only.
function writeCodex(datePath, fileName, lines) {
  const full = join(codexDir, datePath, fileName);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}
const cx = (type, payload, ts) => ({ type, payload, timestamp: ts });
const cxMeta = (id, cwd, branch, ts) =>
  cx('session_meta', { id, cwd, cli_version: '0.122.0', model_provider: 'openai', git: { branch } }, ts);
const cxModel = (model, cwd, ts) => cx('turn_context', { model, cwd }, ts);
const cxUser = (text, ts) =>
  cx('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }, ts);
const cxAsst = (text, ts) =>
  cx('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }, ts);
const cxReason = (ts) => cx('response_item', { type: 'reasoning', summary: [], content: null, encrypted_content: 'enc' }, ts);
const cxCall = (name, args, callId, ts) =>
  cx('response_item', { type: 'function_call', name, arguments: args, call_id: callId }, ts);
const cxOut = (callId, output, ts) =>
  cx('response_item', { type: 'function_call_output', call_id: callId, output }, ts);
// token_count attributes to the currently-open assistant turn, so emit it after
// the assistant's items and before the next user/tool-output flips the side.
const cxTok = (input, cached, output, ts) =>
  cx('event_msg', {
    type: 'token_count',
    info: {
      last_token_usage: {
        input_tokens: input,
        cached_input_tokens: cached,
        output_tokens: output,
        reasoning_output_tokens: 0,
        total_tokens: input + output,
      },
    },
    rate_limits: {},
  }, ts);

// Codex session in the shared acme-web project (makes it multi-agent).
writeCodex('2026/06/03', 'rollout-2026-06-03T11-20-00-019ec000-0000-7000-a000-000000000001.jsonl', [
  cxMeta('codex-acme-tokens', '/home/dev/acme-web', 'feat/dark-mode', '2026-06-03T11:20:00.000Z'),
  cxModel('gpt-5.5', '/home/dev/acme-web', '2026-06-03T11:20:01.000Z'),
  cxUser('Port the theme colors to CSS custom properties and add a light palette.', '2026-06-03T11:20:02.000Z'),
  cxAsst("I'll move the palette into :root and add a light override block.", '2026-06-03T11:20:06.000Z'),
  cxReason('2026-06-03T11:20:07.000Z'),
  cxTok(14000, 9000, 900, '2026-06-03T11:20:08.000Z'),
  cxCall('shell', '{"command":"grep -rn \\"--tv-\\" src/styles"}', 'c1', '2026-06-03T11:20:09.000Z'),
  cxOut('c1', 'src/styles/global.css:  --tv-bg: #0e1116;', '2026-06-03T11:20:12.000Z'),
  cxAsst('Added a `:root[data-theme=light]` block mirroring the dark palette. The toggle now switches both.', '2026-06-03T11:20:18.000Z'),
  cxTok(3000, 2400, 350, '2026-06-03T11:20:19.000Z'),
]);

writeCodex('2026/06/04', 'rollout-2026-06-04T09-05-00-019ec000-0000-7000-a000-000000000002.jsonl', [
  cxMeta('codex-acme-lint', '/home/dev/acme-web', 'main', '2026-06-04T09:05:00.000Z'),
  cxModel('gpt-5.4', '/home/dev/acme-web', '2026-06-04T09:05:01.000Z'),
  cxUser('Fix the remaining ESLint errors in the components directory.', '2026-06-04T09:05:02.000Z'),
  cxAsst('Most are unused imports and missing deps in effects. Fixing them now.', '2026-06-04T09:05:07.000Z'),
  cxTok(6200, 4000, 520, '2026-06-04T09:05:08.000Z'),
]);

// Codex-only project.
writeCodex('2026/06/05', 'rollout-2026-06-05T16-40-00-019ec000-0000-7000-a000-000000000003.jsonl', [
  cxMeta('codex-infra-tf', '/home/dev/infra-scripts', 'main', '2026-06-05T16:40:00.000Z'),
  cxModel('gpt-5.5', '/home/dev/infra-scripts', '2026-06-05T16:40:01.000Z'),
  cxUser('Write a Terraform module for an S3 bucket with versioning and lifecycle rules.', '2026-06-05T16:40:02.000Z'),
  cxAsst("Here's a module with versioning enabled and a 90-day transition to IA.", '2026-06-05T16:40:08.000Z'),
  cxReason('2026-06-05T16:40:09.000Z'),
  cxTok(9000, 5200, 1400, '2026-06-05T16:40:10.000Z'),
  cxCall('apply_patch', '{"path":"modules/s3/main.tf"}', 'c2', '2026-06-05T16:40:11.000Z'),
  cxOut('c2', 'modules/s3/main.tf created (42 lines)', '2026-06-05T16:40:14.000Z'),
  cxAsst('Module written. Run `terraform plan` to review before applying.', '2026-06-05T16:40:20.000Z'),
  cxTok(2600, 1800, 300, '2026-06-05T16:40:21.000Z'),
]);

writeCodex('2026/06/06', 'rollout-2026-06-06T13-12-00-019ec000-0000-7000-a000-000000000004.jsonl', [
  cxMeta('codex-infra-ci', '/home/dev/infra-scripts', 'main', '2026-06-06T13:12:00.000Z'),
  cxModel('gpt-5.4', '/home/dev/infra-scripts', '2026-06-06T13:12:01.000Z'),
  cxUser('Add a GitHub Actions workflow that runs terraform fmt and validate on PRs.', '2026-06-06T13:12:02.000Z'),
  cxAsst('Added `.github/workflows/terraform.yml` gating PRs on fmt + validate.', '2026-06-06T13:12:09.000Z'),
  cxTok(4800, 3100, 610, '2026-06-06T13:12:10.000Z'),
]);

// ── Agent memory (read LIVE from each agent's home dir; never indexed) ──────
// Each home is the parent of that agent's sessions dir (see layout above).
mkdirSync(claudeHome, { recursive: true });
writeFileSync(
  join(claudeHome, 'CLAUDE.md'),
  `# Global instructions

- Match the surrounding code's style; prefer small, focused diffs.
- Run the test suite after any change to shared modules.
- Use Conventional Commits (\`feat:\`, \`fix:\`, \`docs:\` …) for messages.
- Read configuration from the environment; never commit secrets.
`,
);
mkdirSync(codexHome, { recursive: true });
writeFileSync(
  join(codexHome, 'AGENTS.md'),
  `# Agent guide

This repository is a small web app. Prefer TypeScript, keep modules cohesive,
and add a test when fixing a bug. Ask before introducing a new dependency.
`,
);

// Claude per-project distilled facts. Attributed to the acme-web project via
// \`originSessionId\`; the dir uses Claude's dash-per-char cwd slug so the slug
// fallback resolves too. \`MEMORY.md\` is the index and is intentionally skipped.
const claudeMemDir = join(outDir, '-home-dev-acme-web', 'memory');
mkdirSync(claudeMemDir, { recursive: true });
const fact = (name, description, type, body) =>
  `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  type: ${type}\n  originSessionId: sess-darkmode\n---\n\n${body}\n`;
writeFileSync(
  join(claudeMemDir, 'theme-tokens-on-root.md'),
  fact(
    'Theme tokens live on :root',
    'The dark/light palette is a set of --tv-* CSS custom properties',
    'project',
    'The palette is a set of `--tv-*` CSS custom properties on `:root`, with a `:root[data-theme=light]` override block. Toggling swaps `data-theme` — never hard-code colors. See [[persist-theme-in-localstorage]].',
  ),
);
writeFileSync(
  join(claudeMemDir, 'persist-theme-in-localstorage.md'),
  fact(
    'Persist the theme in localStorage',
    'Theme choice is stored under the claudescope-theme key',
    'project',
    'The chosen theme persists in `localStorage` under `claudescope-theme` and is read on boot by the `useTheme` hook. Related: [[theme-tokens-on-root]].',
  ),
);
writeFileSync(
  join(claudeMemDir, 'tests-run-on-vitest.md'),
  fact(
    'Tests run on Vitest',
    'Use Vitest (not Jest) for new tests; co-locate them',
    'project',
    'The test runner is **Vitest**. Co-locate `*.test.tsx` next to the component and run `npm test -- <name>`.',
  ),
);
writeFileSync(
  join(claudeMemDir, 'MEMORY.md'),
  `# Memory index

- Theme tokens live on :root
- Persist the theme in localStorage
- Tests run on Vitest
`,
);

// Copilot global memory lives one level above the sessions dir (COPILOT_HOME).
mkdirSync(copilotHome, { recursive: true });
writeFileSync(
  join(copilotHome, 'copilot-instructions.md'),
  `# Copilot instructions

Keep edits minimal and explain the why in the PR description. Prefer the
project's existing utilities over introducing new helpers.
`,
);

// ── JetBrains Junie session (shares acme-web) ───────────────────────────────
// Event-sourced UI stream. index.jsonl gatekeeps discovery and the session dir
// name MUST equal sessionId. Timestamps here are epoch MILLISECONDS.
const JUNIE_SID = 'session-260607-100000-acme';
const junieSessionDir = join(junieDir, JUNIE_SID);
mkdirSync(junieSessionDir, { recursive: true });
// Junie global memory: JUNIE_HOME/AGENTS.md (JUNIE_HOME = parent of sessions dir).
writeFileSync(
  join(junieHome, 'AGENTS.md'),
  `# Junie guide

Favor the smallest change that satisfies the task. After editing, run the
relevant tests and summarize what changed and why.
`,
);
const jms = (sec) => Date.UTC(2026, 5, 7, 10, 0, sec);
writeFileSync(
  join(junieDir, 'index.jsonl'),
  JSON.stringify({
    sessionId: JUNIE_SID,
    createdAt: jms(0),
    updatedAt: jms(9),
    projectDir: '/home/dev/acme-web', // → cwd; display name "acme-web"
    taskName: 'Default to the OS color scheme',
  }) + '\n',
);
// Wrap a nested agentEvent in the SessionA2uxEvent envelope at epoch-ms `sec`.
const a2ux = (agentEvent, sec) => ({
  kind: 'SessionA2uxEvent',
  event: { state: 'IN_PROGRESS', agentEvent },
  timestampMs: jms(sec),
});
writeFileSync(
  join(junieSessionDir, 'events.jsonl'),
  jsonl([
    { kind: 'UserPromptEvent', prompt: 'When the OS is in dark mode and the user has not chosen a theme, default the app to dark.' },
    { kind: 'SendToAgentEvent' },
    // Per-turn token usage (drives cost). Field names map exactly:
    // inputTokens→input, outputTokens→output, cacheInputTokens→cache_read,
    // cacheCreateTokens→cache_write. The `cost` field is ignored (recomputed).
    a2ux(
      {
        kind: 'LlmResponseMetadataEvent',
        modelUsage: [
          { model: 'claude-sonnet-4-6', cost: 0.013, inputTokens: 4200, cacheInputTokens: 38000, cacheCreateTokens: 1500, outputTokens: 760, time: 0 },
        ],
      },
      2,
    ),
    // A file view → canonical `view` (label + files coalesced by stepId).
    a2ux({ kind: 'ToolBlockUpdatedEvent', stepId: 's1', text: 'Open the theme provider', status: 'IN_PROGRESS' }, 3),
    a2ux(
      {
        kind: 'ViewFilesBlockUpdatedEvent',
        stepId: 's1',
        status: 'COMPLETED',
        files: [{ relativePath: 'src/theme/ThemeProvider.tsx', lineFrom: 1, lineTo: 40 }],
        details: 'reads the stored theme; no OS fallback yet',
      },
      4,
    ),
    // A terminal step → canonical `Bash` (the command renders highlighted).
    a2ux({ kind: 'TerminalBlockUpdatedEvent', stepId: 's2', status: 'IN_PROGRESS', command: 'npm test -- theme' }, 5),
    a2ux({ kind: 'TerminalBlockUpdatedEvent', stepId: 's2', status: 'COMPLETED', details: 'PASS  3 passed, 3 total' }, 6),
    // A file change → canonical `Edit` (Files-changed tab).
    a2ux(
      {
        kind: 'FileChangesBlockUpdatedEvent',
        stepId: 's3',
        status: 'COMPLETED',
        changes: [
          {
            beforeContent: { kind: 'TextFileContent', text: "const stored = localStorage.getItem('claudescope-theme');\nreturn stored ?? 'light';\n" },
            afterContent: { kind: 'TextFileContent', text: "const stored = localStorage.getItem('claudescope-theme');\nif (stored) return stored;\nreturn matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';\n" },
            beforeRelativePath: 'src/theme/ThemeProvider.tsx',
            afterRelativePath: 'src/theme/ThemeProvider.tsx',
          },
        ],
      },
      7,
    ),
    a2ux({ kind: 'AgentCurrentStatusUpdatedEvent', status: 'Wrapping up' }, 7), // ignored
    a2ux({ kind: 'ResultBlockUpdatedEvent', stepId: 'sr', cancelled: false, result: 'Done — the app now follows the OS appearance when no choice is stored.', changes: [] }, 8),
    { kind: 'TaskState', state: 'COMPLETED', timestampMs: jms(9) },
  ]),
);

// ── pi session (shares acme-web; cwd lives on the `session` line) ───────────
// JSONL like Claude/Codex but tool results are separate `toolResult` records,
// thinking is PLAINTEXT, and the title falls back to the first user message.
const PI_CWD = '/home/dev/acme-web';
const piCwdDir = join(piDir, PI_CWD.replace(/\//g, '-')); // folder name is cosmetic
mkdirSync(piCwdDir, { recursive: true });
const pts = (s) => `2026-06-08T10:00:${String(s).padStart(2, '0')}.000Z`;
const PI_BASH = 'call_pa|fc_pa'; //  composite ids must match on call + result
const PI_EDIT = 'call_pb|fc_pb';
writeFileSync(
  join(piCwdDir, '2026-06-08T10-00-00-000Z_019eca90-pi-acme-demo.jsonl'),
  jsonl([
    { type: 'session', version: 3, id: 'pi-acme-1', timestamp: pts(0), cwd: PI_CWD },
    { type: 'model_change', id: 'mc1', parentId: null, timestamp: pts(0), provider: 'anthropic', modelId: 'claude-sonnet-4-6' },
    { type: 'thinking_level_change', id: 'tl1', parentId: 'mc1', timestamp: pts(0), thinkingLevel: 'high' },
    { type: 'message', id: 'u1', parentId: 'tl1', timestamp: pts(1), message: { role: 'user', content: [{ type: 'text', text: 'Audit the theme CSS for any remaining hard-coded colors and replace them with tokens.' }] } },
    {
      type: 'message',
      id: 'a1',
      parentId: 'u1',
      timestamp: pts(2),
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        provider: 'anthropic',
        // pi keeps PLAINTEXT thinking (the signature stays opaque).
        content: [
          { type: 'thinking', thinking: 'Grep for hex literals, then swap the straggler for a --tv-* token.', thinkingSignature: '{"id":"rs_enc"}' },
          { type: 'toolCall', id: PI_BASH, name: 'bash', arguments: { command: 'grep -rn "#0e" src/styles', timeout: 10 } },
          // pi `edit` → canonical MultiEdit ({file_path, edits:[{old_string,new_string}]}).
          { type: 'toolCall', id: PI_EDIT, name: 'edit', arguments: { path: `${PI_CWD}/src/styles/button.css`, edits: [{ oldText: 'color: #0e1116;', newText: 'color: var(--tv-fg);' }] } },
        ],
        // pi usage: `input` is cache-EXCLUSIVE; cacheRead/cacheWrite separate.
        usage: { input: 3800, output: 540, cacheRead: 22000, cacheWrite: 900, totalTokens: 27240 },
      },
    },
    { type: 'message', id: 'tr1', parentId: 'a1', timestamp: pts(3), message: { role: 'toolResult', toolCallId: PI_BASH, toolName: 'bash', content: [{ type: 'text', text: 'src/styles/button.css:12:  color: #0e1116;' }] } },
    { type: 'message', id: 'tr2', parentId: 'a1', timestamp: pts(3), message: { role: 'toolResult', toolCallId: PI_EDIT, toolName: 'edit', content: [{ type: 'text', text: 'edited button.css (1 replacement)' }] } },
    {
      type: 'message',
      id: 'a2',
      parentId: 'tr2',
      timestamp: pts(4),
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        provider: 'anthropic',
        content: [{ type: 'text', text: 'Replaced the one remaining hard-coded color with the `--tv-fg` token.' }],
        usage: { input: 600, output: 90, cacheRead: 23000, cacheWrite: 0, totalTokens: 23690 },
      },
    },
  ]),
);

// ── opencode session (shares acme-web; SQLite opencode.db) ──────────────────
// The only SQLite-backed source. Column order is load-bearing (positional
// inserts). File edits arrive via apply_patch unified diffs → canonical edits.
mkdirSync(opencodeDir, { recursive: true });
const OC_PATCH = [
  'Index: /home/dev/acme-web/src/styles/global.css',
  '===================================================================',
  '--- /home/dev/acme-web/src/styles/global.css',
  '+++ /home/dev/acme-web/src/styles/global.css',
  '@@ -1,4 +1,5 @@',
  ' :root {',
  '   --tv-bg: #0e1116;',
  '   --tv-fg: #e6edf3;',
  '+  --tv-accent: #4493f8;',
  ' }',
].join('\n');
const ocDb = new DatabaseSync(join(opencodeDir, 'opencode.db'));
ocDb.exec(`
  CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER, parent_id TEXT);
  CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
  CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
`);
const OC_SID = 'ses_acmedemo01'; // ids never contain '#'
const ocT = (s) => Date.UTC(2026, 5, 9, 10, 0, s);
ocDb.prepare('INSERT INTO session VALUES (?,?,?,?,?,NULL)').run(OC_SID, '/home/dev/acme-web', 'Add an accent color token', ocT(0), ocT(9));
const ocMsg = ocDb.prepare('INSERT INTO message VALUES (?,?,?,?,?)');
ocMsg.run('ocu1', OC_SID, ocT(0), ocT(0), JSON.stringify({ role: 'user', time: { created: ocT(0) } }));
ocMsg.run(
  'oca1',
  OC_SID,
  ocT(2),
  ocT(2),
  JSON.stringify({
    role: 'assistant',
    modelID: 'gpt-5.4-mini',
    providerID: 'openai',
    time: { created: ocT(2) },
    // reasoning folds into output at cost time; cache.read/write map across.
    tokens: { total: 25690, input: 5200, output: 430, reasoning: 260, cache: { write: 800, read: 19000 } },
  }),
);
const ocPart = ocDb.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)');
ocPart.run('ocp1', 'ocu1', OC_SID, ocT(0), ocT(0), JSON.stringify({ type: 'text', text: 'Add a --tv-accent token to the palette and use it for links.' }));
// opencode reasoning is PLAINTEXT (renders in full).
ocPart.run('ocp2', 'oca1', OC_SID, ocT(2), ocT(2), JSON.stringify({ type: 'reasoning', text: 'Add the token to :root, typecheck, then re-read the file to confirm.' }));
ocPart.run('ocp3', 'oca1', OC_SID, ocT(3), ocT(3), JSON.stringify({ type: 'text', text: 'Added `--tv-accent`, ran the typecheck, and re-read the file.' }));
// apply_patch with per-file metadata → canonical MultiEdit (Files-changed tab).
ocPart.run(
  'ocp4',
  'oca1',
  OC_SID,
  ocT(4),
  ocT(4),
  JSON.stringify({
    type: 'tool',
    tool: 'apply_patch',
    callID: 'oc_edit',
    state: {
      status: 'completed',
      input: { patchText: '*** Begin Patch\n…\n*** End Patch' },
      output: 'Success. Updated the following files:\nM src/styles/global.css',
      metadata: { files: [{ filePath: '/home/dev/acme-web/src/styles/global.css', relativePath: 'src/styles/global.css', type: 'update', patch: OC_PATCH }] },
    },
  }),
);
ocPart.run(
  'ocp5',
  'oca1',
  OC_SID,
  ocT(5),
  ocT(5),
  JSON.stringify({ type: 'tool', tool: 'bash', callID: 'oc_bash', state: { status: 'completed', input: { command: 'npm run typecheck', description: 'Typecheck after the edit' }, output: 'tsc -b — no errors' } }),
);
// read output is wrapped <path>/<type>/<content>; only the body survives.
ocPart.run(
  'ocp6',
  'oca1',
  OC_SID,
  ocT(6),
  ocT(6),
  JSON.stringify({
    type: 'tool',
    tool: 'read',
    callID: 'oc_read',
    state: {
      status: 'completed',
      input: { filePath: '/home/dev/acme-web/src/styles/global.css', offset: 1, limit: 10 },
      output: '<path>/home/dev/acme-web/src/styles/global.css</path>\n<type>file</type>\n<content>\n1: :root {\n2:   --tv-bg: #0e1116;\n3:   --tv-fg: #e6edf3;\n4:   --tv-accent: #4493f8;\n5: }\n</content>\n\n(End of file - total 5 lines)',
    },
  }),
);
ocDb.close();

// ── GitHub Copilot CLI session (shares acme-web; event-sourced) ─────────────
// Tokens live ONLY in session.shutdown; without it the session costs zero. An
// edit reaches Files-changed only when its tool.execution_complete succeeds.
const CP_UUID = 'cp-acme-uuid-1';
const CP_SID = 'copilot-acme-1';
const CP_CWD = '/home/dev/acme-web';
const CP_MODEL = 'gpt-5-mini';
const cpDir = join(copilotSessionsDir, CP_UUID);
mkdirSync(cpDir, { recursive: true });
let cpN = 0;
const cpTs = (s) => `2026-06-10T10:00:${String(s).padStart(2, '0')}.000Z`;
const cev = (type, data) => ({ type, data, id: `e${cpN}`, timestamp: cpTs(cpN++), parentId: null });
writeFileSync(
  join(cpDir, 'events.jsonl'),
  jsonl([
    cev('session.start', { sessionId: CP_SID, copilotVersion: '1.0.62', context: { cwd: CP_CWD, gitRoot: CP_CWD, branch: 'feat/dark-mode', repository: 'acme/acme-web', hostType: 'github' } }),
    cev('session.model_change', { newModel: CP_MODEL, reasoningEffort: 'medium' }),
    cev('user.message', { content: 'The theme toggle button has no aria-label. Add one and run the tests.' }),
    cev('assistant.message', {
      messageId: 'cm1',
      model: CP_MODEL,
      content: "I'll read the toggle component, add the aria-label, then run the tests.",
      reasoningOpaque: 'ENCRYPTED_REASONING_BLOB', // → empty thinking block (Codex-style)
      toolRequests: [
        { toolCallId: 'cp-read', name: 'view', arguments: { path: join(CP_CWD, 'src/ThemeToggle.tsx'), offset: 1, limit: 30 } },
        { toolCallId: 'cp-edit', name: 'edit', arguments: { path: join(CP_CWD, 'src/ThemeToggle.tsx'), old_str: '<button onClick={onToggle}>', new_str: '<button aria-label="Toggle theme" onClick={onToggle}>' } },
        { toolCallId: 'cp-bash', name: 'bash', arguments: { command: 'npm test -- ThemeToggle', timeout: 60000, description: 'Run the toggle tests' } },
      ],
    }),
    cev('tool.execution_complete', { toolCallId: 'cp-read', toolName: 'view', success: true, result: { content: '   1\texport function ThemeToggle({ onToggle }) {' } }),
    cev('tool.execution_start', { toolCallId: 'cp-edit', toolName: 'edit', arguments: { path: join(CP_CWD, 'src/ThemeToggle.tsx') }, model: CP_MODEL }),
    cev('tool.execution_complete', { toolCallId: 'cp-edit', toolName: 'edit', success: true, result: { content: 'File src/ThemeToggle.tsx updated with changes.' } }),
    cev('tool.execution_complete', { toolCallId: 'cp-bash', toolName: 'bash', success: true, result: { content: 'PASS  src/ThemeToggle.test.tsx (2 passed)' } }),
    cev('session.context_changed', { reason: 'compaction' }), // unknown type, tolerated
    // The ONLY token source. tokenDetails buckets are {tokenCount}; reasoning is
    // already folded into output (OpenAI semantics) — no separate bucket.
    cev('session.shutdown', { tokenDetails: { input: { tokenCount: 5400 }, cache_read: { tokenCount: 16000 }, output: { tokenCount: 620 } }, codeChanges: { linesAdded: 1, linesRemoved: 1, filesModified: [join(CP_CWD, 'src/ThemeToggle.tsx')] } }),
  ]),
);
// workspace.yaml: flat scalars; `name` becomes the session title.
writeFileSync(
  join(cpDir, 'workspace.yaml'),
  `id: ${CP_UUID}\ncwd: ${CP_CWD}\ngit_root: ${CP_CWD}\nrepository: acme/acme-web\nbranch: feat/dark-mode\nname: Add an aria-label to the theme toggle\nuser_named: false\n`,
);


// ── Google Antigravity CLI session (shares acme-web) ────────────────────────
// cwd lives out-of-band in history.jsonl; tokens are never recorded (zero cost).
const AG_ID = 'a1a1a1a1-0000-4000-8000-00000000a001';
const agTs = (s) => `2026-06-11T10:${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}Z`;
const agStep = (i, source, type, extra = {}) => ({ step_index: i, source, type, status: 'DONE', created_at: agTs(i * 9), ...extra });
const agLogs = join(antigravityCliDir, 'brain', AG_ID, '.system_generated', 'logs');
mkdirSync(agLogs, { recursive: true });
writeFileSync(
  join(agLogs, 'transcript_full.jsonl'),
  jsonl([
    agStep(0, 'USER_EXPLICIT', 'USER_INPUT', {
      content:
        '<USER_REQUEST>\nAdd a loading skeleton to the settings page\n</USER_REQUEST>\n' +
        '<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Gemini 3.5 Flash (Medium).\n</USER_SETTINGS_CHANGE>',
    }),
    agStep(1, 'MODEL', 'PLANNER_RESPONSE', {
      thinking: 'A skeleton component keeps the layout stable while settings load.',
      content: "I'll create a `SettingsSkeleton` component and render it while the query is pending.",
      tool_calls: [
        { name: 'write_to_file', args: { TargetFile: '/home/dev/acme-web/src/SettingsSkeleton.tsx', CodeContent: 'export function SettingsSkeleton() {\n  return <div className="skeleton" aria-busy="true" />;\n}\n', Overwrite: true } },
      ],
    }),
    agStep(2, 'MODEL', 'CODE_ACTION', { content: 'Created file file:///home/dev/acme-web/src/SettingsSkeleton.tsx with requested content.' }),
    agStep(3, 'MODEL', 'PLANNER_RESPONSE', { content: 'Added `SettingsSkeleton`; the settings page now shows it while loading.' }),
  ]),
);
writeFileSync(
  join(antigravityCliDir, 'history.jsonl'),
  jsonl([{ display: 'skeleton', timestamp: 1, workspace: '/home/dev/acme-web', conversationId: AG_ID }]),
);
mkdirSync(join(geminiHome, 'config', 'agents'), { recursive: true });
writeFileSync(
  join(geminiHome, 'config', 'agents', 'AGENTS.md'),
  '# Global rules\n\n- Keep changes small and focused.\n- Prefer existing components over new ones.\n',
);
mkdirSync(join(geminiHome, 'antigravity'), { recursive: true });

// ── xAI Grok CLI session (shares acme-web) ──────────────────────────────────
// Facts are split across chat_history.jsonl (spine), updates.jsonl (timestamps +
// per-turn usage) and summary.json (cwd, title).
const GK_ID = 'grok-acme-0001';
const gkDir = join(grokDir, encodeURIComponent('/home/dev/acme-web'), GK_ID);
mkdirSync(gkDir, { recursive: true });
const GK_BASE = Date.parse('2026-06-12T10:00:00.000Z');
const gkUpdate = (ms, update) => ({
  timestamp: Math.floor(ms / 1000),
  method: 'session/update',
  params: { sessionId: GK_ID, update, _meta: { eventId: `e-${ms}`, agentTimestampMs: ms } },
});
writeFileSync(
  join(gkDir, 'summary.json'),
  JSON.stringify({
    info: { id: GK_ID, cwd: '/home/dev/acme-web' },
    created_at: new Date(GK_BASE).toISOString(),
    updated_at: new Date(GK_BASE + 90_000).toISOString(),
    current_model_id: 'grok-4.5',
    generated_title: 'Memoize the project list selector',
  }),
);
writeFileSync(
  join(gkDir, 'chat_history.jsonl'),
  jsonl([
    { type: 'user', prompt_index: 0, content: [{ type: 'text', text: '<user_query>\nThe project list re-renders on every keystroke. Memoize the selector.\n</user_query>' }] },
    {
      type: 'assistant',
      content: "I'll wrap the selector in `createSelector` so it only recomputes when the projects change.",
      model_id: 'grok-4.5',
      tool_calls: [
        { id: 'gk-edit', name: 'search_replace', arguments: JSON.stringify({ file_path: '/home/dev/acme-web/src/selectors.ts', old_string: 'export const selectProjects = (s) => s.projects.filter(Boolean);', new_string: 'export const selectProjects = createSelector([(s) => s.projects], (p) => p.filter(Boolean));' }) },
      ],
    },
    { type: 'tool_result', tool_call_id: 'gk-edit', content: 'The file src/selectors.ts has been edited' },
    { type: 'assistant', content: 'Done. The selector is memoized and the list no longer re-renders while typing.', model_id: 'grok-4.5' },
  ]),
);
writeFileSync(
  join(gkDir, 'updates.jsonl'),
  jsonl([
    gkUpdate(GK_BASE + 1000, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Memoize the selector' }, _meta: { promptIndex: 0 } }),
    gkUpdate(GK_BASE + 20_000, { sessionUpdate: 'tool_call', toolCallId: 'gk-edit', title: 'search_replace' }),
    gkUpdate(GK_BASE + 60_000, {
      sessionUpdate: 'turn_completed',
      prompt_id: 'p-1',
      stop_reason: 'end_turn',
      usage: { inputTokens: 9800, outputTokens: 640, totalTokens: 10440, cachedReadTokens: 6000, reasoningTokens: 120, modelCalls: 2 },
    }),
  ]),
);


// ── Session that edits several files (Files-changed tab) ────────────────────
const F = { cwd: '/home/dev/acme-web', gitBranch: 'feat/dark-mode' };
const TOKENS_TS = `export const lightTokens = {
  bg: '#ffffff',
  fg: '#111111',
  accent: '#2563eb',
};

export const darkTokens = {
  bg: '#0e1116',
  fg: '#e6e8eb',
  accent: '#60a5fa',
};
`;
const TOGGLE_OLD = `export function ThemeToggle({ onToggle }) {
  return <button onClick={onToggle}>Toggle</button>;
}`;
const TOGGLE_NEW = `export function ThemeToggle({ theme, onToggle }) {
  return (
    <button aria-label="Toggle theme" aria-pressed={theme === 'dark'} onClick={onToggle}>
      {theme === 'dark' ? 'Light' : 'Dark'}
    </button>
  );
}`;
const CSS_OLD = `:root {
  --tv-bg: #ffffff;
  --tv-fg: #111111;
}`;
const CSS_NEW = `:root {
  --tv-bg: #ffffff;
  --tv-fg: #111111;
  --tv-accent: #2563eb;
}

:root[data-theme='dark'] {
  --tv-bg: #0e1116;
  --tv-fg: #e6e8eb;
  --tv-accent: #60a5fa;
}`;
write('home-dev-acme-web/sess-files.jsonl', [
  { type: 'ai-title', sessionId: 'sess-files', aiTitle: 'Extract theme tokens into a shared module' },
  user('sess-files', '2026-06-13T09:30:00.000Z', 'Pull the hard-coded theme colors into a shared tokens module, wire it into the toggle and the stylesheet, and add the dark palette.', F),
  asst('sess-files', '2026-06-13T09:30:10.000Z', [
    { type: 'text', text: "I'll create a tokens module, export both palettes, then update the toggle and the CSS variables." },
    { type: 'tool_use', id: 'f-write', name: 'Write', input: { file_path: 'src/theme/tokens.ts', content: TOKENS_TS } },
    { type: 'tool_use', id: 'f-index', name: 'Write', input: { file_path: 'src/theme/index.ts', content: "export * from './tokens';\n" } },
  ], OPUS, usage(2000, 520, 96000, 10000), F),
  user('sess-files', '2026-06-13T09:30:30.000Z', [
    { type: 'tool_result', tool_use_id: 'f-write', content: 'File created successfully at: src/theme/tokens.ts' },
    { type: 'tool_result', tool_use_id: 'f-index', content: 'File created successfully at: src/theme/index.ts' },
  ], F),
  asst('sess-files', '2026-06-13T09:30:50.000Z', [
    { type: 'text', text: 'Now the toggle component and the stylesheet.' },
    { type: 'tool_use', id: 'f-toggle', name: 'Edit', input: { file_path: 'src/ThemeToggle.tsx', old_string: TOGGLE_OLD, new_string: TOGGLE_NEW } },
    { type: 'tool_use', id: 'f-css', name: 'Edit', input: { file_path: 'src/styles/global.css', old_string: CSS_OLD, new_string: CSS_NEW } },
    { type: 'tool_use', id: 'f-settings', name: 'Edit', input: { file_path: 'src/settings.tsx', old_string: '<ThemeToggle theme={theme} onToggle={toggle} />', new_string: '<ThemeToggle theme={theme} onToggle={toggle} />\n      <p className="hint">Your choice is saved on this device.</p>' } },
  ], OPUS, usage(900, 640, 108000, 4200), F),
  user('sess-files', '2026-06-13T09:31:15.000Z', [
    { type: 'tool_result', tool_use_id: 'f-toggle', content: 'The file src/ThemeToggle.tsx has been updated.' },
    { type: 'tool_result', tool_use_id: 'f-css', content: 'The file src/styles/global.css has been updated.' },
    { type: 'tool_result', tool_use_id: 'f-settings', content: 'The file src/settings.tsx has been updated.' },
  ], F),
  asst('sess-files', '2026-06-13T09:31:40.000Z', [
    { type: 'text', text: 'Committing the change.' },
    { type: 'tool_use', id: 'f-skill', name: 'Skill', input: { skill: 'commit' } },
  ], OPUS, usage(600, 120, 115000, 1500), F),
  user('sess-files', '2026-06-13T09:31:45.000Z', [{ type: 'tool_result', tool_use_id: 'f-skill', content: 'Launching skill: commit' }], F),
  asst('sess-files', '2026-06-13T09:32:05.000Z', [
    { type: 'text', text: '**Done.** The palettes live in `src/theme/tokens.ts`, the toggle is accessible, and the stylesheet defines both themes.' },
  ], OPUS, usage(500, 130, 117000, 900), F),
]);

// Skill and subagent invocations spread over a few sessions so the Extensions
// usage counts are non-zero. A Skill call's `input.skill` is what is counted.
const skillCall = (id, skill) => ({ type: 'tool_use', id, name: 'Skill', input: { skill } });
const agentCall = (id, description, subagentType) => ({
  type: 'tool_use',
  id,
  name: 'Agent',
  input: { description, subagent_type: subagentType, prompt: description },
});
const sk = { cwd: '/home/dev/acme-web', gitBranch: 'main' };
for (const [sid, day, title, skills, agents] of [
  ['sess-skills-a', '2026-06-14', 'Review and merge the pricing PRs', ['review-pr', 'review-pr', 'commit'], ['code-reviewer']],
  ['sess-skills-b', '2026-06-15', 'Cover the cart reducer with tests', ['write-tests', 'write-tests', 'commit'], ['test-writer', 'code-reviewer']],
  ['sess-skills-c', '2026-06-16', 'Cut the 1.4 release', ['acme-toolkit:release-notes', 'commit'], []],
]) {
  const events = [
    { type: 'ai-title', sessionId: sid, aiTitle: title },
    user(sid, `${day}T10:00:00.000Z`, title, sk),
  ];
  let t = 10;
  for (const [i, name] of skills.entries()) {
    events.push(
      asst(sid, `${day}T10:00:${t}.000Z`, [{ type: 'text', text: `Loading the ${name} skill.` }, skillCall(`${sid}-s${i}`, name)], SONNET, usage(900, 120, 70000, 2000), sk),
      user(sid, `${day}T10:00:${t + 5}.000Z`, [{ type: 'tool_result', tool_use_id: `${sid}-s${i}`, content: `Launching skill: ${name}` }], sk),
    );
    t += 10;
  }
  for (const [i, type] of agents.entries()) {
    events.push(
      asst(sid, `${day}T10:01:${10 + i * 10}.000Z`, [{ type: 'text', text: 'Delegating a focused pass.' }, agentCall(`${sid}-a${i}`, `Run the ${type} pass`, type)], SONNET, usage(800, 100, 72000, 1000), sk),
      user(sid, `${day}T10:01:${15 + i * 10}.000Z`, [{ type: 'tool_result', tool_use_id: `${sid}-a${i}`, content: 'Pass complete; no blocking findings.' }], sk),
    );
  }
  events.push(asst(sid, `${day}T10:03:00.000Z`, [{ type: 'text', text: 'All done.' }], SONNET, usage(500, 90, 74000, 600), sk));
  write(`home-dev-acme-web/${sid}.jsonl`, events);
}

// ── Extensions: skills, subagents, MCP servers, hooks, plugins ──────────────
// Read LIVE from each agent home (never indexed). Every value is a placeholder;
// env/header values are reduced to their NAMES by the server anyway.
const put = (file, body) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
};
const skillMd = (name, description) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${description}\n`;
const agentMd = (name, description, model) =>
  `---\nname: ${name}\ndescription: ${description}\nmodel: ${model}\n---\n\nYou are the ${name} agent. ${description}\n`;

// Claude Code.
for (const [name, description] of [
  ['commit', 'Write a Conventional Commits message from the staged diff and commit.'],
  ['review-pr', 'Review a pull request for bugs, missing tests, and style drift.'],
  ['write-tests', 'Add focused tests for the code that just changed.'],
  ['db-migrations', 'Write reversible SQL migrations and check them against the schema.'],
]) {
  put(join(claudeHome, 'skills', name, 'SKILL.md'), skillMd(name, description));
}
put(join(claudeHome, 'agents', 'code-reviewer.md'), agentMd('code-reviewer', 'Reviews a diff for correctness and maintainability.', 'sonnet'));
put(join(claudeHome, 'agents', 'test-writer.md'), agentMd('test-writer', 'Writes and updates tests for changed code.', 'sonnet'));
put(join(claudeHome, '.claude.json'), {
  mcpServers: {
    github: { type: 'http', url: 'https://mcp.example.com/github', headers: { Authorization: 'Bearer EXAMPLE_TOKEN' } },
    filesystem: { type: 'stdio', command: 'npx', args: ['-y', '@example/mcp-filesystem', '/home/dev/acme-web'] },
    playwright: { type: 'stdio', command: 'npx', args: ['@example/mcp-browser@latest'] },
  },
  projects: {
    '/home/dev/acme-web': {
      mcpServers: {
        postgres: { type: 'stdio', command: 'npx', args: ['-y', '@example/mcp-postgres'], env: { DATABASE_URL: 'example', PGSSLMODE: 'example' } },
      },
    },
  },
});
const pluginsRoot = join(claudeHome, 'plugins');
const installs = {};
for (const [name, version, description, enabled] of [
  ['acme-toolkit', '1.4.0', 'Release tooling for the Acme repos: notes, changelog, and a release manager agent.', true],
  ['docs-helper', '0.9.2', 'Keeps README and API docs in step with the code.', true],
  ['legacy-lint', '0.3.0', 'Old lint rules, kept installed but switched off.', false],
]) {
  const root = join(pluginsRoot, 'cache', 'acme-marketplace', name, version);
  put(join(root, '.claude-plugin', 'plugin.json'), { name, version, description });
  installs[`${name}@acme-marketplace`] = [{ scope: 'user', installPath: root, version }];
  if (name === 'acme-toolkit') {
    put(join(root, 'skills', 'release-notes', 'SKILL.md'), skillMd('release-notes', 'Draft release notes from merged pull requests since the last tag.'));
    put(join(root, 'skills', 'changelog', 'SKILL.md'), skillMd('changelog', 'Update CHANGELOG.md in Keep a Changelog format.'));
    put(join(root, 'agents', 'release-manager.md'), agentMd('release-manager', 'Coordinates a release: version bump, notes, and tag.', 'opus'));
    put(join(root, '.mcp.json'), { mcpServers: { releases: { type: 'http', url: 'https://mcp.example.com/releases' } } });
    put(join(root, 'hooks', 'hooks.json'), { hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo release-audit', timeout: 10 }] }] } });
  }
  if (name === 'docs-helper') {
    put(join(root, 'skills', 'sync-docs', 'SKILL.md'), skillMd('sync-docs', 'Update docs affected by a code change.'));
  }
}
put(join(pluginsRoot, 'installed_plugins.json'), { version: 2, plugins: installs });
put(join(claudeHome, 'settings.json'), {
  enabledPlugins: { 'acme-toolkit@acme-marketplace': true, 'docs-helper@acme-marketplace': true, 'legacy-lint@acme-marketplace': false },
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './.claude/hooks/block-force-push.sh', timeout: 5 }] }],
    PostToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'npx prettier --write "$CLAUDE_FILE_PATHS"', timeout: 30 }] }],
    SessionStart: [{ hooks: [{ type: 'command', command: 'git status --short' }] }],
    Stop: [{ hooks: [{ type: 'command', command: './scripts/notify-done.sh' }] }],
  },
});

// Codex (the shared ~/.agents/skills dir sits beside the codex home).
for (const [name, description] of [
  ['db-migrations', 'Write reversible SQL migrations and check them against the schema.'],
  ['terraform-style', 'Format and structure Terraform modules the way the team does.'],
]) {
  put(join(codexHome, 'skills', name, 'SKILL.md'), skillMd(name, description));
}
put(join(baseDir, '.agents', 'skills', 'incident-notes', 'SKILL.md'), skillMd('incident-notes', 'Capture a timeline and follow-ups during an incident.'));
put(
  join(codexHome, 'config.toml'),
  `[mcp_servers.postgres]
command = "npx"
args = ["-y", "@example/mcp-postgres"]
env = { DATABASE_URL = "example" }

[mcp_servers.docs]
url = "https://mcp.example.com/docs"
bearer_token_env_var = "EXAMPLE_DOCS_TOKEN"
`,
);
put(join(codexHome, 'hooks.json'), { hooks: { PreToolUse: [{ matcher: 'shell', hooks: [{ type: 'command', command: './scripts/audit-shell.sh', timeout: 10 }] }] } });
put(
  join(codexHome, 'agents', 'migration-reviewer.toml'),
  `name = "migration-reviewer"\ndescription = "Reviews SQL migrations for reversibility and lock risk."\nmodel = "gpt-5.5"\ndeveloper_instructions = "Review the migration."\n`,
);
{
  const root = join(codexHome, 'plugins', 'cache', 'acme-marketplace', 'acme-toolkit', '1.4.0');
  put(join(root, '.codex-plugin', 'plugin.json'), { name: 'acme-toolkit', version: '1.4.0', description: 'Release tooling for the Acme repos.' });
  put(join(root, 'skills', 'release-notes', 'SKILL.md'), skillMd('release-notes', 'Draft release notes from merged pull requests since the last tag.'));
}

// Everything above is historical: age every seeded file so only the sessions
// seeded by seedLive() fall inside the Live tab's activity window.
const OLD = new Date('2026-06-17T12:00:00.000Z');
(function ageAll(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) ageAll(full);
    utimesSync(full, OLD, OLD);
  }
})(baseDir);

seedLive(baseDir);

console.log(
  `Demo data written under ${baseDir}:\n` +
    `  Claude   → ${outDir} (${bn} bulk + detailed, files, skill and live sessions) + global/project memory\n` +
    `  Codex    → ${codexDir} (4 sessions) + AGENTS.md\n` +
    `  Junie    → ${junieDir} (1 session) + AGENTS.md\n` +
    `  pi       → ${piDir} (1 session)\n` +
    `  opencode → ${opencodeDir}/opencode.db (1 session)\n` +
    `  Copilot  → ${copilotSessionsDir} (1 session) + copilot-instructions.md\n` +
    `  Antigravity → ${antigravityCliDir} (1 session) + AGENTS.md\n` +
    `  Grok     → ${grokDir} (1 session)\n` +
    `  acme-web is shared by all eight agents.`,
);
