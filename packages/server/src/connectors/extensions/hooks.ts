/**
 * Hook config parsers. Two shapes cover every agent that declares hooks:
 *   - Claude-shaped (Claude Code `settings.json`, plugin `hooks/hooks.json`,
 *     Codex `hooks.json` and `[[hooks.<Event>]]`, Junie `config.json`, Grok
 *     `hooks/*.json`): `{ <Event>: [{ matcher?, hooks: [{ type, command|url,
 *     timeout }] }] }`;
 *   - Copilot (`~/.copilot/hooks/*.json`): `{ version, hooks: { <event>:
 *     [{ type, bash|powershell|command, url, timeoutSec, matcher? }] } }`.
 * Only the event, matcher, type, redacted command/URL, and timeout are kept;
 * `env`/`headers` of a handler never leave.
 */

import type { ExtensionScope, SkillPlugin } from '@claudescope/shared';
import { num, rec, str } from '../json.js';
import type { HookEntry } from '../types.js';
import { readJsonFile } from './config-files.js';
import { redactCommandLine, sanitizeUrl } from './redact.js';

/** Where a batch of hooks is declared. */
export interface HookSource {
  scope: ExtensionScope;
  /** Absolute path of the declaring file. */
  sourcePath: string;
  plugin?: SkillPlugin;
}

function toHook(
  event: string,
  matcher: string,
  handler: Record<string, unknown>,
  commandField: string,
  timeoutSec: number,
  src: HookSource,
): HookEntry {
  const rawUrl = str(handler.url);
  return {
    event,
    ...(matcher ? { matcher } : {}),
    type: str(handler.type) || (commandField ? 'command' : rawUrl ? 'http' : 'unknown'),
    ...(commandField ? { command: redactCommandLine(commandField) } : {}),
    ...(rawUrl ? { url: sanitizeUrl(rawUrl) ?? '•••' } : {}),
    ...(timeoutSec > 0 ? { timeoutSec } : {}),
    scope: src.scope,
    ...(src.plugin ? { plugin: src.plugin } : {}),
    sourcePath: src.sourcePath,
  };
}

/**
 * Claude-shaped `{ <Event>: [matcher groups] }`. A non-array value under an
 * event key is not a hook list and is skipped — Codex keeps its trust records
 * in `[hooks.state]` beside the real `[[hooks.<Event>]]` arrays.
 */
export function claudeStyleHooks(eventsMap: unknown, src: HookSource): HookEntry[] {
  const out: HookEntry[] = [];
  for (const [event, groups] of Object.entries(rec(eventsMap))) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      const group = rec(g);
      const matcher = str(group.matcher);
      const handlers = Array.isArray(group.hooks) ? group.hooks : [];
      for (const h of handlers) {
        const handler = rec(h);
        // A `prompt` handler's text is shown as its "command": it is config,
        // not a credential slot, but it still goes through redaction.
        const command = str(handler.command) || str(handler.prompt);
        out.push(toHook(event, matcher, handler, command, num(handler.timeout), src));
      }
    }
  }
  return out;
}

/** Copilot's `{ version, hooks: { <event>: [handlers] } }`. */
export function copilotHooks(file: unknown, src: HookSource): HookEntry[] {
  const out: HookEntry[] = [];
  for (const [event, handlers] of Object.entries(rec(rec(file).hooks))) {
    if (!Array.isArray(handlers)) continue;
    for (const h of handlers) {
      const handler = rec(h);
      const command = str(handler.bash) || str(handler.command) || str(handler.powershell) || str(handler.exec);
      out.push(toHook(event, str(handler.matcher), handler, command, num(handler.timeoutSec), src));
    }
  }
  return out;
}

/**
 * The hooks of a Claude-shaped JSON file: `{ hooks: {…} }` (settings files,
 * plugin `hooks.json`) or the bare events map. `[]` when absent or malformed.
 */
export function readClaudeStyleHooksFile(path: string, src: Omit<HookSource, 'sourcePath'>): HookEntry[] {
  const parsed = rec(readJsonFile(path));
  const map = 'hooks' in parsed ? parsed.hooks : parsed;
  return claudeStyleHooks(map, { ...src, sourcePath: path });
}
