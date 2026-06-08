/**
 * Deterministic synthetic-corpus generator for the perf suite. Writes a
 * miniature `~/.claude/projects` tree (same on-disk layout the indexer expects)
 * into a target dir. Seeded so the corpus is byte-identical across runs and
 * machines — which is what makes a same-runner A/B comparison meaningful.
 *
 * Mirrors the fixture shape in test/api.integration.test.ts (user/assistant
 * turns, paired tool_use/tool_result, thinking blocks, usage tokens, subagents,
 * ai-title + pr-link aux events) but parameterized by size.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface CorpusOptions {
  projects: number;
  sessionsPerProject: number;
  eventsPerSession: number;
  largeSessions: number;
  largeSessionEvents: number;
  toolRatio: number; // fraction of assistant turns that issue a tool call
  thinkingRatio: number; // fraction of assistant turns with a thinking block
  seed: number;
}

export interface CorpusInfo {
  totalEvents: number;
  totalBytes: number;
  sessionIds: string[];
  /** A deliberately large session, for the session-load scenario. */
  largeSessionId: string;
  largeSessionFile: string;
  /** Rare token guaranteed to appear in the corpus, for the search scenario. */
  searchTerm: string;
}

export const SEARCH_TERM = 'xyzzysentinel';
const MODELS = ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5'];
const FILLER =
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt';

/** Small fast deterministic PRNG (mulberry32). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ms = (base: number, step: number) => new Date(base + step * 1000).toISOString();

/** Build one session's JSONL lines; returns the events array. */
function buildSession(
  rng: () => number,
  sessionId: string,
  cwd: string,
  targetEvents: number,
  opts: CorpusOptions,
  withSubagent: boolean,
): unknown[] {
  const base = { sessionId, cwd, gitBranch: 'main', version: '2.1.0' };
  const t0 = Date.parse('2026-01-01T00:00:00.000Z');
  const events: unknown[] = [{ type: 'ai-title', sessionId, aiTitle: `Session ${sessionId}` }];
  let step = 0;
  let n = 0;
  let prev: string | null = null;
  let toolSeq = 0;

  const uuid = (tag: string) => `${sessionId}-${tag}-${n}`;

  while (n < targetEvents) {
    // user turn
    const uId = uuid('u');
    events.push({
      ...base,
      type: 'user',
      uuid: uId,
      parentUuid: prev,
      timestamp: ms(t0, step++),
      isSidechain: false,
      message: { role: 'user', content: `${FILLER} request ${n}` },
    });
    prev = uId;
    n++;
    if (n >= targetEvents) break;

    // assistant turn
    const aId = uuid('a');
    const model = MODELS[Math.floor(rng() * MODELS.length)];
    const wantsTool = rng() < opts.toolRatio;
    const content: unknown[] = [];
    if (rng() < opts.thinkingRatio) {
      // Claude persists only a thinking signature, not the text.
      content.push({ type: 'thinking', thinking: '', signature: 's' });
    }
    const term = rng() < 0.5 ? ` ${SEARCH_TERM}` : '';
    content.push({ type: 'text', text: `${FILLER} reply ${n}${term}` });

    let toolId: string | null = null;
    if (wantsTool) {
      toolId = `tu-${sessionId}-${toolSeq++}`;
      content.push({ type: 'tool_use', id: toolId, name: 'Bash', input: { command: 'ls -la' } });
    }
    events.push({
      ...base,
      type: 'assistant',
      uuid: aId,
      parentUuid: prev,
      timestamp: ms(t0, step++),
      isSidechain: false,
      message: {
        role: 'assistant',
        model,
        content,
        usage: {
          input_tokens: 100 + Math.floor(rng() * 4000),
          output_tokens: 50 + Math.floor(rng() * 1500),
          cache_read_input_tokens: Math.floor(rng() * 8000),
          cache_creation_input_tokens: Math.floor(rng() * 2000),
        },
      },
    });
    prev = aId;
    n++;

    // matching tool_result user turn
    if (toolId && n < targetEvents) {
      const rId = uuid('r');
      events.push({
        ...base,
        type: 'user',
        uuid: rId,
        parentUuid: prev,
        timestamp: ms(t0, step++),
        isSidechain: false,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: 'ok' }] },
      });
      prev = rId;
      n++;
    }
  }

  // For sessions that should exercise the subagent path, add an Agent spawn
  // whose description correlates with the subagent meta written by the caller.
  if (withSubagent) {
    const aId = uuid('a');
    events.push({
      ...base,
      type: 'assistant',
      uuid: aId,
      parentUuid: prev,
      timestamp: ms(t0, step++),
      isSidechain: false,
      message: {
        role: 'assistant',
        model: MODELS[0],
        content: [
          {
            type: 'tool_use',
            id: `tu-agent-${sessionId}`,
            name: 'Agent',
            input: { description: `explore ${sessionId}`, subagent_type: 'Explore' },
          },
        ],
        usage: { input_tokens: 30, output_tokens: 10 },
      },
    });
  }
  return events;
}

