/**
 * Google Antigravity connector integration test.
 *
 * Builds the index from synthetic Antigravity transcripts (isolated temp
 * ANTIGRAVITY_CLI_DIR, other agents empty) and exercises the routes, verifying the
 * quirks that make this connector hard:
 *   - cwd is out-of-band (`history.jsonl`), with the `(unknown — Antigravity)`
 *     fallback for a conversation that has no history entry;
 *   - a subagent is a SEPARATE conversation, re-parented under its root session
 *     (so it never appears as its own session) and nested under the parent's
 *     `invoke_subagent` → canonical `Task` tool call (matched by description);
 *   - the subagent's own content is indexed (searchable) under the parent session;
 *   - plaintext `thinking` renders in full (unlike Codex/Copilot);
 *   - tool results are separate typed records correlated by order, and a result
 *     with no preceding call (implicit read) synthesizes a `Read`;
 *   - `write_to_file` → canonical `Write` (feeds Files-changed);
 *   - an uploaded `uploaded_media_*.png` → base64 ImageBlock;
 *   - the `SYSTEM_MESSAGE` subagent summary renders; CHECKPOINT/CONVERSATION_HISTORY
 *     are dropped; cost/tokens are zero (no token data exists);
 *   - global memory read from `~/.gemini/config/agents/AGENTS.md`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

const work = mkdtempSync(join(tmpdir(), 'claudescope-antigravity-'));
const geminiHome = join(work, 'gemini');
const cliDir = join(geminiHome, 'antigravity-cli');

process.env.CLAUDE_PROJECTS_DIR = join(work, 'claude-empty');
process.env.CODEX_SESSIONS_DIR = join(work, 'codex-empty');
process.env.JUNIE_SESSIONS_DIR = join(work, 'junie-empty');
process.env.PI_SESSIONS_DIR = join(work, 'pi-empty');
process.env.OPENCODE_DATA_DIR = join(work, 'opencode-empty');
process.env.COPILOT_SESSIONS_DIR = join(work, 'copilot-empty');
process.env.ANTIGRAVITY_CLI_DIR = cliDir;
process.env.ANTIGRAVITY_DIR = join(work, 'antigravity-desktop-empty');
process.env.DUCKDB_PATH = join(work, 'index.duckdb');
process.env.CLAUDESCOPE_HOME = join(work, 'home');
process.env.REINDEX_INTERVAL_MS = '0';

// Real UUID-shaped ids: the parent↔child linkage is extracted from the transcript
// text via a UUID regex (`sender=`, "Conversation ID:"), so ids must look real.
const PARENT = '11111111-1111-1111-1111-111111111111';
const CHILD = '22222222-2222-2222-2222-222222222222';
const ORPHAN = '33333333-3333-3333-3333-333333333333';
const IMG_NAME = 'uploaded_media_0_1782909688549.png';
const IMG_ABS = join(cliDir, 'brain', PARENT, IMG_NAME);

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const jsonl = (rows: unknown[]): string => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const at = (s: number): string => `2026-07-01T12:00:${String(s).padStart(2, '0')}Z`;

/** One transcript_full.jsonl step record. */
const step = (
  stepIndex: number,
  source: string,
  type: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  step_index: stepIndex,
  source,
  type,
  status: 'DONE',
  created_at: at(stepIndex),
  ...extra,
});

