#!/usr/bin/env node
/**
 * Write a synthetic ~/.claude/projects-style dataset for screenshots/demos.
 * All names, paths, and content are fabricated — nothing sensitive. Point the
 * app at it with CLAUDE_PROJECTS_DIR.
 *
 *   node scripts/demo-seed.mjs [targetDir]   # default: ./.demo/projects
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = process.argv[2] ?? join(root, '.demo', 'projects');
rmSync(outDir, { recursive: true, force: true });

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

console.log(`Demo data written to ${outDir} (${bn} bulk + 3 detailed sessions)`);
