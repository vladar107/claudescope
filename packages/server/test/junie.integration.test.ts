/**
 * Junie connector integration test.
 *
 * Builds the index from a synthetic Junie session (an isolated temp
 * `JUNIE_SESSIONS_DIR` with an `index.jsonl` + `session-<id>/events.jsonl`, and
 * the Claude/Codex sources empty) and exercises the routes. Verifies the
 * event-stream → conversation normalization: title from index `taskName`, cwd
 * from `projectDir`, per-turn tokens summed from `LlmResponseMetadataEvent`,
 * block events coalesced by stepId into paired tool_use/tool_result, the
 * `ResultBlockUpdatedEvent` final text, and a base64-inlined pasted image.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

const work = mkdtempSync(join(tmpdir(), 'claudescope-junie-'));
const junieDir = join(work, 'junie');
const codexDir = join(work, 'codex-empty');
const claudeDir = join(work, 'claude-empty');
// A directory OUTSIDE Junie's home, used to plant a file the connector must
// refuse to read (F4 path-traversal containment).
const outside = mkdtempSync(join(tmpdir(), 'claudescope-junie-outside-'));

process.env.CLAUDE_PROJECTS_DIR = claudeDir;
process.env.CODEX_SESSIONS_DIR = codexDir;
process.env.JUNIE_SESSIONS_DIR = junieDir;
process.env.PI_SESSIONS_DIR = join(work, 'pi-empty');
process.env.OPENCODE_DATA_DIR = join(work, 'opencode-empty');
process.env.COPILOT_SESSIONS_DIR = join(work, 'copilot-empty');
process.env.ANTIGRAVITY_CLI_DIR = join(work, 'antigravity-empty');
process.env.ANTIGRAVITY_DIR = join(work, 'antigravity-empty-desktop');
process.env.DUCKDB_PATH = join(work, 'index.duckdb');
process.env.CLAUDESCOPE_HOME = join(work, 'home');
process.env.REINDEX_INTERVAL_MS = '0';

const jsonl = (events: unknown[]): string => events.map((e) => JSON.stringify(e)).join('\n') + '\n';
/** SessionA2uxEvent wrapper around a nested agentEvent, with a timestamp. */
const a2ux = (agentEvent: unknown, sec: number) => ({
  kind: 'SessionA2uxEvent',
  event: { state: 'IN_PROGRESS', agentEvent },
  timestampMs: Date.UTC(2026, 0, 1, 10, 0, sec),
});