const jsonl = (events: unknown[]): string =>
  events.map((e) => JSON.stringify(e)).join('\n') + '\n';

/** Generate the corpus on disk under `projectsDir`; returns summary info. */
export function generateCorpus(projectsDir: string, opts: CorpusOptions): CorpusInfo {
  const rng = mulberry32(opts.seed);
  const sessionIds: string[] = [];
  let totalEvents = 0;
  let totalBytes = 0;

  const writeSession = (
    projDir: string,
    cwd: string,
    sessionId: string,
    targetEvents: number,
    withSubagent: boolean,
  ): string => {
    const events = buildSession(rng, sessionId, cwd, targetEvents, opts, withSubagent);
    const file = join(projDir, `${sessionId}.jsonl`);
    const content = jsonl(events);
    writeFileSync(file, content);
    totalBytes += Buffer.byteLength(content);
    totalEvents += events.length;
    sessionIds.push(sessionId);

    if (withSubagent) {
      const subDir = join(projDir, sessionId, 'subagents');
      mkdirSync(subDir, { recursive: true });
      const subEvents = [
        { sessionId, cwd, isSidechain: true, type: 'user', uuid: `${sessionId}-su`, parentUuid: null, agentId: 'aaaa', timestamp: '2026-01-01T11:00:00.000Z', message: { role: 'user', content: 'explore please' } },
        { sessionId, cwd, isSidechain: true, type: 'assistant', uuid: `${sessionId}-sa`, parentUuid: `${sessionId}-su`, agentId: 'aaaa', timestamp: '2026-01-01T11:00:05.000Z', message: { role: 'assistant', model: MODELS[0], content: [{ type: 'text', text: `${FILLER} explored` }], usage: { input_tokens: 40, output_tokens: 20 } } },
      ];
      const subContent = jsonl(subEvents);
      writeFileSync(join(subDir, 'agent-aaaa.jsonl'), subContent);
      writeFileSync(join(subDir, 'agent-aaaa.meta.json'), JSON.stringify({ agentType: 'Explore', description: `explore ${sessionId}` }));
      totalBytes += Buffer.byteLength(subContent);
      totalEvents += subEvents.length;
    }
    return file;
  };

  for (let p = 0; p < opts.projects; p++) {
    const projDir = join(projectsDir, `enc-proj${p}`);
    const cwd = `/tmp/perf/proj${p}`;
    mkdirSync(projDir, { recursive: true });
    for (let s = 0; s < opts.sessionsPerProject; s++) {
      const id = `s${p}_${String(s).padStart(4, '0')}`;
      // Give a slice of sessions a subagent to exercise that load path.
      writeSession(projDir, cwd, id, opts.eventsPerSession, s % 5 === 0);
    }
  }

  // Large sessions live in their own project; the first is returned for the
  // session-load scenario.
  const largeDir = join(projectsDir, 'enc-projLarge');
  mkdirSync(largeDir, { recursive: true });
  const largeCwd = '/tmp/perf/projLarge';
  let largeSessionId = '';
  let largeSessionFile = '';
  for (let i = 0; i < opts.largeSessions; i++) {
    const id = `s_large_${i}`;
    const file = writeSession(largeDir, largeCwd, id, opts.largeSessionEvents, true);
    if (i === 0) {
      largeSessionId = id;
      largeSessionFile = file;
    }
  }

  return { totalEvents, totalBytes, sessionIds, largeSessionId, largeSessionFile, searchTerm: SEARCH_TERM };
}
