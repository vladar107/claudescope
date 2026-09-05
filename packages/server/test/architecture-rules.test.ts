/**
 * Fitness function for the connector boundary.
 *
 * CLAUDE.md's promise is that everything below the connector boundary is
 * agent-agnostic: `data/` and `routes/` operate on the canonical event contract,
 * and the ONE place allowed to record a per-agent fact is
 * `data/agent-capabilities.ts` (properties of the CONNECTOR, not of the data).
 *
 * The way that erodes is invisible in any feature test: a `connector_id =
 * 'codex'` branch in indexer SQL, a `=== 'claude-code'` ternary in a route, a
 * note map keyed by agent id, an import reaching into one connector's internals.
 * Each is small and correct on its own, and together they mean adding an agent
 * touches the shared layer again. So this test scans the two agent-agnostic
 * directories for any registered connector id spelled as a string literal, and
 * for imports from a specific connector's directory.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// The registry import resolves each connector's source dir; keep any state it
// might touch inside a temp home, never the real one.
const work = mkdtempSync(join(tmpdir(), 'claudescope-archrules-'));
process.env.CLAUDESCOPE_HOME = join(work, 'home');
process.on('exit', () => rmSync(work, { recursive: true, force: true }));

const { connectors } = await import('../src/connectors/registry.js');

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
/** The layers that must not know any agent by name. */
const AGENT_AGNOSTIC_DIRS = [join(serverRoot, 'src', 'data'), join(serverRoot, 'src', 'routes')];
/** The single sanctioned home for per-agent facts. */
const CAPABILITIES_FILE = join(serverRoot, 'src', 'data', 'agent-capabilities.ts');

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFilesUnder(path));
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out;
}

const ids = connectors.map((c) => c.id);
const idAlternation = ids.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
/** A connector id spelled as a string literal: `'codex'`, `"claude-code"`, backticks. */
const ID_LITERAL = new RegExp(`(['"\`])(?:${idAlternation})\\1`);
/** An import (or any path) reaching into one connector's directory. */
const CONNECTOR_IMPORT = new RegExp(`connectors/(?:${idAlternation})/`);

function violations(): string[] {
  const found: string[] = [];
  for (const dir of AGENT_AGNOSTIC_DIRS) {
    for (const file of tsFilesUnder(dir)) {
      if (file === CAPABILITIES_FILE) continue;
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (ID_LITERAL.test(line) || CONNECTOR_IMPORT.test(line)) {
          found.push(`${relative(serverRoot, file)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
  }
  return found;
}

describe('connector boundary', () => {
  it('has connectors to check', () => {
    expect(ids.length).toBeGreaterThan(1);
  });

  it('names no agent in data/ or routes/', () => {
    // Reported as `file:line: text` so a failure points straight at the leak;
    // the fix is an accessor in data/agent-capabilities.ts (a fact about the
    // connector) or a hook on the `AgentConnector` port (behaviour it owns).
    expect(violations()).toEqual([]);
  });
});