const SESSION_ID = 'session-260101-100000-test';
// A 1×1 transparent PNG.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** Write a synthetic Junie session (index.jsonl + events.jsonl + a pasted PNG). */
function writeSession(): void {
  const sessionDir = join(junieDir, SESSION_ID);
  mkdirSync(sessionDir, { recursive: true });

  const imgDir = join(junieDir, 'clipboard-images', SESSION_ID);
  mkdirSync(imgDir, { recursive: true });
  // A pasted PNG referenced via customAttachments, and another referenced via an
  // `@/path.png` mention in the prompt text. A third mention points at a file
  // that no longer exists (Junie purges clipboard images quickly).
  const pngPath = join(imgDir, 'shot.png');
  const mentionPath = join(imgDir, 'mention.png');
  const missingPath = join(imgDir, 'gone.png');
  writeFileSync(pngPath, Buffer.from(PNG_BASE64, 'base64'));
  writeFileSync(mentionPath, Buffer.from(PNG_BASE64, 'base64'));

  // Two POISONED attachments the connector must refuse (F4): a real PNG OUTSIDE
  // ~/.junie (arbitrary-file read / traversal), and a non-image file INSIDE the
  // tree (extension gate). Both hold "secret" bytes that must never be inlined.
  const secretImg = join(outside, 'secret.png');
  const secretTxt = join(imgDir, 'secret.txt');
  writeFileSync(secretImg, Buffer.from(PNG_BASE64, 'base64'));
  writeFileSync(secretTxt, 'TOP SECRET');

  writeFileSync(
    join(junieDir, 'index.jsonl'),
    jsonl([
      {
        sessionId: SESSION_ID,
        createdAt: Date.UTC(2026, 0, 1, 10, 0, 0),
        updatedAt: Date.UTC(2026, 0, 1, 10, 0, 9),
        projectDir: '/tmp/junieproj',
        taskName: 'Find the needle in the junie haystack',
      },
    ]),
  );

  writeFileSync(
    join(sessionDir, 'events.jsonl'),
    jsonl([
      // User prompt referencing images two ways: `@/path.png` mentions in the
      // text (one present, one purged) plus a customAttachments path. The typed
      // attachment object is skipped.
      {
        kind: 'UserPromptEvent',
        prompt: `look at this screenshot @${mentionPath} and the old one @${missingPath}`,
        customAttachments: [pngPath, secretImg, secretTxt, { kind: 'OnboardingMigrationAttachment' }],
      },
      { kind: 'SendToAgentEvent' },
      // Token usage for the assistant turn (haiku family → priced via substring).
      a2ux(
        {
          kind: 'LlmResponseMetadataEvent',
          modelUsage: [
            {
              model: 'claude-haiku-4-5-20251001',
              cost: 0.0026,
              inputTokens: 1000,
              cacheInputTokens: 200,
              cacheCreateTokens: 100,
              outputTokens: 300,
              time: 0,
            },
          ],
        },
        2,
      ),
      // A single logical step described across two block events (same stepId):
      // a Tool label + a ViewFiles detail. Repeated IN_PROGRESS→COMPLETED.
      a2ux({ kind: 'ToolBlockUpdatedEvent', stepId: 'step-A', text: 'Open needle.txt', status: 'IN_PROGRESS' }, 3),
      a2ux(
        {
          kind: 'ViewFilesBlockUpdatedEvent',
          stepId: 'step-A',
          status: 'COMPLETED',
          files: [{ relativePath: 'needle.txt', lineFrom: 1, lineTo: 5 }],
          details: 'needle found on line 3',
        },
        4,
      ),
      // A terminal step.
      a2ux({ kind: 'TerminalBlockUpdatedEvent', stepId: 'step-B', status: 'IN_PROGRESS', command: 'grep -n needle needle.txt' }, 5),
      a2ux({ kind: 'TerminalBlockUpdatedEvent', stepId: 'step-B', status: 'COMPLETED', details: '3:needle' }, 6),
      // A file edit — full before/after content, which must surface as an Edit
      // block (file_path/old_string/new_string) for the Files-changed tab.
      a2ux(
        {
          kind: 'FileChangesBlockUpdatedEvent',
          stepId: 'step-C',
          status: 'COMPLETED',
          changes: [
            {
              beforeContent: { kind: 'TextFileContent', text: 'const x = 1;\n' },
              afterContent: { kind: 'TextFileContent', text: 'const x = 2;\n' },
              beforeRelativePath: 'src/app.ts',
              afterRelativePath: 'src/app.ts',
            },
          ],
        },
        6,
      ),
      // Noise that must be ignored.
      a2ux({ kind: 'AgentCurrentStatusUpdatedEvent', status: 'Sending LLM request' }, 6),
      a2ux({ kind: 'AgentStateUpdatedEvent', blob: '{"opaque":true}' }, 6),
      // The final assistant answer.
      a2ux({ kind: 'ResultBlockUpdatedEvent', stepId: 'step-R', cancelled: false, result: 'found it on line 3', changes: [] }, 7),
      { kind: 'TaskState', state: 'COMPLETED', timestampMs: Date.UTC(2026, 0, 1, 10, 0, 9) },
    ]),
  );
}

let app: FastifyInstance;
let closeConnection: () => Promise<void>;

beforeAll(async () => {
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(codexDir, { recursive: true });
  writeSession();

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
  rmSync(outside, { recursive: true, force: true });
});

const get = (url: string) => app.inject({ method: 'GET', url });

