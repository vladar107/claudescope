/**
 * `claudescope mcp` — a stdio MCP server that lets coding agents query their
 * own transcript history ("have I hit this error before?").
 *
 * Architecture: every tool proxies the daemon's HTTP API through {@link ApiClient}
 * (the DuckDB index allows exactly one read-write process — the daemon). The
 * daemon is ensured lazily on first tool use, so `claude mcp add claudescope --
 * claudescope mcp` works with zero preconditions; while the index is still
 * building, tools answer with a short "retry shortly" note instead of hanging.
 *
 * Output is compact text/Markdown, not JSON dumps — these strings land directly
 * in an agent's context window. `get_session` returns a windowed slice with
 * paging info; tool payloads are capped by default. Redaction is opt-in
 * (`redact: true`): output stays on this machine unless the caller exports it.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { MemorySource, SessionMeta } from '@claudescope/shared';
import { redactText, threadItemsToMarkdown, truncateText } from '@claudescope/shared';
import { APP_VERSION } from '../config.js';
import { ensureDaemon } from '../daemon.js';
import { ApiClient } from './api-client.js';

/** Default hits/rows returned by the list-shaped tools. */
const DEFAULT_LIMIT = 20;
/** Default per-tool-payload char cap in `get_session`. */
const DEFAULT_MAX_TOOL_CHARS = 2000;
/** Default turns per `get_session` window when no windowing params are given. */
const DEFAULT_TURNS = 20;
/** Char cap for memory bodies in `get_memory`. */
const MEMORY_BODY_CHARS = 2000;

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const errorText = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });

/** How the server reaches the daemon; injectable so tests point at a fixture app. */
export interface McpDeps {
  resolveClient: () => Promise<ApiClient>;
}

const fmtCost = (usd: number): string => `$${usd.toFixed(2)}`;
const fmtTokens = (n: number): string => n.toLocaleString('en-US');
const day = (iso: string): string => iso.slice(0, 10);

function sessionLine(s: SessionMeta): string {
  const branch = s.gitBranch ? ` · ${s.gitBranch}` : '';
  return (
    `- ${s.id} [${s.connectorId}] ${s.title}\n` +
    `  ${s.projectDisplayName} · ${day(s.startedAt)} → ${day(s.endedAt)} · ` +
    `${s.messageCount} msgs · ${s.toolCallCount} tools · ${fmtTokens(s.totalTokens)} tok · ` +
    `${fmtCost(s.totalCostUsd)}${branch}`
  );
}

function memorySection(sources: MemorySource[]): string {
  return sources
    .map(
      (m) =>
        `### ${m.title}${m.category ? ` (${m.category})` : ''}\n` +
        `_${m.sourcePath} · updated ${day(m.updatedAt)}_\n\n` +
        truncateText(m.markdown, MEMORY_BODY_CHARS),
    )
    .join('\n\n');
}

/**
 * Build the MCP server with all six tools registered. Each handler resolves the
 * client (ensuring the daemon on first use), degrades gracefully while the
 * index builds, and maps thrown errors to an MCP error result.
 */
