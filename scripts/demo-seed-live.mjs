#!/usr/bin/env node
/**
 * Seed the sessions that must look "live": their transcripts and file mtimes
 * are written relative to NOW, because the Live tab infers state from the
 * transcript tail and the file mtime (not from any process). All fabricated,
 * all in the shared `acme-web` project:
 *
 *   live-agents   Claude Code  idle      a finished run with nested subagents and
 *                                        messages between agents (agent tree view)
 *   live-working  Claude Code  working   open Bash call + a running subagent
 *   codex-working Codex        working   open shell call, writing right now
 *   codex-stuck   Codex        stuck     open call, silent past the 3 min threshold
 *   codex-idle    Codex        idle      last turn ended in text
 *
 *   node scripts/demo-seed-live.mjs [baseDir]   # re-run any time to refresh "now"
 *
 * `demo-seed.mjs` calls {@link seedLive} once; `screenshots.mjs` calls it again
 * right before the Live captures so the states hold however long the run took.
 * Rewrites only its own files, never wipes anything.
 */

import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LIVE_SESSION_IDS = {
  agents: 'live-agents',
  working: 'live-working',
};

const OPUS = 'claude-opus-4-8';
const SONNET = 'claude-sonnet-4-6';
const HAIKU = 'claude-haiku-4-5-20251001';
const CWD = '/home/dev/acme-web';

const usage = (input, output, read, write_) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write_,
});

