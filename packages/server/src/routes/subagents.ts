/**
 * Subagents route — the custom subagent definitions, read live (NOT indexed)
 * from each agent's home dir and joined with the spawn figures the index
 * already carries (`events.subagent_names`).
 *
 *   - GET /api/subagents → a per-connector overview (counts + preview) for the
 *                          landing cards, including detected agents with no
 *                          definitions format (`supported: false`), plus the
 *                          full per-agent listing.
 *
 * Collection, cross-agent dedupe and usage attribution live in
 * `data/subagents.ts`. An agent with no definitions is a normal state, not an
 * error.
 */

import type { FastifyInstance } from 'fastify';
import type { SubagentsResponse } from '@claudescope/shared';
import { collectSubagents } from '../data/subagents.js';

export async function registerSubagentsRoute(app: FastifyInstance): Promise<void> {
  app.get('/api/subagents', async (): Promise<SubagentsResponse> => collectSubagents());
}