describe('Junie session indexing', () => {
  it('lists the session with the index taskName as title and a junie agent tag', async () => {
    const sessions = (await get('/api/sessions')).json();
    expect(sessions.map((s: { id: string }) => s.id)).toEqual([SESSION_ID]);
    expect(sessions[0].connectorId).toBe('junie');
    expect(sessions[0].title).toBe('Find the needle in the junie haystack');
    expect(sessions[0].models).toContain('claude-haiku-4-5-20251001');
    // cwd resolved from index.jsonl projectDir; display name is its last segment.
    expect(sessions[0].projectDisplayName).toBe('junieproj');
  });

  it('tags the project with its agent and groups analytics by agent', async () => {
    const projects = (await get('/api/projects')).json();
    expect(projects[0].connectorIds).toContain('junie');

    const { rows } = (await get('/api/analytics?groupBy=agent')).json();
    expect(rows.map((r: { key: string }) => r.key)).toContain('junie');
  });

  it('exposes the junie source directory via /api/sources', async () => {
    const sources = (await get('/api/sources')).json();
    expect(sources.some((s: { id: string }) => s.id === 'junie')).toBe(true);
  });

  it('sums modelUsage tokens and computes a haiku-family cost', async () => {
    const s = (await get('/api/sessions')).json()[0];
    // input 1000 + output 300 + cache_read 200 + cache_write 100 = 1600.
    expect(s.totalTokens).toBe(1600);
    // haiku: (1000*1 + 300*5 + 100*1.25 + 200*0.1) / 1e6 = 0.002645
    expect(s.totalCostUsd).toBeCloseTo(0.002645, 6);
  });

  it('finds the Junie session via full-text search on tool labels', async () => {
    const { sessions: results } = (await get('/api/search?q=needle')).json();
    expect(results.some((r: { sessionId: string }) => r.sessionId === SESSION_ID)).toBe(true);
  });
});

describe('Junie session detail', () => {
  it('coalesces block events by stepId into paired tool interactions', async () => {
    const detail = (await get(`/api/sessions/${SESSION_ID}`)).json();
    expect(detail.subagents).toEqual([]);

    const flat = detail.thread.flatMap((t: { blocks: Record<string, unknown>[] }) => t.blocks);
    const tools = flat.filter((b: Record<string, unknown>) => b.kind === 'tool');
    // Three logical steps (A: view, B: terminal, C: edit); Result is text.
    expect(tools).toHaveLength(3);

    const view = tools.find((b: { name: string }) => b.name === 'view');
    expect(view.result.content[0]).toMatchObject({ type: 'text', text: 'needle found on line 3' });

    // The terminal step is canonicalized to `Bash` so its command renders with
    // bash highlighting (not raw JSON); the command field is preserved.
    const term = tools.find((b: { name: string }) => b.name === 'Bash');
    expect((term.input as { command: string }).command).toBe('grep -n needle needle.txt');
    expect(term.result.content[0]).toMatchObject({ type: 'text', text: '3:needle' });

    // The file edit is an Edit block in the shape the Files-changed tab reads.
    const edit = tools.find((b: { name: string }) => b.name === 'Edit');
    expect(edit.input).toMatchObject({
      file_path: 'src/app.ts',
      old_string: 'const x = 1;\n',
      new_string: 'const x = 2;\n',
    });

    const allText = JSON.stringify(detail.thread);
    expect(allText).toContain('found it on line 3'); // ResultBlock final text
    expect(allText).not.toContain('Sending LLM request'); // status spinner ignored
    expect(allText).not.toContain('opaque'); // state blob ignored
  });

  it('inlines pasted PNGs (mention + customAttachments) as base64 image blocks', async () => {
    const detail = (await get(`/api/sessions/${SESSION_ID}`)).json();
    const flat = detail.thread.flatMap((t: { blocks: Record<string, unknown>[] }) => t.blocks);
    const images = flat.filter(
      (b: Record<string, unknown>) =>
        b.kind === 'attachment' && (b.attachment as { type?: string })?.type === 'image',
    );
    // Exactly two: the `@mention` one + the in-tree customAttachments PNG. The
    // poisoned attachments (a PNG outside ~/.junie and an in-tree .txt) are refused
    // by the F4 containment + extension gate, and the purged mention embeds nothing.
    expect(images).toHaveLength(2);
    for (const img of images) {
      const source = (img.attachment as { source: { type: string; media_type: string; data: string } })
        .source;
      expect(source).toMatchObject({ type: 'base64', media_type: 'image/png', data: PNG_BASE64 });
    }
  });

  it('cleans @image mentions out of the prompt text (present + purged)', async () => {
    const detail = (await get(`/api/sessions/${SESSION_ID}`)).json();
    const userTurn = detail.thread.find((t: { role: string }) => t.role === 'user');
    const text = userTurn.blocks
      .filter((b: { kind: string }) => b.kind === 'text')
      .map((b: { text: string }) => b.text)
      .join(' ');
    expect(text).toContain('[image: mention.png]');
    expect(text).toContain('[image: gone.png (unavailable)]');
    // The raw absolute clipboard paths must not leak into the rendered text.
    expect(text).not.toContain('@/');
    expect(text).not.toContain('clipboard-images');
  });
});
