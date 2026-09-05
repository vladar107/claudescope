/**
 * GET /api/analytics/agents — cross-agent comparison over the sessions in scope
 * (optional project + session-start date range), one row per agent.
 *
 * Same aggregation semantics as /api/analytics (assistant events,
 * usage_canonical dedup, the shared cache-hit denominator), grouped by the
 * session's connector — except the tool-call count, which is a per-row count and
 * dedups fork copies only (THE RULE in `data/analytics-metrics.ts`). Date bounds
 * filter on the session START — a session is atomic here, like
 * /api/analytics/sessions.
 *
 * Data-gap semantics are the point of this endpoint: agents record usage at
 * different granularities (see AgentUsageGranularity), so metrics an agent
 * cannot honestly report are `null` ("not available") — NEVER 0. The
 * granularity is a per-connector property of the source format, declared in
 * `data/agent-capabilities.ts`, not inferred from the data (a zero-usage corpus is
 * still a real 0 for a per-response agent).
 *
 * Ride-along: PR-linked session stats (count + cost per PR-linked session).
 * Only Claude Code emits pr-link records, so this is a Claude-Code-only stat.
 */

import type { FastifyInstance } from 'fastify';
import type {
  AgentComparisonResponse,
  AgentComparisonRow,
  PrLinkedStats,
} from '@claudescope/shared';
import { getConnection, queryRows } from '../db/duckdb.js';
import { readRow } from '../db/row.js';
import { cacheHitRatio, toolCallRowsSql } from '../data/analytics-metrics.js';
import { scopeFilters } from '../data/analytics-scope.js';
import {
  hasInterruptSignal,
  hasSubagentLinkage,
  usageAvailabilityNote,
  usageGranularity,
} from '../data/agent-capabilities.js';
import { errorSignalsByAgent } from './analytics-errors.js';