/** Write `<cliDir>/brain/<conv>/.system_generated/logs/transcript_full.jsonl`. */
function writeTranscript(conv: string, records: unknown[]): void {
  const dir = join(cliDir, 'brain', conv, '.system_generated', 'logs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'transcript_full.jsonl'), jsonl(records));
}

function writeFixtures(): void {
  // Parent: reads a dir, writes a file, spawns a research subagent, gets its
  // result back, then an implicit file view (a result with no preceding call).
  writeTranscript(PARENT, [
    step(0, 'USER_EXPLICIT', 'USER_INPUT', {
      content:
        '<USER_REQUEST>\nAnalyze my projects\n</USER_REQUEST>\n' +
        '<ADDITIONAL_METADATA>\nThe current local time is: 2026-07-01T14:00:00+02:00.\n\n' +
        `The user has uploaded 1 image(s):\n- ${IMG_ABS}\n</ADDITIONAL_METADATA>\n` +
        '<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to ' +
        'Gemini 3.5 Flash (Medium). No need to comment on this change.\n</USER_SETTINGS_CHANGE>',
    }),
    step(1, 'MODEL', 'PLANNER_RESPONSE', {
      thinking: 'Let me look around the workspace.',
      content: "I'll inspect the directory.",
      tool_calls: [
        { name: 'list_dir', args: { DirectoryPath: '/tmp/proj', toolAction: 'List', toolSummary: 'List' } },
      ],
    }),
    step(2, 'MODEL', 'LIST_DIRECTORY', {
      content: 'Created At: ...\n{"name":"a","isDir":true}\n{"name":"README.md"}',
    }),
    step(3, 'MODEL', 'PLANNER_RESPONSE', {
      content: 'Writing a summary file.',
      tool_calls: [
        {
          name: 'write_to_file',
          args: {
            TargetFile: '/tmp/proj/summary.md',
            CodeContent: '# Summary\nAll good.',
            Overwrite: true,
            ArtifactMetadata: { UserFacing: true, Summary: 'summary' },
          },
        },
      ],
    }),
    step(4, 'MODEL', 'CODE_ACTION', {
      content: 'Created file file:///tmp/proj/summary.md with requested content.',
    }),
    step(5, 'MODEL', 'PLANNER_RESPONSE', {
      content: 'Delegating research to a subagent.',
      tool_calls: [
        {
          name: 'invoke_subagent',
          args: {
            Subagents: [
              {
                Prompt: 'Inspect all subdirectories inside /tmp/proj.',
                Role: 'Codebase Explorer',
                TypeName: 'research',
                Workspace: 'inherit',
              },
            ],
            toolAction: 'Invoke',
            toolSummary: 'Invoke',
          },
        },
      ],
    }),
    step(6, 'MODEL', 'PLANNER_RESPONSE', {
      content: `I have started the \`research\` subagent (Conversation ID: \`${CHILD}\`) to inspect the projects.`,
    }),
    step(7, 'SYSTEM', 'SYSTEM_MESSAGE', {
      content:
        'The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n<SYSTEM_MESSAGE>\n' +
        `[Message] timestamp=${at(7)} sender=${CHILD} priority=MESSAGE_PRIORITY_HIGH ` +
        'content=### Workspace Summary\nProjects found: 3.',
    }),
    // Truncation scaffolding — must be dropped, never rendered.
    step(8, 'SYSTEM', 'CHECKPOINT', { content: '{{ CHECKPOINT 0 }} earlier turns truncated…' }),
    step(9, 'SYSTEM', 'CONVERSATION_HISTORY', {}),
    // A result record with no preceding call → synthesize a Read.
    step(10, 'MODEL', 'VIEW_FILE', {
      content: 'File Path: `file:///tmp/proj/README.md`\nTotal Lines: 3\n# Readme',
    }),
  ]);

  // Subagent: its own conversation (no history.jsonl entry). Reports back via
  // send_message; its result is the parent's SYSTEM_MESSAGE.
  writeTranscript(CHILD, [
    step(0, 'USER_EXPLICIT', 'USER_INPUT', {
      content: '<USER_REQUEST>\nInspect all subdirectories inside /tmp/proj.\n</USER_REQUEST>',
    }),
    step(1, 'MODEL', 'PLANNER_RESPONSE', {
      thinking: 'Exploring the tree.',
      content: 'Found 3 projects.',
      tool_calls: [{ name: 'view_file', args: { AbsolutePath: '/tmp/proj/a/README.md' } }],
    }),
    step(2, 'MODEL', 'VIEW_FILE', { content: 'File Path: `file:///tmp/proj/a/README.md`\n# A' }),
    step(3, 'MODEL', 'PLANNER_RESPONSE', {
      content: 'Reporting back.',
      tool_calls: [
        { name: 'send_message', args: { ConversationId: PARENT, Message: '### Workspace Summary\nProjects found: 3.' } },
      ],
    }),
    step(4, 'MODEL', 'GENERIC', { content: `Message sent to "${PARENT}".` }),
  ]);

  // Orphan: a top-level conversation with NO history entry → unknown-cwd bucket.
  writeTranscript(ORPHAN, [
    step(0, 'USER_EXPLICIT', 'USER_INPUT', { content: '<USER_REQUEST>\nHello there\n</USER_REQUEST>' }),
    step(1, 'MODEL', 'PLANNER_RESPONSE', { content: 'Hi!' }),
  ]);

  // The uploaded image bytes referenced by the parent's USER_INPUT metadata.
  writeFileSync(IMG_ABS, Buffer.from(PNG_B64, 'base64'));

  // history.jsonl maps the PARENT (and only it) to a workspace. A leading
  // slash-command line without a conversationId is present (as in real data).
  writeFileSync(
    join(cliDir, 'history.jsonl'),
    jsonl([
      { display: '/statusline', timestamp: 1, workspace: '/tmp/proj' },
      { display: 'analyze', timestamp: 2, workspace: '/tmp/proj', conversationId: PARENT },
    ]),
  );

  // Global memory (Antigravity's self-authored global rules).
  mkdirSync(join(geminiHome, 'config', 'agents'), { recursive: true });
  writeFileSync(join(geminiHome, 'config', 'agents', 'AGENTS.md'), '# Global rules\n- Be concise.\n');
}

let app: FastifyInstance;
let closeConnection: () => Promise<void>;

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
});

