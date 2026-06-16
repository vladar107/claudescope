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
 *
 * Run the app against it (all six sources; memory homes derive from the dirs):
 *   base=.demo \
 *   CLAUDE_PROJECTS_DIR=$base/claude/projects CODEX_SESSIONS_DIR=$base/codex/sessions \
 *   JUNIE_SESSIONS_DIR=$base/junie/sessions PI_SESSIONS_DIR=$base/pi/sessions \
 *   OPENCODE_DATA_DIR=$base/opencode COPILOT_SESSIONS_DIR=$base/copilot/session-state \
 *   npm start
 *
 * `acme-web` is deliberately shared by ALL SIX agents (same cwd) so its project
 * card shows every agent tag and the agent filter; the other projects are
 * single-agent. The per-source layout below is kept IN SYNC with
 * scripts/screenshots.mjs, which seeds into a temp <base> and sets these vars.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

// Wipe prior output (each agent's whole home) so reseeding is deterministic.
for (const dir of [claudeHome, codexHome, junieHome, join(baseDir, 'pi'), opencodeDir, copilotHome]) {
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
  CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);
  CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
  CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
`);
const OC_SID = 'ses_acmedemo01'; // ids never contain '#'
const ocT = (s) => Date.UTC(2026, 5, 9, 10, 0, s);
ocDb.prepare('INSERT INTO session VALUES (?,?,?,?,?)').run(OC_SID, '/home/dev/acme-web', 'Add an accent color token', ocT(0), ocT(9));
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

console.log(
  `Demo data written under ${baseDir}:\n` +
    `  Claude   → ${outDir} (${bn} bulk + 3 detailed sessions) + global/project memory\n` +
    `  Codex    → ${codexDir} (4 sessions) + AGENTS.md\n` +
    `  Junie    → ${junieDir} (1 session) + AGENTS.md\n` +
    `  pi       → ${piDir} (1 session)\n` +
    `  opencode → ${opencodeDir}/opencode.db (1 session)\n` +
    `  Copilot  → ${copilotSessionsDir} (1 session) + copilot-instructions.md\n` +
    `  acme-web is shared by all six agents.`,
);