export async function registerAgentComparisonRoute(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: { project?: string; from?: string; to?: string; timeZone?: string };
  }>('/api/analytics/agents', async (req): Promise<AgentComparisonResponse> => {
    const conn = await getConnection();

    const filters = await scopeFilters(conn, req.query);
    const whereSql = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';

    // Sessions in scope, then: per-agent session counts + per-agent deduped
    // event sums (assistant events of the scoped sessions).
    const scopedCte = `
      WITH scoped AS (
        SELECT id, connector_id, has_sidechain, pr_url, total_cost_usd
        FROM sessions
        ${whereSql}
      )
    `;

    const rowsRaw = await queryRows(
      conn,
      `${scopedCte},
       ev AS (
         SELECT
           sc.connector_id AS connector_id,
           sum(e.input_tokens)       FILTER (WHERE e.usage_canonical) AS input_tokens,
           sum(e.output_tokens)      FILTER (WHERE e.usage_canonical) AS output_tokens,
           sum(e.cache_read_tokens)  FILTER (WHERE e.usage_canonical) AS cache_read_tokens,
           sum(e.cache_write_tokens) FILTER (WHERE e.usage_canonical) AS cache_write_tokens,
           sum(e.cost_usd)           FILTER (WHERE e.usage_canonical) AS cost_usd,
           -- Per-row count: fork copies only (THE RULE in data/analytics-metrics.ts).
           sum(e.tool_use_count)     FILTER (WHERE ${toolCallRowsSql()}) AS tool_calls,
           count(*)                  FILTER (WHERE e.usage_canonical) AS responses
         FROM events e
         JOIN scoped sc ON e.session_id = sc.id
         WHERE e.type = 'assistant'
         GROUP BY sc.connector_id
       ),
       sess AS (
         SELECT
           COALESCE(connector_id, 'unknown') AS connector_id,
           count(*) AS sessions,
           count(*) FILTER (WHERE has_sidechain) AS subagent_sessions
         FROM scoped
         GROUP BY COALESCE(connector_id, 'unknown')
       )
       SELECT
         s.connector_id, s.sessions, s.subagent_sessions,
         e.input_tokens, e.output_tokens, e.cache_read_tokens, e.cache_write_tokens,
         e.cost_usd, e.tool_calls, e.responses
       FROM sess s
       LEFT JOIN ev e ON e.connector_id = s.connector_id
       ORDER BY s.sessions DESC, s.connector_id`,
    );

    // Error/interrupt signals ride along in the same scorecard (same scope);
    // the aggregation lives with /api/analytics/errors and is shared with the
    // digest — see analytics-errors.ts for the availability semantics.
    const signals = new Map(
      (await errorSignalsByAgent(conn, req.query)).map((s) => [s.connectorId, s]),
    );

    const rows: AgentComparisonRow[] = rowsRaw.map((r) => {
      const rd = readRow(r, 'agent-comparison');
      const connectorId = rd.str('connector_id', 'unknown');
      const granularity = usageGranularity(connectorId);
      const sessions = rd.num('sessions');
      const responses = rd.num('responses');
      const toolCalls = rd.num('tool_calls');
      const input = rd.num('input_tokens');
      const output = rd.num('output_tokens');
      const cacheRead = rd.num('cache_read_tokens');
      const cacheWrite = rd.num('cache_write_tokens');
      const costUsd = rd.num('cost_usd');
      const totalTokens = input + output + cacheRead + cacheWrite;
      const subagentSessions = rd.num('subagent_sessions');

      const sig = signals.get(connectorId);
      const toolErrors = sig?.toolErrors ?? null;

      const hasTokens = granularity !== 'none';
      const perResponse = granularity === 'per-response';
      const availabilityNote = usageAvailabilityNote(connectorId);
      return {
        connectorId,
        usageGranularity: granularity,
        ...(availabilityNote ? { availabilityNote } : {}),
        sessions,
        responses,
        toolCalls,
        toolCallsPerResponse: responses > 0 ? toolCalls / responses : null,
        inputTokens: hasTokens ? input : null,
        outputTokens: hasTokens ? output : null,
        cacheReadTokens: hasTokens ? cacheRead : null,
        cacheCreationTokens: hasTokens ? cacheWrite : null,
        totalTokens: hasTokens ? totalTokens : null,
        costUsd: hasTokens ? costUsd : null,
        costPerSession: hasTokens && sessions > 0 ? costUsd / sessions : null,
        costPerResponse: perResponse && responses > 0 ? costUsd / responses : null,
        tokensPerResponse: perResponse && responses > 0 ? totalTokens / responses : null,
        cacheHitRatio: hasTokens ? cacheHitRatio(cacheRead, cacheWrite, input) : null,
        subagentSessions,
        subagentShare:
          hasSubagentLinkage(connectorId) && sessions > 0 ? subagentSessions / sessions : null,
        toolErrors,
        errorRate:
          toolErrors !== null && sig !== undefined && sig.toolCalls > 0
            ? toolErrors / sig.toolCalls
            : null,
        interrupts: hasInterruptSignal(connectorId) ? (sig?.interrupts ?? 0) : null,
      };
    });

    // Ride-along: PR-linked sessions in the same scope. sessions.total_cost_usd
    // is already usage_canonical-deduped at derivation time.
    const prRows = await queryRows(
      conn,
      `${scopedCte}
       SELECT count(*) AS pr_sessions, COALESCE(sum(total_cost_usd), 0) AS pr_cost
       FROM scoped
       WHERE pr_url IS NOT NULL AND pr_url != ''`,
    );
    const pr = readRow(prRows[0] ?? {}, 'agent-comparison-pr');
    const prSessions = pr.num('pr_sessions');
    const prCost = pr.num('pr_cost');
    const prLinked: PrLinkedStats = {
      sessions: prSessions,
      costUsd: prCost,
      costPerPrSession: prSessions > 0 ? prCost / prSessions : null,
    };

    return { rows, prLinked };
  });
}