afterAll(async () => {
  await app?.close();
  await closeConnection?.();
  rmSync(work, { recursive: true, force: true });
});

const get = (url: string) => app.inject({ method: 'GET', url });
type Session = {
  id: string;
  connectorId: string;
  title: string;
  models: string[];
  projectDisplayName: string;
  totalTokens: number;
  totalCostUsd: number;
  hasSidechain: boolean;
};
const sessions = async (): Promise<Session[]> => (await get('/api/sessions')).json();
const sessionById = async (id: string): Promise<Session> =>
  (await sessions()).find((s) => s.id === id) as Session;

describe('antigravity session indexing', () => {
  it('re-parents the subagent (no orphan session) and tags sessions antigravity', async () => {
    const list = await sessions();
    // The subagent conversation is merged into the parent — NOT its own session.
    expect(list.map((s) => s.id).sort()).toEqual([PARENT, ORPHAN].sort());
    for (const s of list) expect(s.connectorId).toBe('antigravity');
  });

  it('resolves cwd from history.jsonl, with the unknown bucket as fallback', async () => {
    expect((await sessionById(PARENT)).projectDisplayName).toBe('proj');
    // No history entry for the orphan conversation → the Antigravity unknown bucket.
    expect((await sessionById(ORPHAN)).projectDisplayName).toBe('(unknown — Antigravity)');
  });

  it('derives the title from the unwrapped first user message and parses the model', async () => {
    const p = await sessionById(PARENT);
    expect(p.title).toBe('Analyze my projects');
    expect(p.models).toContain('Gemini 3.5 Flash (Medium)');
  });

  it('reports zero cost (no token data exists) and marks the sidechain', async () => {
    const p = await sessionById(PARENT);
    expect(p.totalTokens).toBe(0);
    expect(p.totalCostUsd).toBe(0);
    expect(p.hasSidechain).toBe(true); // the re-parented subagent rows
  });

  it('exposes the antigravity source and groups analytics by the agent', async () => {
    const sources = (await get('/api/sources')).json();
    expect(sources.some((s: { id: string }) => s.id === 'antigravity')).toBe(true);
    const { rows } = (await get('/api/analytics?groupBy=agent')).json();
    expect(rows.map((r: { key: string }) => r.key)).toContain('antigravity');
  });

  it('indexes subagent content under the parent session (searchable)', async () => {
    // "Found 3 projects." lives only in the subagent transcript; it must surface
    // under the PARENT session, proving the re-parented rows are indexed.
    const { sessions: results } = (await get('/api/search?q=Found 3 projects')).json();
    expect(results.some((r: { sessionId: string }) => r.sessionId === PARENT)).toBe(true);
    expect(results.some((r: { sessionId: string }) => r.sessionId === CHILD)).toBe(false);
  });

  it('surfaces the global AGENTS.md memory', async () => {
    const { global } = (await get('/api/memory')).json();
    const ag = global.find((g: { connectorId: string }) => g.connectorId === 'antigravity');
    expect(ag).toBeTruthy();
    expect(ag.label).toBe('Antigravity');
    expect(JSON.stringify(ag.sources)).toContain('AGENTS.md (global)');
  });
});