export function createMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: 'claudescope', version: APP_VERSION });

  /** Wrap a handler with daemon resolution, readiness check, and error mapping. */
  const guarded =
    <A>(fn: (client: ApiClient, args: A) => Promise<string>) =>
    async (args: A) => {
      let client: ApiClient;
      try {
        client = await deps.resolveClient();
      } catch (err) {
        return errorText(
          `Could not reach or start the claudescope daemon: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      try {
        const health = await client.health();
        if (!health.ready) {
          return text('The claudescope index is still building — retry in a few seconds.');
        }
        return text(await fn(client, args));
      } catch (err) {
        return errorText(`Tool failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

  server.registerTool(
    'search_transcripts',
    {
      description:
        'Full-text search (BM25) across all recorded coding-agent transcripts and agent memory. ' +
        'Returns snippet hits with a sessionId + messageUuid — open a hit with ' +
        'get_session {sessionId, around: messageUuid}. Use this to answer "have I seen/solved this before?".',
      inputSchema: {
        query: z.string().describe('Search terms'),
        project: z.string().optional().describe('Project id to scope to (from list_projects)'),
        role: z
          .enum(['user', 'assistant', 'all'])
          .optional()
          .describe('Restrict transcript hits to one side of the conversation (default all)'),
        scope: z
          .enum(['sessions', 'memory', 'all'])
          .optional()
          .describe('What to search: transcripts, agent memory, or both (default sessions)'),
        limit: z.number().int().min(1).max(50).optional().describe(`Max hits (default ${DEFAULT_LIMIT})`),
      },
    },
    guarded(async (client, args: { query: string; project?: string; role?: 'user' | 'assistant' | 'all'; scope?: 'sessions' | 'memory' | 'all'; limit?: number }) => {
      const limit = args.limit ?? DEFAULT_LIMIT;
      const res = await client.search({
        q: args.query,
        project: args.project,
        type: args.role ?? 'all',
        scope: args.scope ?? 'sessions',
        format: 'plain',
      });
      const sessions = res.sessions.slice(0, limit);
      const memory = res.memory.slice(0, limit);
      if (sessions.length === 0 && memory.length === 0) return 'No matches.';

      const parts: string[] = [];
      if (sessions.length > 0) {
        parts.push(
          `${sessions.length} transcript hit(s):`,
          ...sessions.map(
            (h) =>
              `- [${h.role}] ${h.title} (session ${h.sessionId}, project ${h.projectId}, uuid ${h.messageUuid})\n` +
              `  "${h.snippet}"`,
          ),
        );
      }
      if (memory.length > 0) {
        parts.push(
          `${memory.length} memory hit(s):`,
          ...memory.map(
            (h) =>
              `- ${h.title}${h.category ? ` (${h.category})` : ''} [${h.connectorId}] — ${h.sourcePath}\n` +
              `  "${h.snippet}"`,
          ),
        );
      }
      return parts.join('\n');
    }),
  );

  server.registerTool(
    'list_sessions',
    {
      description:
        'List recorded sessions (most recent first by default), optionally filtered by project, ' +
        'agent, or a title/text match. Returns compact rows with sessionIds for get_session.',
      inputSchema: {
        project: z.string().optional().describe('Project id to scope to (from list_projects)'),
        agent: z
          .string()
          .optional()
          .describe('Agent connector id, e.g. claude-code, codex, junie, pi, opencode, copilot, antigravity'),
        sort: z.enum(['recent', 'oldest', 'tokens', 'cost', 'messages']).optional(),
        q: z.string().optional().describe('Substring filter on the session title'),
        limit: z.number().int().min(1).max(200).optional().describe(`Max rows (default ${DEFAULT_LIMIT})`),
      },
    },
    guarded(async (client, args: { project?: string; agent?: string; sort?: 'recent' | 'oldest' | 'tokens' | 'cost' | 'messages'; q?: string; limit?: number }) => {
      const rows = await client.sessions({ ...args, limit: args.limit ?? DEFAULT_LIMIT });
      if (rows.length === 0) return 'No sessions match.';
      return rows.map(sessionLine).join('\n');
    }),
  );

  server.registerTool(
    'get_session',
    {
      description:
        'Read one session as compact Markdown. Sessions can be huge, so this returns a WINDOW of ' +
        `turns (default: first ${DEFAULT_TURNS}) plus the total count — page with offset/limit, or anchor ` +
        'on a search hit with around (a messageUuid) + radius. Tool payloads are truncated to ' +
        `maxToolChars (default ${DEFAULT_MAX_TOOL_CHARS}). Set redact: true to mask home paths and likely secrets.`,
      inputSchema: {
        sessionId: z.string().describe('Session id (from list_sessions or search_transcripts)'),
        offset: z.number().int().min(0).optional().describe('0-based index of the first turn'),
        limit: z.number().int().min(1).optional().describe('Turns to return'),
        around: z.string().optional().describe('Center the window on this message uuid (overrides offset/limit)'),
        radius: z.number().int().min(0).optional().describe('Turns on each side of around (default 10)'),
        maxToolChars: z.number().int().min(0).optional().describe('Char cap per tool payload; 0 = uncapped'),
        redact: z.boolean().optional().describe('Mask home paths and likely secrets (default false)'),
      },
    },
    guarded(async (client, args: { sessionId: string; offset?: number; limit?: number; around?: string; radius?: number; maxToolChars?: number; redact?: boolean }) => {
      const windowed = args.around === undefined && args.offset === undefined && args.limit === undefined
        ? { offset: 0, limit: DEFAULT_TURNS }
        : { offset: args.offset, limit: args.limit, around: args.around, radius: args.radius };
      const data = await client.session(args.sessionId, {
        ...windowed,
        maxToolChars: args.maxToolChars ?? DEFAULT_MAX_TOOL_CHARS,
      });

      const { meta, window } = data;
      const r = args.redact ? redactText : (s: string) => s;
      const head = [
        `# ${r(meta.title)}`,
        `session ${meta.id} [${meta.connectorId}] · project ${meta.projectDisplayName} · ` +
          `${meta.startedAt} → ${meta.endedAt} · ${fmtTokens(meta.totalTokens)} tok · ${fmtCost(meta.totalCostUsd)}`,
      ];
      if (window) {
        const end = window.offset + window.limit;
        head.push(
          `Turns ${window.offset + 1}–${end} of ${window.total}` +
            (window.anchorFound === false ? ' (around uuid not found — showing the start)' : '') +
            (end < window.total ? ` — page on with {offset: ${end}}` : ''),
        );
      }

      const opts = { redact: args.redact ?? false };
      const parts = [head.join('\n'), '---', threadItemsToMarkdown(data.thread, opts)];
      for (const run of data.subagents) {
        parts.push(
          `--- subagent · ${run.agentType} — ${r(run.description || run.agentId)} ---`,
          threadItemsToMarkdown(run.thread, opts),
        );
      }
      return parts.join('\n\n');
    }),
  );

  server.registerTool(
    'list_projects',
    {
      description:
        'List all projects (one per working directory) with session counts, tokens, cost, and ' +
        'which agents worked in them. Project ids scope search_transcripts/list_sessions/get_memory.',
      inputSchema: {},
    },
    guarded(async (client) => {
      const rows = await client.projects();
      if (rows.length === 0) return 'No projects indexed.';
      return rows
        .map(
          (p) =>
            `- ${p.id} · ${p.cwd} · ${p.sessionCount} sessions · ${fmtTokens(p.totalTokens)} tok · ` +
            `${fmtCost(p.totalCostUsd)} · agents: ${p.connectorIds.join(', ')} · last active ${day(p.lastActive)}`,
        )
        .join('\n');
    }),
  );

  server.registerTool(
    'get_analytics',
    {
      description:
        'Aggregated token/cost usage grouped by project, model, day, or agent, with totals. ' +
        'Cost is a local list-price estimate, not billing. Dates are YYYY-MM-DD.',
      inputSchema: {
        groupBy: z.enum(['project', 'model', 'day', 'agent']).optional().describe('Grouping (default project)'),
        from: z.string().optional().describe('Start date (inclusive)'),
        to: z.string().optional().describe('End date (inclusive)'),
      },
    },
    guarded(async (client, args: { groupBy?: 'project' | 'model' | 'day' | 'agent'; from?: string; to?: string }) => {
      const res = await client.analytics({ groupBy: args.groupBy ?? 'project', from: args.from, to: args.to });
      if (res.rows.length === 0) return 'No usage in range.';
      const lines = res.rows.map(
        (row) =>
          `- ${row.key}: ${fmtTokens(row.totalTokens)} tok ` +
          `(in ${fmtTokens(row.inputTokens)}, out ${fmtTokens(row.outputTokens)}, ` +
          `cache r/w ${fmtTokens(row.cacheReadTokens)}/${fmtTokens(row.cacheCreationTokens)}) · ` +
          `${fmtCost(row.costUsd)} · ${row.messageCount} responses`,
      );
      const t = res.totals;
      lines.push(
        `Total: ${fmtTokens(t.totalTokens)} tok · ${fmtCost(t.costUsd)} · ${t.messageCount} responses · ` +
          `cache hit ${(t.cacheHitRatio * 100).toFixed(0)}%`,
      );
      return lines.join('\n');
    }),
  );

  server.registerTool(
    'get_memory',
    {
      description:
        'Read recorded agent memory (instruction files and distilled facts, e.g. CLAUDE.md and ' +
        'Claude Code memory). Without a project: global memory per agent plus which projects have ' +
        'any. With a project id: that project’s memory per agent. Long bodies are truncated.',
      inputSchema: {
        project: z.string().optional().describe('Project id (from list_projects)'),
      },
    },
    guarded(async (client, args: { project?: string }) => {
      if (args.project) {
        const res = await client.projectMemory(args.project);
        const parts = res.byAgent
          .filter((a) => a.sources.length > 0)
          .map((a) => `## ${a.label}\n\n${memorySection(a.sources)}`);
        return parts.length > 0 ? parts.join('\n\n') : 'No memory recorded for this project.';
      }
      const res = await client.memory();
      const parts = res.global
        .filter((g) => g.sources.length > 0)
        .map((g) => `## ${g.label} (global)\n\n${memorySection(g.sources)}`);
      if (res.projects.length > 0) {
        parts.push(
          'Projects with memory (query with {project: id}):',
          ...res.projects.map(
            (p) => `- ${p.projectId} (${p.displayName}): ${p.counts.map((c) => `${c.connectorId} ×${c.count}`).join(', ')}`,
          ),
        );
      }
      return parts.length > 0 ? parts.join('\n\n') : 'No agent memory recorded.';
    }),
  );

  return server;
}

/**
 * Run the production MCP server on stdio. The daemon is ensured once, lazily,
 * on the first tool call; a failed attempt is retried on the next call rather
 * than caching the failure for the whole MCP session.
 */
export async function runMcpServer(): Promise<void> {
  let clientPromise: Promise<ApiClient> | null = null;
  const resolveClient = (): Promise<ApiClient> => {
    clientPromise ??= ensureDaemon().then(
      (d) => new ApiClient(`http://127.0.0.1:${d.port}`),
      (err) => {
        clientPromise = null; // retry on the next tool call
        throw err;
      },
    );
    return clientPromise;
  };

  const server = createMcpServer({ resolveClient });
  await server.connect(new StdioServerTransport());
  // The transport owns the process from here: it resolves connect() immediately
  // and serves requests until stdin closes (the MCP client disconnecting).
}