export function seedLive(baseDir, nowMs = Date.now()) {
  const claudeProj = join(baseDir, 'claude', 'projects', 'home-dev-acme-web');
  const codexSessions = join(baseDir, 'codex', 'sessions');
  let n = 0;
  const uid = (p) => `${p}-${String(++n).padStart(4, '0')}`;
  /** Seconds before now → ISO timestamp. */
  const ts = (secAgo) => new Date(nowMs - secAgo * 1000).toISOString();

  const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const put = (file, rows) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, typeof rows === 'string' ? rows : jsonl(rows));
  };
  const touch = (files, secAgo) => {
    const t = new Date(nowMs - secAgo * 1000);
    for (const f of files) utimesSync(f, t, t);
  };

  // ── Claude helpers ────────────────────────────────────────────────────────
  const row = (type, sid, secAgo, message, extra = {}) => ({
    type,
    sessionId: sid,
    uuid: uid(type === 'user' ? 'u' : 'a'),
    parentUuid: null,
    cwd: CWD,
    gitBranch: extra.gitBranch ?? 'main',
    timestamp: ts(secAgo),
    isSidechain: extra.agentId !== undefined,
    ...(extra.agentId ? { agentId: extra.agentId } : {}),
    message,
  });
  const user = (sid, secAgo, content, extra) => row('user', sid, secAgo, { role: 'user', content }, extra);
  const asst = (sid, secAgo, content, model, u, extra) =>
    row('assistant', sid, secAgo, { role: 'assistant', model, content, usage: u }, extra);
  const result = (id, content) => [{ type: 'tool_result', tool_use_id: id, content }];
  const text = (t) => ({ type: 'text', text: t });
  const call = (id, name, input) => ({ type: 'tool_use', id, name, input });

  function claudeSession(sid, title, mainRows, subagents) {
    const main = join(claudeProj, `${sid}.jsonl`);
    const files = [main];
    put(main, [{ type: 'ai-title', sessionId: sid, aiTitle: title }, ...mainRows]);
    for (const s of subagents) {
      const f = join(claudeProj, sid, 'subagents', `agent-${s.id}.jsonl`);
      const m = join(claudeProj, sid, 'subagents', `agent-${s.id}.meta.json`);
      put(f, s.rows);
      put(m, JSON.stringify(s.meta));
      files.push(f, m);
    }
    return files;
  }

  // ── live-agents: idle, nested subagents + inter-agent messages ───────────
  {
    const sid = LIVE_SESSION_IDS.agents;
    const br = 'feat/dark-mode';
    const m = { gitBranch: br };
    const sub = (id) => ({ agentId: id, gitBranch: br });
    const main = [
      user(sid, 560, 'Get the dark-mode work ready to release: audit the theme code, update the tests, and draft release notes. Use subagents for the parallel parts.', m),
      asst(sid, 550, [
        text("I'll audit the theme code and update the tests in parallel."),
        call('tu-audit', 'Agent', { description: 'Audit theme usage', subagent_type: 'Explore', prompt: 'Find every place the theme is read or written and report what needs to change before release.' }),
        call('tu-tests', 'Agent', { description: 'Update theme tests', subagent_type: 'test-writer', prompt: 'Update the settings and toggle tests for dark mode.', run_in_background: true }),
      ], OPUS, usage(1900, 420, 98000, 11000), m),
      user(sid, 549, result('tu-tests', 'Async agent launched successfully. agentId: tests1'), m),
      user(sid, 470, result('tu-audit', 'Theme is read in 4 places. ThemeContext is the single writer; two components still hard-code light colors (Banner, Footer).'), m),
      asst(sid, 462, [
        text('The tests agent is still running. One more requirement for it:'),
        call('tu-msg', 'SendMessage', { to: 'tests1', message: 'Also cover the system-preference default when no choice is stored.' }),
      ], OPUS, usage(800, 210, 112000, 3000), m),
      user(sid, 461, result('tu-msg', 'Message queued for tests1.'), m),
      user(sid, 292, '<task-notification><task-id>tests1</task-id><status>completed</status><summary>Updated 6 tests; all 14 pass.</summary></task-notification>', m),
      user(sid, 291, '<agent-message from="tests1">[Subagent hand-back] Updated 6 tests, added the system-preference case. All 14 tests pass.</agent-message>', m),
      asst(sid, 280, [
        text('Both are done. Drafting the release notes from the changes.'),
        call('tu-skill', 'Skill', { skill: 'acme-toolkit:release-notes' }),
      ], OPUS, usage(700, 160, 118000, 2500), m),
      user(sid, 279, result('tu-skill', 'Launching skill: acme-toolkit:release-notes'), m),
      asst(sid, 110, [
        text('**Ready to release.** Audit found two hard-coded components (fixed), tests cover the system-preference default, and the release notes are drafted in `RELEASE_NOTES.md`.'),
      ], OPUS, usage(600, 190, 121000, 1800), m),
    ];
    const audit = [
      user(sid, 545, 'Find every place the theme is read or written and report what needs to change before release.', sub('audit1')),
      asst(sid, 538, [text('Searching for theme reads and writes.'), call('sa-grep', 'Grep', { pattern: 'useTheme|ThemeContext' })], HAIKU, usage(400, 70, 30000, 1500), sub('audit1')),
      user(sid, 530, result('sa-grep', 'src/theme/ThemeContext.tsx\nsrc/settings.tsx\nsrc/Banner.tsx\nsrc/Footer.tsx'), sub('audit1')),
      asst(sid, 524, [
        text('Two components import colors directly. Delegating a closer look at the CSS variables.'),
        call('sa-css', 'Agent', { description: 'Check CSS variables', subagent_type: 'Explore', prompt: 'List which CSS custom properties Banner and Footer ignore.' }),
      ], HAIKU, usage(300, 90, 31000, 500), sub('audit1')),
      user(sid, 478, result('sa-css', 'Banner and Footer use #ffffff and #111111 directly instead of --tv-bg and --tv-fg.'), sub('audit1')),
      asst(sid, 474, [text('Theme is read in 4 places. ThemeContext is the single writer; Banner and Footer hard-code light colors and need the --tv-* variables.')], HAIKU, usage(400, 120, 32000, 0), sub('audit1')),
    ];
    const css = [
      user(sid, 520, 'List which CSS custom properties Banner and Footer ignore.', sub('css1')),
      asst(sid, 505, [text('Reading both components.'), call('sc-read', 'Read', { file_path: 'src/Banner.tsx' })], HAIKU, usage(300, 50, 20000, 800), sub('css1')),
      user(sid, 498, result('sc-read', '     1\texport const Banner = () => <div style={{ background: "#ffffff", color: "#111111" }} />'), sub('css1')),
      asst(sid, 482, [text('Banner and Footer use #ffffff and #111111 directly instead of --tv-bg and --tv-fg.')], HAIKU, usage(350, 80, 21000, 0), sub('css1')),
    ];
    const tests = [
      user(sid, 548, 'Update the settings and toggle tests for dark mode.', sub('tests1')),
      asst(sid, 540, [text('Running the current settings tests first.'), call('st-bash', 'Bash', { command: 'npm test -- settings', description: 'Run the settings tests' })], SONNET, usage(900, 110, 60000, 2000), sub('tests1')),
      user(sid, 520, result('st-bash', 'Tests: 8 passed, 8 total'), sub('tests1')),
      asst(sid, 440, [
        text('Adding the dark-mode cases.'),
        call('st-edit', 'Edit', { file_path: 'src/settings.test.tsx', old_string: "it('renders a theme toggle'", new_string: "it('defaults to the system preference', () => {})\n  it('renders a theme toggle'" }),
      ], SONNET, usage(700, 260, 64000, 1500), sub('tests1')),
      user(sid, 436, result('st-edit', 'The file src/settings.test.tsx has been updated.'), sub('tests1')),
      asst(sid, 300, [text('Updated 6 tests and added the system-preference case. All 14 tests pass.')], SONNET, usage(500, 140, 66000, 0), sub('tests1')),
    ];
    const files = claudeSession(sid, 'Prepare the dark-mode release', main, [
      { id: 'audit1', rows: audit, meta: { agentType: 'Explore', description: 'Audit theme usage', toolUseId: 'tu-audit', spawnDepth: 1, model: 'haiku' } },
      { id: 'css1', rows: css, meta: { agentType: 'Explore', description: 'Check CSS variables', toolUseId: 'sa-css', parentAgentId: 'audit1', spawnDepth: 2, model: 'haiku' } },
      { id: 'tests1', rows: tests, meta: { agentType: 'test-writer', description: 'Update theme tests', toolUseId: 'tu-tests', spawnDepth: 1, model: 'sonnet' } },
    ]);
    touch(files, 110);
  }

  // ── live-working: open Bash call + a running subagent ────────────────────
  {
    const sid = LIVE_SESSION_IDS.working;
    const br = 'feat/form-components';
    const m = { gitBranch: br };
    const sub = (id) => ({ agentId: id, gitBranch: br });
    const main = [
      user(sid, 240, 'Migrate the settings page to the new form components and keep the typecheck green.', m),
      asst(sid, 232, [
        text("I'll swap the inputs for the shared form components, and have a subagent clear the lint errors meanwhile."),
        call('tu-lint', 'Agent', { description: 'Fix lint errors in components', subagent_type: 'general-purpose', prompt: 'Fix the ESLint errors under src/components without changing behavior.', run_in_background: true }),
        call('tu-edit', 'Edit', { file_path: 'src/settings.tsx', old_string: '<input type="checkbox" />', new_string: '<Checkbox label="Compact mode" />' }),
      ], OPUS, usage(2100, 380, 96000, 9000), m),
      user(sid, 231, [...result('tu-lint', 'Async agent launched successfully. agentId: lint1'), ...result('tu-edit', 'The file src/settings.tsx has been updated.')], m),
      asst(sid, 120, [
        text('Inputs are migrated. Checking the types.'),
        call('tu-bash0', 'Bash', { command: 'npm run lint -- --max-warnings 0', description: 'Lint the project' }),
      ], OPUS, usage(900, 190, 110000, 4000), m),
      user(sid, 70, result('tu-bash0', 'src/components/Select.tsx: 2 errors remaining'), m),
      asst(sid, 22, [
        text('Two lint errors remain in `Select`, owned by the lint subagent. Running the typecheck now.'),
        call('tu-bash', 'Bash', { command: 'npm run typecheck', description: 'Typecheck the workspace' }),
      ], OPUS, usage(700, 150, 121000, 2200), m),
    ];
    const lint = [
      user(sid, 228, 'Fix the ESLint errors under src/components without changing behavior.', sub('lint1')),
      asst(sid, 215, [text('Listing the failing files.'), call('sl-bash', 'Bash', { command: 'npx eslint src/components --format unix' })], HAIKU, usage(500, 60, 28000, 1200), sub('lint1')),
      user(sid, 205, result('sl-bash', 'src/components/Select.tsx:14:7: unused variable "idx"\nsrc/components/Select.tsx:31:3: missing dependency in effect'), sub('lint1')),
      asst(sid, 40, [text('Fixing the two errors in Select.'), call('sl-edit', 'Edit', { file_path: 'src/components/Select.tsx', old_string: 'const idx = 0;\n', new_string: '' })], HAIKU, usage(450, 80, 30000, 600), sub('lint1')),
      user(sid, 30, result('sl-edit', 'The file src/components/Select.tsx has been updated.'), sub('lint1')),
      asst(sid, 11, [text('Now the effect dependency.'), call('sl-edit2', 'Edit', { file_path: 'src/components/Select.tsx', old_string: '}, []);', new_string: '}, [options]);' })], HAIKU, usage(400, 70, 31000, 0), sub('lint1')),
    ];
    const files = claudeSession(sid, 'Migrate settings to form components', main, [
      { id: 'lint1', rows: lint, meta: { agentType: 'general-purpose', description: 'Fix lint errors in components', toolUseId: 'tu-lint', spawnDepth: 1, model: 'haiku' } },
    ]);
    touch(files, 11);
  }

  // ── Codex helpers ─────────────────────────────────────────────────────────
  const cx = (type, payload, secAgo) => ({ type, payload, timestamp: ts(secAgo) });
  const cxUser = (t, s) => cx('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: t }] }, s);
  const cxAsst = (t, s) => cx('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: t }] }, s);
  const cxCall = (name, args, id, s) => cx('response_item', { type: 'function_call', name, arguments: JSON.stringify(args), call_id: id }, s);
  const cxOut = (id, output, s) => cx('response_item', { type: 'function_call_output', call_id: id, output }, s);
  const cxTok = (input, cached, output, s) =>
    cx('event_msg', {
      type: 'token_count',
      info: { last_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output } },
      rate_limits: {},
    }, s);
  function codexSession(id, startSecAgo, title, rows, lastWriteSecAgo) {
    // A fixed path per session: re-seeding must overwrite, never add a second file.
    const file = join(codexSessions, '2026', '06', '18', `rollout-2026-06-18T12-00-00-019ec000-0000-7000-a000-0000${id}.jsonl`);
    put(file, [
      cx('session_meta', { id: `codex-${id}`, cwd: CWD, cli_version: '0.122.0', model_provider: 'openai', git: { branch: 'main' } }, startSecAgo),
      cx('turn_context', { model: 'gpt-5.5', cwd: CWD }, startSecAgo - 1),
      cxUser(title, startSecAgo - 2),
      ...rows,
    ]);
    touch([file], lastWriteSecAgo);
  }

  codexSession('0000c001', 200, 'Add an index on projects.owner_id and make the migration reversible.', [
    cxAsst("I'll write the migration and run it against the dev database.", 190),
    cxTok(12000, 8000, 700, 189),
    cxCall('apply_patch', { path: 'db/migrations/0042_projects_owner_idx.sql' }, 'cw1', 150),
    cxOut('cw1', 'db/migrations/0042_projects_owner_idx.sql created (14 lines)', 146),
    cxAsst('Migration written. Running it and the integration tests.', 100),
    cxTok(4200, 3000, 380, 99),
    cxCall('shell', { command: 'npm run test:integration -- migrations' }, 'cw2', 35),
  ], 35);

  codexSession('0000c002', 560, 'Reinstall the workspace dependencies from a clean lockfile.', [
    cxAsst('Clearing node_modules and reinstalling from the lockfile.', 550),
    cxTok(6000, 4200, 420, 549),
    cxCall('shell', { command: 'pnpm install --force --frozen-lockfile' }, 'cs1', 400),
  ], 400);

  codexSession('0000c003', 330, 'Explain how the settings store is wired up.', [
    cxAsst('Let me look at the store module and the loader skill first.', 322),
    cxTok(5200, 3600, 330, 321),
    cxCall('shell', { command: 'sed -n 1,80p /home/dev/.codex/skills/db-migrations/SKILL.md' }, 'ci1', 318),
    cxOut('ci1', '---\nname: db-migrations\ndescription: Write reversible migrations.\n---', 316),
    cxAsst('The settings store is a single reducer in `src/store/settings.ts`, loaded once in `main.tsx`; the toggle dispatches `set-theme`, which persists to localStorage.', 250),
    cxTok(3000, 2200, 410, 249),
  ], 250);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  seedLive(process.argv[2] ?? join(root, '.demo'));
}
