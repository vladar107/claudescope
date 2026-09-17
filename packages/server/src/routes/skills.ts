/**
 * Skills route — the installed-skills inventory, read live (NOT indexed) from
 * each agent's home dir and joined with the invocation figures the index
 * already carries (`events.skill_names`).
 *
 *   - GET /api/skills → a per-connector overview (counts + preview) for the
 *                       landing cards, including detected agents that keep no
 *                       skills store (`supported: false`), plus the full
 *                       per-agent listing.
 *
 * Collection, cross-agent dedupe and usage attribution live in `data/skills.ts`.
 * An empty store is a normal state, not an error.
 */

import type { FastifyInstance } from 'fastify';
import type { SkillsResponse } from '@claudescope/shared';
import { collectSkills } from '../data/skills.js';

export async function registerSkillsRoute(app: FastifyInstance): Promise<void> {
  app.get('/api/skills', async (): Promise<SkillsResponse> => collectSkills());
}