describe('antigravity session detail', () => {
  it('nests the subagent under its invoke_subagent (Task) call', async () => {
    const detail = (await get(`/api/sessions/${PARENT}`)).json();
    expect(detail.subagents).toHaveLength(1);
    const run = detail.subagents[0];
    expect(run.agentType).toBe('research');
    expect(run.description).toBe('Inspect all subdirectories inside /tmp/proj.');
    expect(run.thread.length).toBeGreaterThan(0);

    // The run is anchored to the main-thread Task tool call spawned from invoke_subagent.
    const flat = detail.thread.flatMap((t: { blocks: Record<string, unknown>[] }) => t.blocks);
    const task = flat.find((b: Record<string, unknown>) => b.kind === 'tool' && b.name === 'Task');
    expect(task).toBeTruthy();
    expect(run.toolUseId).toBe(task.id);
  });

  it('renders plaintext thinking, a canonical Write, a synthesized Read, and the image', async () => {
    const detail = (await get(`/api/sessions/${PARENT}`)).json();
    const flat = detail.thread.flatMap((t: { blocks: Record<string, unknown>[] }) => t.blocks);

    // Plaintext thinking renders in full (unlike Codex/Copilot's empty blocks).
    const thinking = flat.find((b: Record<string, unknown>) => b.type === 'thinking');
    expect(thinking.thinking).toBe('Let me look around the workspace.');

    // write_to_file → canonical Write (what changeset.ts keys off for Files-changed).
    const write = flat.find((b: Record<string, unknown>) => b.kind === 'tool' && b.name === 'Write');
    expect(write.input).toEqual({ file_path: '/tmp/proj/summary.md', content: '# Summary\nAll good.' });

    // list_dir result folded into its call.
    const list = flat.find((b: Record<string, unknown>) => b.kind === 'tool' && b.name === 'list_dir');
    expect(JSON.stringify(list.result.content)).toContain('README.md');

    // The VIEW_FILE with no preceding call → synthesized Read, result attached.
    const read = flat.find((b: Record<string, unknown>) => b.kind === 'tool' && b.name === 'Read');
    expect(JSON.stringify(read.result.content)).toContain('README.md');

    // Uploaded screenshot → base64 ImageBlock (carried as an attachment block).
    const att = flat.find((b: Record<string, unknown>) => b.kind === 'attachment');
    expect(att.attachment).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: PNG_B64 },
    });
  });

  it('renders the SYSTEM_MESSAGE subagent summary and drops truncation scaffolding', async () => {
    const detail = (await get(`/api/sessions/${PARENT}`)).json();
    const serialized = JSON.stringify(detail.thread);
    expect(serialized).toContain('Projects found: 3.'); // the subagent's returned summary
    expect(serialized).not.toContain('CHECKPOINT 0'); // truncation scaffolding dropped
  });
});
